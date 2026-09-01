package no.messagepoc.view

import no.messagepoc.contracts.KafkaTopics
import no.messagepoc.contracts.MessageRejectedEvent
import no.messagepoc.contracts.MessageValidatedEvent
import org.slf4j.LoggerFactory
import org.springframework.kafka.annotation.KafkaHandler
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.stereotype.Component

@Component
@KafkaListener(topics = [KafkaTopics.MESSAGE_RESULTS])
class MessageResultListener {
    private val logger = LoggerFactory.getLogger(javaClass)

    @KafkaHandler
    fun handle(event: MessageValidatedEvent) {
        logger.info(
            "Message VALIDATED messageId={} correlationId={} text={}",
            event.messageId,
            event.correlationId,
            event.payload.text,
        )
    }

    @KafkaHandler
    fun handle(event: MessageRejectedEvent) {
        logger.info(
            "Message REJECTED messageId={} correlationId={} reason={} text={}",
            event.messageId,
            event.correlationId,
            event.payload.reason,
            event.payload.text,
        )
    }

    @KafkaHandler(isDefault = true)
    fun handleUnknown(event: Any) {
        logger.warn("Received unsupported message result type={}", event::class.qualifiedName)
    }
}
