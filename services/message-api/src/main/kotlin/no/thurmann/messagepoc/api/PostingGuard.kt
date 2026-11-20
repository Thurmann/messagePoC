package no.thurmann.messagepoc.api

import java.time.Duration
import java.time.Instant

data class UserStatus(
    val handle: String?,
    val banEndsAt: Instant?,
    val isAdmin: Boolean = false,
)

sealed interface PostingDecision {
    data class Allowed(val handle: String) : PostingDecision
    data object HandleRequired : PostingDecision
    data class Banned(val until: Instant, val remainingSeconds: Long) : PostingDecision
}

object PostingGuard {
    fun evaluate(status: UserStatus?, now: Instant): PostingDecision {
        val handle = status?.handle ?: return PostingDecision.HandleRequired
        if (status.isAdmin) return PostingDecision.Allowed(handle)
        val banEndsAt = status.banEndsAt
        if (banEndsAt != null && banEndsAt.isAfter(now)) {
            val millis = Duration.between(now, banEndsAt).toMillis()
            return PostingDecision.Banned(banEndsAt, (millis + 999) / 1000)
        }
        return PostingDecision.Allowed(handle)
    }
}
