package no.thurmann.messagepoc.api

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import no.thurmann.messagepoc.contracts.KafkaTopics
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageSubmittedPayload
import org.slf4j.LoggerFactory
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
    private val logger = LoggerFactory.getLogger(javaClass)

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

        val sendResult = kafkaTemplate
            .send(KafkaTopics.MESSAGE_SUBMITTED, messageId.toString(), event)
            .get(5, TimeUnit.SECONDS)

        logger.atInfo()
            .addKeyValue("eventId", event.eventId)
            .addKeyValue("eventType", event.eventType)
            .addKeyValue("messageId", event.messageId)
            .addKeyValue("correlationId", event.correlationId)
            .addKeyValue("profanityScore", event.profanityScore)
            .addKeyValue("topic", sendResult.recordMetadata.topic())
            .addKeyValue("partition", sendResult.recordMetadata.partition())
            .addKeyValue("offset", sendResult.recordMetadata.offset())
            .log("Message submitted")

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
