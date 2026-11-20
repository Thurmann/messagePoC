package no.thurmann.messagepoc.moderation

import no.thurmann.messagepoc.audit.AppUserRepository
import no.thurmann.messagepoc.audit.MessageResult
import no.thurmann.messagepoc.audit.MessageResultRepository
import no.thurmann.messagepoc.audit.UserBan
import no.thurmann.messagepoc.audit.UserBanRepository
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.core.RowCallbackHandler
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

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
        // Serialise redeliveries of the same event, then skip duplicates only after the user lock is held,
        // so a redelivered event is never counted twice and never overwrites an existing row.
        jdbcTemplate.query("SELECT pg_advisory_xact_lock(hashtext(?))", RowCallbackHandler { }, result.eventId.toString())
        if (messageResultRepository.existsById(result.eventId)) return

        if (authorId != null && knownAuthor) {
            val strike = policy.countsAsStrike(result.status, result.profanityScore)
            val previousBan = userBanRepository.findFirstByUserIdOrderByEndsAtDesc(authorId)?.toPreviousBan()
            result.strike = strike
            result.strikesAfter = strikesAfter(currentStrikes(authorId, previousBan), strike)
            messageResultRepository.save(result)

            if (strike) {
                val decision = policy.decideBan(result.strikesAfter ?: 0, Instant.now(), previousBan)
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

    private fun UserBan.toPreviousBan() = PreviousBan(step = step, endsAt = endsAt)

    companion object {
        fun strikesAfter(existingStrikes: Int, strike: Boolean): Int = existingStrikes + if (strike) 1 else 0
    }
}
