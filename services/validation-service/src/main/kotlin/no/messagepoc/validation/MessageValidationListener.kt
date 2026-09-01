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
    fun validate(event: MessageSubmittedEvent) {
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

        kafkaTemplate
            .send(KafkaTopics.MESSAGE_RESULTS, event.messageId.toString(), result)
            .get(5, TimeUnit.SECONDS)

        logger.info(
            "Validated messageId={} correlationId={} result={}",
            event.messageId,
            event.correlationId,
            result.eventType,
        )
    }
}

@Component
class ValidationRule {
    fun accepts(text: String): Boolean = text.any(Char::isDigit)
}
