package no.thurmann.messagepoc.auth

import no.thurmann.messagepoc.moderation.ModerationService
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant

@RestController
@RequestMapping("/api/me/presence")
class PresenceController(
    private val jdbcTemplate: JdbcTemplate,
    private val adminDirectory: AdminDirectory,
    private val moderationService: ModerationService,
) {
    /** Heartbeat: marks the caller as online and returns the active ban, so clients learn about bans without polling /api/me. */
    @PostMapping
    fun heartbeat(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<Any> {
        val updated = jdbcTemplate.update("UPDATE app_user SET last_seen_at = now() WHERE google_sub = ?", jwt.subject!!)
        if (updated == 0) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "UNKNOWN_USER"))
        }
        val now = Instant.now()
        val ban = if (adminDirectory.isAdmin(jwt)) null else moderationService.activeBan(jwt.subject!!, now)?.let { BanInfo.of(it.endsAt, now) }
        return ResponseEntity.ok(PresenceResponse(ban))
    }

    @DeleteMapping
    fun leave(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<Void> {
        jdbcTemplate.update("UPDATE app_user SET last_seen_at = NULL WHERE google_sub = ?", jwt.subject!!)
        return ResponseEntity.noContent().build()
    }
}

data class PresenceResponse(val ban: BanInfo?)
