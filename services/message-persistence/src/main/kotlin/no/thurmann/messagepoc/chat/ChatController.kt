package no.thurmann.messagepoc.chat

import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter

@RestController
@RequestMapping("/api/chat")
class ChatController(
    private val chatQueryService: ChatQueryService,
    private val broadcaster: SseBroadcaster,
) {
    @GetMapping("/history")
    fun history(@RequestParam(defaultValue = "100") limit: Int): List<PublicChatEvent> =
        chatQueryService.history(limit.coerceIn(1, 200))

    @GetMapping("/stream")
    fun stream(): ResponseEntity<SseEmitter> = broadcaster.subscribePublic()
}
