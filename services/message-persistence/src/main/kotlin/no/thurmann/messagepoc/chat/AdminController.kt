package no.thurmann.messagepoc.chat

import no.thurmann.messagepoc.auth.BanInfo
import no.thurmann.messagepoc.auth.HandleRules
import no.thurmann.messagepoc.moderation.ManualBanResult
import no.thurmann.messagepoc.moderation.ModerationService
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import java.time.Instant

@RestController
@RequestMapping("/api/admin")
class AdminController(
    private val chatQueryService: ChatQueryService,
    private val broadcaster: SseBroadcaster,
    private val moderationService: ModerationService,
) {
    @GetMapping("/moderation-log")
    fun moderationLog(@RequestParam(defaultValue = "200") limit: Int): List<AdminModerationRow> =
        chatQueryService.moderationLog(limit.coerceIn(1, 500))

    @GetMapping("/stream")
    fun stream(): ResponseEntity<SseEmitter> = broadcaster.subscribeAdmin()

    @PostMapping("/users/ban")
    fun banUser(@AuthenticationPrincipal jwt: Jwt, @RequestBody request: BanUserRequest): ResponseEntity<Map<String, Any>> {
        val handle = request.handle?.trim().orEmpty()
        if (!HandleRules.isValid(handle)) {
            return ResponseEntity.badRequest().body(mapOf("error" to "INVALID_HANDLE"))
        }
        val adminEmail = jwt.getClaimAsString("email")?.trim()?.lowercase().orEmpty()
        return when (val result = moderationService.manualBan(handle, adminEmail)) {
            is ManualBanResult.Banned -> ResponseEntity.ok(
                mapOf(
                    "handle" to result.handle,
                    "step" to result.step,
                    "until" to result.until,
                    "remainingSeconds" to BanInfo.of(result.until, Instant.now()).remainingSeconds,
                ),
            )
            ManualBanResult.UnknownHandle -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(mapOf("error" to "UNKNOWN_HANDLE"))
            ManualBanResult.CannotBanAdmin -> ResponseEntity.status(HttpStatus.CONFLICT).body(mapOf("error" to "CANNOT_BAN_ADMIN"))
            is ManualBanResult.AlreadyBanned -> ResponseEntity.status(HttpStatus.CONFLICT)
                .body(mapOf("error" to "ALREADY_BANNED", "until" to result.until))
        }
    }
}

data class BanUserRequest(val handle: String? = null)
