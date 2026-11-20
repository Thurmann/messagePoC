package no.thurmann.messagepoc.moderation

import kotlin.test.Test
import kotlin.test.assertEquals

class ModerationServiceTest {
    @Test
    fun `strike increments the count`() {
        assertEquals(3, ModerationService.strikesAfter(2, true))
    }

    @Test
    fun `non strike keeps the count`() {
        assertEquals(2, ModerationService.strikesAfter(2, false))
    }
}
