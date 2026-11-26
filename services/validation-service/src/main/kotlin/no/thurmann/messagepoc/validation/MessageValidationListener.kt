package no.thurmann.messagepoc.validation

import no.thurmann.messagepoc.contracts.KafkaTopics
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import org.slf4j.LoggerFactory
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.kafka.support.KafkaHeaders
import org.springframework.kafka.support.SendResult
import org.springframework.messaging.handler.annotation.Header
import org.springframework.stereotype.Component
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
            val sendResult = send(
                KafkaTopics.MESSAGE_SUBMITTED_DLT,
                event.messageId.toString(),
                event.copy(profanityScore = profanityScore),
            )

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

        val result = buildResultEvent(event, decision, profanityScore, validationRule.rejectThreshold)

        val sendResult = send(KafkaTopics.MESSAGE_RESULTS, event.messageId.toString(), result)

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

    private fun send(topic: String, key: String, value: Any): SendResult<String, Any> =
        kafkaTemplate.send(topic, key, value).get(SEND_TIMEOUT_SECONDS, TimeUnit.SECONDS)
}

private const val DLT_TEST_MESSAGE = "__FORCE_DLT__"
private const val SEND_TIMEOUT_SECONDS = 5L
