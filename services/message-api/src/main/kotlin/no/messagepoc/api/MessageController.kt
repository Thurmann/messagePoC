package no.messagepoc.api

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import no.messagepoc.contracts.KafkaTopics
import no.messagepoc.contracts.MessageSubmittedEvent
import no.messagepoc.contracts.MessageSubmittedPayload
import org.springframework.http.ResponseEntity
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

@RestController
@RequestMapping("/api/messages")
class MessageController(
    private val kafkaTemplate: KafkaTemplate<String, Any>,
) {
    @PostMapping
    fun submit(
        @Valid @RequestBody request: SubmitMessageRequest,
        @RequestHeader("X-Correlation-Id", required = false) correlationIdHeader: String?,
    ): ResponseEntity<SubmitMessageResponse> {
        val messageId = UUID.randomUUID()
        val correlationId = correlationIdHeader.toUuidOrNull() ?: UUID.randomUUID()
        val event = MessageSubmittedEvent(
            eventId = UUID.randomUUID(),
            occurredAt = Instant.now(),
            messageId = messageId,
            correlationId = correlationId,
            producer = "message-api",
            payload = MessageSubmittedPayload(request.text.trim()),
        )

        kafkaTemplate
            .send(KafkaTopics.MESSAGE_SUBMITTED, messageId.toString(), event)
            .get(5, TimeUnit.SECONDS)

        return ResponseEntity.accepted().body(
            SubmitMessageResponse(
                messageId = messageId,
                correlationId = correlationId,
                status = SubmissionStatus.PENDING,
            ),
        )
    }
}

data class SubmitMessageRequest(
    @field:NotBlank
    val text: String,
)

data class SubmitMessageResponse(
    val messageId: UUID,
    val correlationId: UUID,
    val status: SubmissionStatus,
)

enum class SubmissionStatus {
    PENDING,
}

private fun String?.toUuidOrNull(): UUID? =
    try {
        this?.let(UUID::fromString)
    } catch (_: IllegalArgumentException) {
        null
    }
