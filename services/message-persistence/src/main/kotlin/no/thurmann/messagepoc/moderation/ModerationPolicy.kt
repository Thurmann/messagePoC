package no.thurmann.messagepoc.moderation

import no.thurmann.messagepoc.persistence.MessageResultStatus
import org.springframework.stereotype.Component
import java.time.Duration
import java.time.Instant

data class PreviousBan(
    val step: Int,
    val endsAt: Instant,
)

data class BanDecision(
    val step: Int,
    val startsAt: Instant,
    val endsAt: Instant,
)

@Component
class ModerationPolicy(
    private val properties: ModerationProperties,
) {
    fun isWarning(strikes: Int, isAdmin: Boolean = false): Boolean =
        strikes >= properties.warningThreshold && (isAdmin || strikes < properties.banThreshold)

    fun decideBan(strikes: Int, now: Instant, previousBan: PreviousBan?, isAdmin: Boolean = false): BanDecision? {
        if (isAdmin) return null
        if (strikes < properties.banThreshold) return null
        if (previousBan != null && now.isBefore(previousBan.endsAt)) return null

        val step = nextStep(now, previousBan)
        val duration = properties.banLadder[minOf(step, properties.banLadder.size - 1)]
        return BanDecision(step = step, startsAt = now, endsAt = now.plus(duration))
    }

    /** A ban set by an admin: same ladder and escalation as automatic bans, but without a strike threshold. */
    fun decideManualBan(now: Instant, previousBan: PreviousBan?): BanDecision? {
        if (previousBan != null && now.isBefore(previousBan.endsAt)) return null

        val step = nextStep(now, previousBan)
        val duration = properties.banLadder[minOf(step, properties.banLadder.size - 1)]
        return BanDecision(step = step, startsAt = now, endsAt = now.plus(duration))
    }

    private fun nextStep(now: Instant, previousBan: PreviousBan?): Int =
        if (previousBan != null && Duration.between(previousBan.endsAt, now) <= properties.escalationWindow) {
            previousBan.step + 1
        } else {
            0
        }

    fun strikeWindowStart(previousBan: PreviousBan?): Instant? = previousBan?.endsAt

    fun countsAsStrike(status: MessageResultStatus, profanityScore: Double?): Boolean =
        when (status) {
            MessageResultStatus.REJECTED -> true
            MessageResultStatus.DLT -> profanityScore != null || properties.technicalDltCountsAsStrike
            MessageResultStatus.VALIDATED -> false
        }
}
