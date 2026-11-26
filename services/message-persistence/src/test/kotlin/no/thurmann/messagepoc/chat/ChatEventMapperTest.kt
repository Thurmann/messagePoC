package no.thurmann.messagepoc.chat

import no.thurmann.messagepoc.persistence.MessageResult
import no.thurmann.messagepoc.persistence.MessageResultStatus
import tools.jackson.databind.json.JsonMapper
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class ChatEventMapperTest {
    private fun result(status: MessageResultStatus) = MessageResult(
        eventId = UUID.randomUUID(),
        occurredAt = Instant.parse("2026-01-01T00:00:00Z"),
        messageId = UUID.randomUUID(),
        status = status,
        text = "secret words",
        reason = "bad",
        profanityScore = 0.9,
        authorId = "sub-1",
        authorHandle = "alice",
        strike = status != MessageResultStatus.VALIDATED,
        strikesAfter = 4,
    )

    @Test
    fun `validated maps to message with text`() {
        val event = ChatEventMapper.publicEvent(result(MessageResultStatus.VALIDATED))
        assertEquals("message", event.type)
        assertEquals("secret words", event.text)
        assertEquals("alice", event.handle)
    }

    @Test
    fun `rejected and dlt map to removed without text`() {
        val mapper = JsonMapper.builder().build()
        listOf(MessageResultStatus.REJECTED, MessageResultStatus.DLT).forEach {
            val event = ChatEventMapper.publicEvent(result(it))
            assertEquals("removed", event.type)
            assertNull(event.text)
            val json = mapper.writeValueAsString(event)
            assertFalse(json.contains("secret"))
            assertFalse(json.contains("\"text\""))
        }
    }

    @Test
    fun `admin row includes score strikes and ban state`() {
        val until = Instant.parse("2026-01-01T01:00:00Z")
        val row = ChatEventMapper.adminRow(result(MessageResultStatus.REJECTED), "a@x.com", 5, until)
        assertEquals(0.9, row.score)
        assertEquals(4, row.strikesAfter)
        assertEquals(5, row.currentStrikes)
        assertEquals("a@x.com", row.email)
        assertEquals("secret words", row.text)
        assertNotNull(row.banState)
        assertEquals(until, row.banState.until)
    }
}
