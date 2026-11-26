package no.thurmann.messagepoc.moderation

import no.thurmann.messagepoc.persistence.AppUserRepository
import no.thurmann.messagepoc.persistence.MessageResult
import no.thurmann.messagepoc.persistence.MessageResultRepository
import no.thurmann.messagepoc.persistence.UserBan
import no.thurmann.messagepoc.persistence.UserBanRepository
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.core.RowCallbackHandler
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.time.temporal.ChronoUnit

@Service
class ModerationService(
    private val messageResultRepository: MessageResultRepository,
    private val appUserRepository: AppUserRepository,
    private val userBanRepository: UserBanRepository,
    private val policy: ModerationPolicy,
    private val jdbcTemplate: JdbcTemplate,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Transactional
    fun record(result: MessageResult) {
        val authorId = result.authorId
        val knownAuthor = authorId != null && lockUser(authorId)
        // Serialise results for the same message (a redelivered event has the same messageId), then skip duplicates
        // only after the user lock is held. The first result stored for a messageId wins: a redelivered event or a
        // retry of the same message under a new eventId is never counted twice and never overwrites an existing row.
        jdbcTemplate.query("SELECT pg_advisory_xact_lock(hashtext(?))", RowCallbackHandler { }, result.messageId.toString())
        if (messageResultRepository.existsById(result.eventId)) return
        val existing = messageResultRepository.findAllByMessageId(result.messageId).firstOrNull()
        if (existing != null) {
            if (existing.authorId != result.authorId) {
                logger.warn(
                    "Duplicate messageId from a different author ignored messageId={} eventId={} existingAuthorId={} newAuthorId={}",
                    result.messageId, result.eventId, existing.authorId, result.authorId,
                )
            } else {
                logger.info(
                    "Duplicate message ignored messageId={} eventId={} correlationId={}",
                    result.messageId, result.eventId, result.correlationId,
                )
            }
            return
        }

        if (authorId != null && knownAuthor) {
            val strike = policy.countsAsStrike(result.status, result.profanityScore)
            val previousBan = userBanRepository.findFirstByUserIdOrderByEndsAtDesc(authorId)?.toPreviousBan()
            result.strike = strike
            result.strikesAfter = currentStrikes(authorId, previousBan) + if (strike) 1 else 0
            messageResultRepository.save(result)

            if (strike) {
                val decision = policy.decideBan(result.strikesAfter ?: 0, Instant.now(), previousBan, isAdmin(authorId))
                if (decision != null) {
                    userBanRepository.save(
                        UserBan(
                            userId = authorId,
                            step = decision.step,
                            startsAt = decision.startsAt,
                            endsAt = decision.endsAt,
                            strikesAtBan = result.strikesAfter,
                            triggerMessageId = result.messageId,
                            createdAt = decision.startsAt,
                        ),
                    )
                }
            }
        } else {
            if (authorId != null) logger.warn("Author {} of message {} is not a known user; skipping strike logic", authorId, result.messageId)
            messageResultRepository.save(result)
        }

        jdbcTemplate.query("SELECT pg_notify('chat_events', ?)", RowCallbackHandler { }, result.messageId.toString())
    }

    @Transactional(readOnly = true)
    fun currentStrikes(userId: String): Int =
        currentStrikes(userId, userBanRepository.findFirstByUserIdOrderByEndsAtDesc(userId)?.toPreviousBan())

    @Transactional(readOnly = true)
    fun activeBan(userId: String, now: Instant = Instant.now()): UserBan? =
        userBanRepository.findFirstByUserIdAndEndsAtAfterOrderByEndsAtDesc(userId, now)

    /** Bans the user with [handle] on behalf of an admin, escalating along the same ladder as automatic bans. */
    @Transactional
    fun manualBan(handle: String, adminEmail: String, now: Instant = Instant.now()): ManualBanResult {
        val target = jdbcTemplate.query(
            "SELECT google_sub, handle FROM app_user WHERE lower(handle) = lower(?) FOR UPDATE",
            { rs, _ -> rs.getString(1) to rs.getString(2) },
            handle,
        ).firstOrNull() ?: return ManualBanResult.UnknownHandle
        val (userId, storedHandle) = target
        if (isAdmin(userId)) return ManualBanResult.CannotBanAdmin

        val previousBan = userBanRepository.findFirstByUserIdOrderByEndsAtDesc(userId)
        // Postgres stores microseconds; truncate so the returned end time equals the stored one (Linux clocks have nanoseconds)
        val decision = policy.decideManualBan(now.truncatedTo(ChronoUnit.MICROS), previousBan?.toPreviousBan())
            ?: return ManualBanResult.AlreadyBanned(previousBan!!.endsAt)
        userBanRepository.save(
            UserBan(
                userId = userId,
                step = decision.step,
                startsAt = decision.startsAt,
                endsAt = decision.endsAt,
                strikesAtBan = null,
                triggerMessageId = null,
                createdAt = decision.startsAt,
                bannedBy = adminEmail,
            ),
        )
        return ManualBanResult.Banned(storedHandle, decision.step, decision.endsAt)
    }

    private fun currentStrikes(userId: String, previousBan: PreviousBan?): Int {
        val since = policy.strikeWindowStart(previousBan)
        return if (since == null) {
            messageResultRepository.countByAuthorIdAndStrikeTrue(userId)
        } else {
            messageResultRepository.countByAuthorIdAndStrikeTrueAndOccurredAtGreaterThanEqual(userId, since)
        }
    }

    private fun lockUser(userId: String): Boolean =
        jdbcTemplate.queryForList("SELECT google_sub FROM app_user WHERE google_sub = ? FOR UPDATE", String::class.java, userId).isNotEmpty()

    private fun isAdmin(userId: String): Boolean =
        jdbcTemplate.queryForObject(
            "SELECT EXISTS (SELECT 1 FROM app_user u JOIN admin_user a ON lower(a.email) = lower(u.email) WHERE u.google_sub = ?)",
            Boolean::class.java,
            userId,
        ) == true

    private fun UserBan.toPreviousBan() = PreviousBan(step = step, endsAt = endsAt)
}
