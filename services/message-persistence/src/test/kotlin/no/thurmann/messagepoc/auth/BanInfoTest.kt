package no.thurmann.messagepoc.auth

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class BanInfoTest {
    private val now = Instant.parse("2026-01-01T00:00:00Z")

    @Test
    fun `remaining seconds are floored`() {
        val until = now.plusMillis(90_500)
        assertEquals(BanInfo(until, 90), BanInfo.of(until, now))
    }

    @Test
    fun `a ban in the past has zero remaining seconds`() {
        val until = now.minusSeconds(30)
        assertEquals(BanInfo(until, 0), BanInfo.of(until, now))
    }
}
