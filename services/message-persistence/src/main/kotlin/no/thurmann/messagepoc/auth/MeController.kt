package no.thurmann.messagepoc.auth

import no.thurmann.messagepoc.audit.AppUserRepository
import no.thurmann.messagepoc.moderation.ModerationPolicy
import no.thurmann.messagepoc.moderation.ModerationProperties
import no.thurmann.messagepoc.moderation.ModerationService
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Duration
import java.time.Instant

@RestController
@RequestMapping("/api/me")
class MeController(
    private val jdbcTemplate: JdbcTemplate,
    private val appUserRepository: AppUserRepository,
    private val adminDirectory: AdminDirectory,
    private val moderationService: ModerationService,
    private val moderationPolicy: ModerationPolicy,
    private val properties: ModerationProperties,
) {
    @GetMapping
    fun me(@AuthenticationPrincipal jwt: Jwt): MeResponse {
        val user = upsertUser(jwt)
        val strikes = moderationService.currentStrikes(user.googleSub)
        val now = Instant.now()
        val ban = moderationService.activeBan(user.googleSub, now)?.let {
            BanInfo(until = it.endsAt, remainingSeconds = Duration.between(now, it.endsAt).seconds.coerceAtLeast(0))
        }
        return MeResponse(
            email = user.email,
            handle = user.handle,
            isAdmin = adminDirectory.isAdmin(jwt),
            strikes = strikes,
            warningThreshold = properties.warningThreshold,
            banThreshold = properties.banThreshold,
            warning = moderationPolicy.isWarning(strikes),
            ban = ban,
        )
    }

    @PutMapping("/handle")
    fun setHandle(@AuthenticationPrincipal jwt: Jwt, @RequestBody request: HandleRequest): ResponseEntity<Map<String, String>> {
        val handle = request.handle?.trim().orEmpty()
        if (!HandleRules.isValid(handle)) {
            return ResponseEntity.badRequest().body(mapOf("error" to "INVALID_HANDLE"))
        }
        val user = upsertUser(jwt)
        val updated = try {
            jdbcTemplate.update("UPDATE app_user SET handle = ? WHERE google_sub = ? AND handle IS NULL", handle, user.googleSub)
        } catch (_: DataIntegrityViolationException) {
            0
        }
        if (updated == 0) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(mapOf("error" to "HANDLE_UNAVAILABLE"))
        }
        return ResponseEntity.ok(mapOf("handle" to handle))
    }

    private fun upsertUser(jwt: Jwt) =
        jdbcTemplate.update(
            """
            INSERT INTO app_user (google_sub, email, created_at, last_login_at) VALUES (?, ?, now(), now())
            ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, last_login_at = now()
            """.trimIndent(),
            jwt.subject!!,
            jwt.getClaimAsString("email") ?: "",
        ).let { appUserRepository.findById(jwt.subject!!).orElseThrow() }
}

data class HandleRequest(val handle: String? = null)

data class BanInfo(val until: Instant, val remainingSeconds: Long)

data class MeResponse(
    val email: String,
    val handle: String?,
    val isAdmin: Boolean,
    val strikes: Int,
    val warningThreshold: Int,
    val banThreshold: Int,
    val warning: Boolean,
    val ban: BanInfo?,
)
