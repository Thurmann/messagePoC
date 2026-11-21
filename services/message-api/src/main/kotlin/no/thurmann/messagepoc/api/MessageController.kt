package no.thurmann.messagepoc.api

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import no.thurmann.messagepoc.contracts.KafkaTopics
import no.thurmann.messagepoc.contracts.MessageAuthor
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageSubmittedPayload
import org.apache.kafka.common.errors.RetriableException
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.dao.DataAccessException
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

@RestController
@RequestMapping("/api/messages")
class MessageController(
    private val kafkaTemplate: KafkaTemplate<String, Any>,
    private val userStatusLookup: UserStatusLookup,
    @Value("\${message-api.kafka-send-timeout:5s}") private val sendTimeout: Duration,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @PostMapping
    fun submit(
        @Valid @RequestBody request: SubmitMessageRequest,
        @RequestHeader("X-Correlation-Id", required = false) correlationIdHeader: String?,
        @AuthenticationPrincipal jwt: Jwt,
    ): ResponseEntity<*> {
        val now = Instant.now()
        val subject = jwt.subject ?: return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build<Nothing>()
        val clientMessageId = request.messageId?.takeIf { it.isNotBlank() }
        val messageId = if (clientMessageId == null) {
            UUID.randomUUID()
        } else {
            clientMessageId.toUuidOrNull()
                ?: return ResponseEntity.badRequest().body(mapOf("error" to "INVALID_MESSAGE_ID"))
        }
        val status = try {
            userStatusLookup.find(subject, now)
        } catch (e: DataAccessException) {
            logger.atError()
                .setCause(e)
                .addKeyValue("authorId", subject)
                .log("User status lookup failed")
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(mapOf("error" to "UNAVAILABLE"))
        }

        val handle = when (val decision = PostingGuard.evaluate(status, now)) {
            is PostingDecision.Allowed -> decision.handle
            PostingDecision.HandleRequired ->
                return ResponseEntity.status(HttpStatus.CONFLICT).body(mapOf("error" to "HANDLE_REQUIRED"))
            is PostingDecision.Banned ->
                return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .header(HttpHeaders.RETRY_AFTER, decision.remainingSeconds.toString())
                    .body(
                        mapOf(
                            "error" to "BANNED",
                            "bannedUntil" to decision.until,
                            "remainingSeconds" to decision.remainingSeconds,
                        ),
                    )
        }

        val correlationId = correlationIdHeader.toUuidOrNull() ?: UUID.randomUUID()
        val event = MessageSubmittedEvent(
            eventId = UUID.randomUUID(),
            occurredAt = now,
            messageId = messageId,
            correlationId = correlationId,
            producer = "message-api",
            payload = MessageSubmittedPayload(request.text.trim()),
            author = MessageAuthor(userId = subject, handle = handle),
        )

        val sendResult = try {
            kafkaTemplate
                .send(KafkaTopics.MESSAGE_SUBMITTED, messageId.toString(), event)
                .get(sendTimeout.toMillis(), TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return unconfirmed(messageId, correlationId, e)
        } catch (e: java.util.concurrent.TimeoutException) {
            return unconfirmed(messageId, correlationId, e)
        } catch (e: Exception) {
            if (e.hasUnknownOutcomeCause()) {
                return unconfirmed(messageId, correlationId, e)
            }
            throw e
        }

        logger.atInfo()
            .addKeyValue("eventId", event.eventId)
            .addKeyValue("eventType", event.eventType)
            .addKeyValue("messageId", event.messageId)
            .addKeyValue("correlationId", event.correlationId)
            .addKeyValue("authorHandle", handle)
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

    /** The producer may still deliver the record in the background, so the outcome is unknown, not failed. */
    private fun unconfirmed(messageId: UUID, correlationId: UUID, e: Exception): ResponseEntity<*> {
        logger.atWarn()
            .addKeyValue("messageId", messageId)
            .addKeyValue("correlationId", correlationId)
            .addKeyValue("exception", e.javaClass.name)
            .log("Kafka send outcome unconfirmed")
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
            .header(HttpHeaders.RETRY_AFTER, "5")
            .body(SubmitMessageUnconfirmed(messageId = messageId, correlationId = correlationId))
    }
}

private fun Throwable.hasUnknownOutcomeCause(): Boolean =
    generateSequence(this) { it.cause?.takeIf { c -> c !== it } }
        .take(20)
        .any { it is RetriableException || it is org.apache.kafka.common.errors.TimeoutException }

data class SubmitMessageUnconfirmed(
    val messageId: UUID,
    val correlationId: UUID,
    val status: SubmissionStatus = SubmissionStatus.UNCONFIRMED,
)

data class SubmitMessageRequest(
    @field:NotBlank
    @field:Size(max = 500)
    val text: String,
    val messageId: String? = null,
)

data class SubmitMessageResponse(
    val messageId: UUID,
    val correlationId: UUID,
    val status: SubmissionStatus,
)

enum class SubmissionStatus {
    PENDING,
    UNCONFIRMED,
}

private fun String?.toUuidOrNull(): UUID? =
    try {
        this?.let(UUID::fromString)
    } catch (_: IllegalArgumentException) {
        null
    }
