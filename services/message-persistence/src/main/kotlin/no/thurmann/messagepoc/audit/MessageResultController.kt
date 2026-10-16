package no.thurmann.messagepoc.audit

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant
import java.util.UUID

@RestController
@RequestMapping("/api/messages")
class MessageResultController(
    private val messageResultRepository: MessageResultRepository,
) {
    @GetMapping
    fun list(): List<MessageResultResponse> =
        messageResultRepository.findAllByOrderByOccurredAtDesc().map(MessageResultResponse::from)
}

data class MessageResultResponse(
    val eventId: UUID,
    val messageId: UUID,
    val occurredAt: Instant,
    val status: MessageResultStatus,
    val text: String,
    val reason: String?,
) {
    companion object {
        fun from(result: MessageResult) =
            MessageResultResponse(
                eventId = result.eventId,
                messageId = result.messageId,
                occurredAt = result.occurredAt,
                status = result.status,
                text = result.text,
                reason = result.reason,
            )
    }
}
