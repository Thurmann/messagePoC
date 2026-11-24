package no.thurmann.messagepoc.auth

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties(prefix = "presence")
data class PresenceProperties(
    val onlineWindow: Duration = Duration.ofSeconds(90),
) {
    init {
        require(!onlineWindow.isNegative && !onlineWindow.isZero) { "presence.online-window must be positive" }
    }
}
