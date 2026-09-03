package no.messagepoc.validation

import no.messagepoc.contracts.KafkaTopics
import no.messagepoc.contracts.MessageRejectedEvent
import no.messagepoc.contracts.MessageRejectedPayload
import no.messagepoc.contracts.MessageSubmittedEvent
import no.messagepoc.contracts.MessageValidatedEvent
import no.messagepoc.contracts.MessageValidatedPayload
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
        val result = if (validationRule.accepts(event.payload.text)) {
            MessageValidatedEvent(
                eventId = UUID.randomUUID(),
                occurredAt = Instant.now(),
                messageId = event.messageId,
                correlationId = event.correlationId,
                causationId = event.eventId,
                producer = "validation-service",
                payload = MessageValidatedPayload(event.payload.text),
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
                    reason = "MESSAGE_CONTAINS_NO_DIGIT",
                ),
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
            .addKeyValue("targetTopic", sendResult.recordMetadata.topic())
            .addKeyValue("targetPartition", sendResult.recordMetadata.partition())
            .addKeyValue("targetOffset", sendResult.recordMetadata.offset())
            .log("Message validation completed")
    }
}

@Component
class ValidationRule {
    fun accepts(text: String): Boolean = text.any(Char::isDigit)
}
