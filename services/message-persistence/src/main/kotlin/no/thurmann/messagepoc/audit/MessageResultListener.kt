package no.thurmann.messagepoc.audit

import no.thurmann.messagepoc.contracts.KafkaTopics
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import org.slf4j.LoggerFactory
import org.springframework.kafka.annotation.KafkaHandler
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.kafka.support.KafkaHeaders
import org.springframework.messaging.handler.annotation.Header
import org.springframework.stereotype.Component

@Component
@KafkaListener(topics = [KafkaTopics.MESSAGE_RESULTS])
class MessageResultListener(
    val messageResultRepository: MessageResultRepository
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @KafkaHandler
    fun handle(
        event: MessageValidatedEvent,
        @Header(KafkaHeaders.RECEIVED_TOPIC) topic: String,
        @Header(KafkaHeaders.RECEIVED_PARTITION) partition: Int,
        @Header(KafkaHeaders.OFFSET) offset: Long,
    ) {
        val result = MessageResult.from(event)
        messageResultRepository.save(result)
        logResult(result, topic, partition, offset)
    }

    @KafkaHandler
    fun handle(
        event: MessageRejectedEvent,
        @Header(KafkaHeaders.RECEIVED_TOPIC) topic: String,
        @Header(KafkaHeaders.RECEIVED_PARTITION) partition: Int,
        @Header(KafkaHeaders.OFFSET) offset: Long,
    ) {
        val result = MessageResult.from(event)
        messageResultRepository.save(result)
        logResult(result, topic, partition, offset)
    }

    private fun logResult(
        result: MessageResult,
        topic: String,
        partition: Int,
        offset: Long,
    ) {
        logger.atInfo()
            .addKeyValue("eventId", result.eventId)
            .addKeyValue("eventType", result.eventType)
            .addKeyValue("causationId", result.causationId)
            .addKeyValue("messageId", result.messageId)
            .addKeyValue("correlationId", result.correlationId)
            .addKeyValue("result", result.status.name)
            .addKeyValue("reason", result.reason)
            .addKeyValue("profanityScore", result.profanityScore)
            .addKeyValue("text", result.text)
            .addKeyValue("topic", topic)
            .addKeyValue("partition", partition)
            .addKeyValue("offset", offset)
            .log("Message result received")
    }
}
