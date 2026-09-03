package no.messagepoc.view

import no.messagepoc.contracts.KafkaTopics
import no.messagepoc.contracts.MessageRejectedEvent
import no.messagepoc.contracts.MessageValidatedEvent
import org.slf4j.LoggerFactory
import org.springframework.kafka.annotation.KafkaHandler
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.kafka.support.KafkaHeaders
import org.springframework.messaging.handler.annotation.Header
import org.springframework.stereotype.Component

@Component
@KafkaListener(topics = [KafkaTopics.MESSAGE_RESULTS])
class MessageResultListener {
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
    fun handleUnknown(event: Any) {
        logger.warn("Received unsupported message result type={}", event::class.qualifiedName)
    }

    private fun logResult(
        event: no.messagepoc.contracts.MessageEvent,
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
            .addKeyValue("topic", topic)
            .addKeyValue("partition", partition)
            .addKeyValue("offset", offset)
            .log("Message result received")
    }
}
