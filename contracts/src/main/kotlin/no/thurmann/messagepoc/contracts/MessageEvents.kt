package no.thurmann.messagepoc.contracts

import java.time.Instant
import java.util.UUID

sealed interface MessageEvent {
    val eventId: UUID
    val eventType: String
    val eventVersion: Int
    val occurredAt: Instant
    val messageId: UUID
    val correlationId: UUID
    val causationId: UUID?
    val producer: String
    val profanityScore: Double?
    val author: MessageAuthor?
}

data class MessageSubmittedEvent(
    override val eventId: UUID,
    override val eventType: String = "MessageSubmitted",
    override val eventVersion: Int = 1,
    override val occurredAt: Instant,
    override val messageId: UUID,
    override val correlationId: UUID,
    override val causationId: UUID? = null,
    override val producer: String,
    val payload: MessageSubmittedPayload,
    override val profanityScore: Double? = null,
    override val author: MessageAuthor? = null,
) : MessageEvent

data class MessageAuthor(
    val userId: String,
    val handle: String,
)

data class MessageSubmittedPayload(
    val text: String,
)

data class MessageValidatedEvent(
    override val eventId: UUID,
    override val eventType: String = "MessageValidated",
    override val eventVersion: Int = 1,
    override val occurredAt: Instant,
    override val messageId: UUID,
    override val correlationId: UUID,
    override val causationId: UUID,
    override val producer: String,
    val payload: MessageValidatedPayload,
    override val profanityScore: Double? = null,
    override val author: MessageAuthor? = null,
) : MessageEvent

data class MessageValidatedPayload(
    val text: String,
)

data class MessageRejectedEvent(
    override val eventId: UUID,
    override val eventType: String = "MessageRejected",
    override val eventVersion: Int = 1,
    override val occurredAt: Instant,
    override val messageId: UUID,
    override val correlationId: UUID,
    override val causationId: UUID,
    override val producer: String,
    val payload: MessageRejectedPayload,
    override val profanityScore: Double? = null,
    override val author: MessageAuthor? = null,
) : MessageEvent

data class MessageRejectedPayload(
    val text: String,
    val reason: String,
)
