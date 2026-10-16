package no.thurmann.messagepoc.audit

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.Id
import jakarta.persistence.Table
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import java.time.Instant
import java.util.UUID

enum class MessageResultStatus {
    VALIDATED,
    REJECTED,
}

@Entity
@Table(name = "message_result")
open class MessageResult(
    @field:Id
    @field:Column(name = "event_id", nullable = false)
    open var eventId: UUID = UUID(0L, 0L),

    @field:Column(name = "event_type", nullable = false)
    open var eventType: String = "",

    @field:Column(name = "event_version", nullable = false)
    open var eventVersion: Int = 0,

    @field:Column(name = "occurred_at", nullable = false)
    open var occurredAt: Instant = Instant.EPOCH,

    @field:Column(name = "message_id", nullable = false)
    open var messageId: UUID = UUID(0L, 0L),

    @field:Column(name = "correlation_id", nullable = false)
    open var correlationId: UUID = UUID(0L, 0L),

    @field:Column(name = "causation_id", nullable = true)
    open var causationId: UUID? = null,

    @field:Column(name = "producer", nullable = false)
    open var producer: String = "",

    @field:Enumerated(EnumType.STRING)
    @field:Column(name = "status", nullable = false)
    open var status: MessageResultStatus = MessageResultStatus.VALIDATED,

    @field:Column(name = "text", nullable = false)
    open var text: String = "",

    @field:Column(name = "reason", nullable = true)
    open var reason: String? = null,

    @field:Column(name = "profanity_score", nullable = true)
    open var profanityScore: Double? = null,
) {
    companion object {
        fun from(event: MessageValidatedEvent): MessageResult =
            MessageResult(
                eventId = event.eventId,
                eventType = event.eventType,
                eventVersion = event.eventVersion,
                occurredAt = event.occurredAt,
                messageId = event.messageId,
                correlationId = event.correlationId,
                causationId = event.causationId,
                producer = event.producer,
                status = MessageResultStatus.VALIDATED,
                text = event.payload.text,
                reason = null,
                profanityScore = event.profanityScore,
            )

        fun from(event: MessageRejectedEvent): MessageResult =
            MessageResult(
                eventId = event.eventId,
                eventType = event.eventType,
                eventVersion = event.eventVersion,
                occurredAt = event.occurredAt,
                messageId = event.messageId,
                correlationId = event.correlationId,
                causationId = event.causationId,
                producer = event.producer,
                status = MessageResultStatus.REJECTED,
                text = event.payload.text,
                reason = event.payload.reason,
                profanityScore = event.profanityScore,
            )
    }
}
