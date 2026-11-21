package no.thurmann.messagepoc.kafka

import org.junit.jupiter.api.Test
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KafkaHealthStateTest {
    private val t0 = Instant.parse("2026-01-01T00:00:00Z")
    private fun t(s: Long) = t0.plusSeconds(s)

    @Test
    fun `starts unknown`() {
        val v = KafkaHealthState(2).view()
        assertEquals("UNKNOWN", v.status)
        assertNull(v.since); assertNull(v.checkedAt)
    }

    @Test
    fun `one failure from unknown stays unknown, two go down`() {
        val s = KafkaHealthState(2)
        assertFalse(s.recordFailure(t(1), "x"))
        assertEquals("UNKNOWN", s.view().status)
        assertTrue(s.recordFailure(t(2), "x"))
        assertEquals("DOWN", s.view().status)
        assertEquals(t(2), s.view().since)
    }

    @Test
    fun `success goes up immediately and single failure does not flip`() {
        val s = KafkaHealthState(2)
        s.recordFailure(t(1), "x"); s.recordFailure(t(2), "x")
        assertTrue(s.recordSuccess(t(3)))
        assertEquals("UP", s.view().status)
        assertFalse(s.recordFailure(t(4), "x"))
        assertEquals("UP", s.view().status)
        assertFalse(s.recordSuccess(t(5)))
        assertFalse(s.recordFailure(t(6), "x"))
        assertTrue(s.recordFailure(t(7), "x"))
        assertEquals("DOWN", s.view().status)
    }

    @Test
    fun `since changes only on transitions while checkedAt updates every time`() {
        val s = KafkaHealthState(2)
        s.recordSuccess(t(1))
        s.recordSuccess(t(2))
        assertEquals(t(1), s.view().since)
        assertEquals(t(2), s.view().checkedAt)
        s.recordFailure(t(3), "x")
        assertEquals(t(1), s.view().since)
        assertEquals(t(3), s.view().checkedAt)
        s.recordFailure(t(4), "x")
        s.recordFailure(t(5), "x")
        assertEquals(t(4), s.view().since)
        assertEquals(t(5), s.view().checkedAt)
    }
}
