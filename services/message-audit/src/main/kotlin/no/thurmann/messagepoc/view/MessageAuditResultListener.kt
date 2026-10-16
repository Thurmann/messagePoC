package no.thurmann.messagepoc.view

import no.thurmann.messagepoc.contracts.KafkaTopics
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import org.slf4j.LoggerFactory
import org.springframework.kafka.annotation.KafkaHandler
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.kafka.support.KafkaHeaders
import org.springframework.messaging.handler.annotation.Header
import org.springframework.stereotype.Component
import java.util.UUID
import java.util.concurrent.TimeUnit

@Component
@KafkaListener(topics = [KafkaTopics.MESSAGE_RESULTS, KafkaTopics.MESSAGE_SUBMITTED_DLT])
class MessageAuditResultListener {
    private val logger = LoggerFactory.getLogger(javaClass)

    @KafkaHandler
    fun handle(
        event: MessageValidatedEvent,
        @Header(KafkaHeaders.RECEIVED_TOPIC) topic: String,
        @Header(KafkaHeaders.RECEIVED_PARTITION) partition: Int,
        @Header(KafkaHeaders.OFFSET) offset: Long,
    ) {
        logResult(event, "VALIDATED", event.payload.text, null, topic, partition, offset)
    }

    @KafkaHandler
    fun handle(
        event: MessageRejectedEvent,
        @Header(KafkaHeaders.RECEIVED_TOPIC) topic: String,
        @Header(KafkaHeaders.RECEIVED_PARTITION) partition: Int,
        @Header(KafkaHeaders.OFFSET) offset: Long,
    ) {
        logResult(event, "REJECTED", event.payload.text, event.payload.reason, topic, partition, offset)
    }

    @KafkaHandler(isDefault = true)
    fun handleUnknown(
        event: Any,
        @Header(KafkaHeaders.RECEIVED_TOPIC) topic: String,
    ) {
        if (topic == KafkaTopics.MESSAGE_SUBMITTED_DLT) {
            val eventType = event::class.qualifiedName ?: event::class.simpleName ?: "unknown"
            val submittedEvent = event as? MessageSubmittedEvent
            logger.atInfo()
                .addKeyValue("result", "DLT")
                .addKeyValue("topic", topic)
                .addKeyValue("eventType", eventType)
                .addKeyValue("eventId", submittedEvent?.eventId)
                .addKeyValue("messageId", submittedEvent?.messageId)
                .addKeyValue("correlationId", submittedEvent?.correlationId)
                .addKeyValue("profanityScore", submittedEvent?.profanityScore)
                .addKeyValue("data", event)
                .log("Received DLT event on type={}", eventType)
            return
        }

        logger.atError()
            .addKeyValue("data", event)
            .log("Received unsupported message result type={}", event::class.qualifiedName)
    }

    private fun logResult(
        event: no.thurmann.messagepoc.contracts.MessageEvent,
        result: String,
        text: String,
        reason: String?,
        topic: String,
        partition: Int,
        offset: Long,
    ) {
        logger.atInfo()
            .addKeyValue("eventId", event.eventId)
            .addKeyValue("eventType", event.eventType)
            .addKeyValue("causationId", event.causationId)
            .addKeyValue("messageId", event.messageId)
            .addKeyValue("correlationId", event.correlationId)
            .addKeyValue("result", result)
            .addKeyValue("reason", reason)
            .addKeyValue("text", text)
            .addKeyValue("profanityScore", when (event) {
                is MessageValidatedEvent -> event.profanityScore
                is MessageRejectedEvent -> event.profanityScore
                else -> null
            })
            .addKeyValue("topic", topic)
            .addKeyValue("partition", partition)
            .addKeyValue("offset", offset)
            .log("Message result received")
    }
}
