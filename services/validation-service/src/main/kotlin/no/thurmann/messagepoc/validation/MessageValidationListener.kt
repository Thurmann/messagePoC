package no.thurmann.messagepoc.validation

import no.thurmann.messagepoc.contracts.KafkaTopics
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageRejectedPayload
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedPayload
import org.slf4j.LoggerFactory
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.kafka.support.KafkaHeaders
import org.springframework.messaging.handler.annotation.Header
import org.springframework.stereotype.Component
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

@Component
class MessageValidationListener(
    private val kafkaTemplate: KafkaTemplate<String, Any>,
    private val validationRule: ValidationRule,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @KafkaListener(topics = [KafkaTopics.MESSAGE_SUBMITTED])
    fun validate(
        event: MessageSubmittedEvent,
        @Header(KafkaHeaders.RECEIVED_TOPIC) sourceTopic: String,
        @Header(KafkaHeaders.RECEIVED_PARTITION) sourcePartition: Int,
        @Header(KafkaHeaders.OFFSET) sourceOffset: Long,
    ) {
        if (event.payload.text == DLT_TEST_MESSAGE) {
            throw IllegalStateException("Forced failure for dead-letter queue demonstration")
        }

        val profanityScore = validationRule.score(event.payload.text)
        val decision = validationRule.decide(profanityScore)

        if (decision == ValidationDecision.DLT) {
            val sendResult = kafkaTemplate
                .send(KafkaTopics.MESSAGE_SUBMITTED_DLT, event.messageId.toString(), event.copy(profanityScore = profanityScore))
                .get(5, TimeUnit.SECONDS)

            logger.atWarn()
                .addKeyValue("eventId", event.eventId)
                .addKeyValue("eventType", event.eventType)
                .addKeyValue("messageId", event.messageId)
                .addKeyValue("correlationId", event.correlationId)
                .addKeyValue("profanityScore", profanityScore)
                .addKeyValue("sourceTopic", sourceTopic)
                .addKeyValue("sourcePartition", sourcePartition)
                .addKeyValue("sourceOffset", sourceOffset)
                .addKeyValue("targetTopic", sendResult.recordMetadata.topic())
                .addKeyValue("targetPartition", sendResult.recordMetadata.partition())
                .addKeyValue("targetOffset", sendResult.recordMetadata.offset())
                .log("Message sent to dead-letter topic after profanity scoring")
            return
        }

        val result = if (decision == ValidationDecision.ACCEPT) {
            MessageValidatedEvent(
                eventId = UUID.randomUUID(),
                occurredAt = Instant.now(),
                messageId = event.messageId,
                correlationId = event.correlationId,
                causationId = event.eventId,
                producer = "validation-service",
                payload = MessageValidatedPayload(event.payload.text),
                profanityScore = profanityScore,
            )
        } else {
            MessageRejectedEvent(
                eventId = UUID.randomUUID(),
                occurredAt = Instant.now(),
                messageId = event.messageId,
                correlationId = event.correlationId,
                causationId = event.eventId,
                producer = "validation-service",
                payload = MessageRejectedPayload(
                    text = event.payload.text,
                    reason = "PROFANITY_SCORE_ABOVE_${validationRule.rejectThreshold} (score=$profanityScore)",
                ),
                profanityScore = profanityScore,
            )
        }

        val sendResult = kafkaTemplate
            .send(KafkaTopics.MESSAGE_RESULTS, event.messageId.toString(), result)
            .get(5, TimeUnit.SECONDS)

        logger.atInfo()
            .addKeyValue("eventId", result.eventId)
            .addKeyValue("eventType", result.eventType)
            .addKeyValue("causationId", result.causationId)
            .addKeyValue("messageId", result.messageId)
            .addKeyValue("correlationId", result.correlationId)
            .addKeyValue("sourceTopic", sourceTopic)
            .addKeyValue("sourcePartition", sourcePartition)
            .addKeyValue("sourceOffset", sourceOffset)
            .addKeyValue("profanityScore", profanityScore)
            .addKeyValue("targetTopic", sendResult.recordMetadata.topic())
            .addKeyValue("targetPartition", sendResult.recordMetadata.partition())
            .addKeyValue("targetOffset", sendResult.recordMetadata.offset())
            .log("Message validation completed")
    }
}

private const val DLT_TEST_MESSAGE = "__FORCE_DLT__"

@Component
class ValidationRule(
    private val profanityScorer: ProfanityScorer,
    @org.springframework.beans.factory.annotation.Value("\${moderation.reject-threshold:0.7}")
    val rejectThreshold: Double,
    @org.springframework.beans.factory.annotation.Value("\${moderation.dlt-threshold:0.95}")
    private val dltThreshold: Double,
) {
    init {
        require(rejectThreshold >= 0.0 && rejectThreshold < dltThreshold && dltThreshold <= 1.0) {
            "Moderation thresholds must satisfy 0 <= reject < DLT <= 1"
        }
    }

    fun score(text: String): Double = profanityScorer.score(text).also {
        require(it.isFinite() && it in 0.0..1.0) { "Profanity score must be between 0 and 1" }
    }

    fun decide(score: Double): ValidationDecision {
        require(score.isFinite() && score in 0.0..1.0) { "Profanity score must be between 0 and 1" }
        return when {
            score > dltThreshold -> ValidationDecision.DLT
            score > rejectThreshold -> ValidationDecision.REJECT
            else -> ValidationDecision.ACCEPT
        }
    }
}

enum class ValidationDecision {
    ACCEPT,
    REJECT,
    DLT,
}
