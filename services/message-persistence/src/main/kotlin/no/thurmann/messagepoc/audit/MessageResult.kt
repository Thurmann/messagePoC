package no.thurmann.messagepoc.audit

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.Id
import jakarta.persistence.Table
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import java.time.Instant
import java.util.UUID

enum class MessageResultStatus {
    VALIDATED,
    REJECTED,
    DLT,
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

    @field:Column(name = "author_id", nullable = true)
    open var authorId: String? = null,

    @field:Column(name = "author_handle", nullable = true)
    open var authorHandle: String? = null,

    @field:Column(name = "strike", nullable = false)
    open var strike: Boolean = false,

    @field:Column(name = "strikes_after", nullable = true)
    open var strikesAfter: Int? = null,
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
                authorId = event.author?.userId,
                authorHandle = event.author?.handle,
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
                authorId = event.author?.userId,
                authorHandle = event.author?.handle,
            )

        fun fromDlt(event: MessageSubmittedEvent): MessageResult =
            MessageResult(
                eventId = event.eventId,
                eventType = event.eventType,
                eventVersion = event.eventVersion,
                occurredAt = event.occurredAt,
                messageId = event.messageId,
                correlationId = event.correlationId,
                causationId = event.causationId,
                producer = event.producer,
                status = MessageResultStatus.DLT,
                text = event.payload.text,
                reason = event.profanityScore?.let { "PROFANITY_SCORE_ABOVE_DLT_THRESHOLD (score=$it)" }
                    ?: "PROCESSING_FAILURE",
                profanityScore = event.profanityScore,
                authorId = event.author?.userId,
                authorHandle = event.author?.handle,
            )
    }
}
