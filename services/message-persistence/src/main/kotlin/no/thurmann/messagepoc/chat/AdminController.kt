package no.thurmann.messagepoc.chat

import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter

@RestController
@RequestMapping("/api/admin")
class AdminController(
    private val chatQueryService: ChatQueryService,
    private val broadcaster: SseBroadcaster,
) {
    @GetMapping("/moderation-log")
    fun moderationLog(@RequestParam(defaultValue = "200") limit: Int): List<AdminModerationRow> =
        chatQueryService.moderationLog(limit.coerceIn(1, 500))

    @GetMapping("/stream")
    fun stream(): ResponseEntity<SseEmitter> = broadcaster.subscribeAdmin()
}
