package no.thurmann.messagepoc.moderation

import no.thurmann.messagepoc.audit.MessageResultStatus
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

        val step = if (previousBan != null && Duration.between(previousBan.endsAt, now) <= properties.escalationWindow) {
            previousBan.step + 1
        } else {
            0
        }
        val duration = properties.banLadder[minOf(step, properties.banLadder.size - 1)]
        return BanDecision(step = step, startsAt = now, endsAt = now.plus(duration))
    }

    fun strikeWindowStart(previousBan: PreviousBan?): Instant? = previousBan?.endsAt

    fun countsAsStrike(status: MessageResultStatus, profanityScore: Double?): Boolean =
        when (status) {
            MessageResultStatus.REJECTED -> true
            MessageResultStatus.DLT -> profanityScore != null || properties.technicalDltCountsAsStrike
            MessageResultStatus.VALIDATED -> false
        }
}
