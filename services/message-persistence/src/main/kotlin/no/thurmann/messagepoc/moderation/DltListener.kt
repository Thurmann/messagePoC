package no.thurmann.messagepoc.moderation

import no.thurmann.messagepoc.contracts.KafkaTopics
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.persistence.MessageResult
import org.slf4j.LoggerFactory
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.stereotype.Component

@Component
class DltListener(
    private val moderationService: ModerationService,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @KafkaListener(topics = [KafkaTopics.MESSAGE_SUBMITTED_DLT], groupId = "\${spring.kafka.consumer.group-id}")
    fun handle(event: MessageSubmittedEvent) {
        val result = MessageResult.fromDlt(event)
        moderationService.record(result)
        logger.atInfo()
            .addKeyValue("eventId", result.eventId)
            .addKeyValue("messageId", result.messageId)
            .addKeyValue("correlationId", result.correlationId)
            .addKeyValue("result", result.status.name)
            .addKeyValue("reason", result.reason)
            .addKeyValue("profanityScore", result.profanityScore)
            .log("Message DLT result received")
    }
}
