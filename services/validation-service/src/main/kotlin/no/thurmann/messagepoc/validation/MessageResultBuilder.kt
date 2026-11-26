package no.thurmann.messagepoc.validation

import no.thurmann.messagepoc.contracts.MessageEvent
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageRejectedPayload
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedPayload
import java.time.Instant
import java.util.UUID

internal fun buildResultEvent(
    event: MessageSubmittedEvent,
    decision: ValidationDecision,
    profanityScore: Double,
    rejectThreshold: Double,
    eventId: UUID = UUID.randomUUID(),
    occurredAt: Instant = Instant.now(),
): MessageEvent =
    if (decision == ValidationDecision.ACCEPT) {
        MessageValidatedEvent(
            eventId = eventId,
            occurredAt = occurredAt,
            messageId = event.messageId,
            correlationId = event.correlationId,
            causationId = event.eventId,
            producer = "validation-service",
            payload = MessageValidatedPayload(event.payload.text),
            profanityScore = profanityScore,
            author = event.author,
        )
    } else {
        MessageRejectedEvent(
            eventId = eventId,
            occurredAt = occurredAt,
            messageId = event.messageId,
            correlationId = event.correlationId,
            causationId = event.eventId,
            producer = "validation-service",
            payload = MessageRejectedPayload(
                text = event.payload.text,
                reason = "PROFANITY_SCORE_ABOVE_$rejectThreshold (score=$profanityScore)",
            ),
            profanityScore = profanityScore,
            author = event.author,
        )
    }
