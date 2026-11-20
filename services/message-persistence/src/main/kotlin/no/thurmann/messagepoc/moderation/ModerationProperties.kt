package no.thurmann.messagepoc.moderation

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties(prefix = "moderation")
data class ModerationProperties(
    val warningThreshold: Int = 3,
    val banThreshold: Int = 6,
    val banLadder: List<Duration> = listOf(
        Duration.ofMinutes(1),
        Duration.ofMinutes(5),
        Duration.ofMinutes(30),
        Duration.ofHours(2),
        Duration.ofHours(12),
        Duration.ofHours(24),
    ),
    val escalationWindow: Duration = Duration.ofDays(1),
    val technicalDltCountsAsStrike: Boolean = false,
) {
    init {
        require(banLadder.isNotEmpty()) { "moderation.ban-ladder must not be empty" }
        require(warningThreshold < banThreshold) { "moderation.warning-threshold must be below ban-threshold" }
    }
}
