package no.thurmann.messagepoc.validation

import no.thurmann.messagepoc.contracts.MessageAuthor
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageSubmittedPayload
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

class MessageResultBuilderTest {
    private val author = MessageAuthor(userId = "google-sub-123", handle = "christian_t")

    private fun submitted(author: MessageAuthor?) = MessageSubmittedEvent(
        eventId = UUID.randomUUID(),
        occurredAt = Instant.parse("2026-09-07T12:00:00Z"),
        messageId = UUID.randomUUID(),
        correlationId = UUID.randomUUID(),
        producer = "message-api",
        payload = MessageSubmittedPayload(text = "Hello"),
        author = author,
    )

    @Test
    fun `accepted result copies author from submitted event`() {
        val event = submitted(author)

        val result = buildResultEvent(event, ValidationDecision.ACCEPT, 0.1, 0.7)

        assertIs<MessageValidatedEvent>(result)
        assertEquals(author, result.author)
        assertEquals(event.eventId, result.causationId)
    }

    @Test
    fun `rejected result copies author from submitted event`() {
        val event = submitted(author)

        val result = buildResultEvent(event, ValidationDecision.REJECT, 0.8, 0.7)

        assertIs<MessageRejectedEvent>(result)
        assertEquals(author, result.author)
        assertEquals("PROFANITY_SCORE_ABOVE_0.7 (score=0.8)", result.payload.reason)
    }

    @Test
    fun `result has no author when submitted event has none`() {
        val result = buildResultEvent(submitted(null), ValidationDecision.ACCEPT, 0.0, 0.7)

        assertNull((result as MessageValidatedEvent).author)
    }
}
