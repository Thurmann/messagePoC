package no.thurmann.messagepoc.persistence

import no.thurmann.messagepoc.contracts.MessageAuthor
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageRejectedPayload
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageSubmittedPayload
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedPayload
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class MessageResultTest {
    @Test
    fun `from MessageValidatedEvent populates MessageResult`() {
        val eventId = UUID.randomUUID()
        val messageId = UUID.randomUUID()
        val correlationId = UUID.randomUUID()
        val causationId = UUID.randomUUID()
        val occurredAt = Instant.parse("2026-09-07T12:34:56Z")

        val event = MessageValidatedEvent(
            eventId = eventId,
            occurredAt = occurredAt,
            messageId = messageId,
            correlationId = correlationId,
            causationId = causationId,
            producer = "validation-service",
            payload = MessageValidatedPayload(text = "Order 123 is ready"),
        )

        val result = MessageResult.from(event)

        assertEquals(eventId, result.eventId)
        assertEquals("MessageValidated", result.eventType)
        assertEquals(1, result.eventVersion)
        assertEquals(occurredAt, result.occurredAt)
        assertEquals(messageId, result.messageId)
        assertEquals(correlationId, result.correlationId)
        assertEquals(causationId, result.causationId)
        assertEquals("validation-service", result.producer)
        assertEquals(MessageResultStatus.VALIDATED, result.status)
        assertEquals("Order 123 is ready", result.text)
        assertNull(result.reason)
    }

    @Test
    fun `from MessageValidatedEvent maps author`() {
        val event = MessageValidatedEvent(
            eventId = UUID.randomUUID(),
            occurredAt = Instant.now(),
            messageId = UUID.randomUUID(),
            correlationId = UUID.randomUUID(),
            causationId = UUID.randomUUID(),
            producer = "validation-service",
            payload = MessageValidatedPayload(text = "Hi"),
            author = MessageAuthor(userId = "sub-1", handle = "alice"),
        )

        val result = MessageResult.from(event)

        assertEquals("sub-1", result.authorId)
        assertEquals("alice", result.authorHandle)
        assertFalse(result.strike)
        assertNull(result.strikesAfter)
    }

    @Test
    fun `from MessageRejectedEvent maps author`() {
        val event = MessageRejectedEvent(
            eventId = UUID.randomUUID(),
            occurredAt = Instant.now(),
            messageId = UUID.randomUUID(),
            correlationId = UUID.randomUUID(),
            causationId = UUID.randomUUID(),
            producer = "validation-service",
            payload = MessageRejectedPayload(text = "Bad", reason = "PROFANITY_SCORE_ABOVE_0.7 (score=0.8)"),
            profanityScore = 0.8,
            author = MessageAuthor(userId = "sub-2", handle = "bob"),
        )

        val result = MessageResult.from(event)

        assertEquals(MessageResultStatus.REJECTED, result.status)
        assertEquals("sub-2", result.authorId)
        assertEquals("bob", result.authorHandle)
        assertFalse(result.strike)
    }

    @Test
    fun `fromDlt with profanity score uses threshold reason`() {
        val eventId = UUID.randomUUID()
        val event = submitted(eventId = eventId, profanityScore = 0.97)

        val result = MessageResult.fromDlt(event)

        assertEquals(eventId, result.eventId)
        assertEquals(MessageResultStatus.DLT, result.status)
        assertEquals("PROFANITY_SCORE_ABOVE_DLT_THRESHOLD (score=0.97)", result.reason)
        assertEquals(0.97, result.profanityScore)
        assertEquals("Very bad", result.text)
    }

    @Test
    fun `fromDlt without profanity score is a processing failure`() {
        val result = MessageResult.fromDlt(submitted(profanityScore = null))

        assertEquals(MessageResultStatus.DLT, result.status)
        assertEquals("PROCESSING_FAILURE", result.reason)
        assertNull(result.profanityScore)
    }

    @Test
    fun `fromDlt maps author`() {
        val result = MessageResult.fromDlt(
            submitted(profanityScore = null, author = MessageAuthor(userId = "sub-3", handle = "carol")),
        )

        assertEquals("sub-3", result.authorId)
        assertEquals("carol", result.authorHandle)
        assertEquals(MessageResultStatus.DLT, result.status)
    }

    private fun submitted(
        eventId: UUID = UUID.randomUUID(),
        profanityScore: Double?,
        author: MessageAuthor? = null,
    ) = MessageSubmittedEvent(
        eventId = eventId,
        occurredAt = Instant.parse("2026-09-07T12:00:00Z"),
        messageId = UUID.randomUUID(),
        correlationId = UUID.randomUUID(),
        causationId = null,
        producer = "message-api",
        payload = MessageSubmittedPayload(text = "Very bad"),
        profanityScore = profanityScore,
        author = author,
    )
}
