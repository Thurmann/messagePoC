package no.thurmann.messagepoc.audit

import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedPayload
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
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
}
