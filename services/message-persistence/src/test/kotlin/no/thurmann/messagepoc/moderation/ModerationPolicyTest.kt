package no.thurmann.messagepoc.moderation

import no.thurmann.messagepoc.audit.MessageResultStatus
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ModerationPolicyTest {
    private val policy = ModerationPolicy(ModerationProperties())
    private val now = Instant.parse("2026-09-07T12:00:00Z")

    @Test
    fun `warning applies from warning threshold up to but excluding ban threshold`() {
        assertFalse(policy.isWarning(2))
        assertTrue(policy.isWarning(3))
        assertTrue(policy.isWarning(5))
        assertFalse(policy.isWarning(6))
        assertFalse(policy.isWarning(7))
    }

    @Test
    fun `admin never gets a ban at or above threshold`() {
        assertNull(policy.decideBan(6, now, previousBan = null, isAdmin = true))
        assertNull(policy.decideBan(50, now, previousBan = null, isAdmin = true))
        val previous = PreviousBan(step = 0, endsAt = now.minus(Duration.ofHours(1)))
        assertNull(policy.decideBan(6, now, previous, isAdmin = true))
        assertEquals(1, policy.decideBan(6, now, previous, isAdmin = false)?.step)
    }

    @Test
    fun `admin warning applies from warning threshold with no upper bound`() {
        assertFalse(policy.isWarning(2, isAdmin = true))
        assertTrue(policy.isWarning(3, isAdmin = true))
        assertTrue(policy.isWarning(6, isAdmin = true))
        assertTrue(policy.isWarning(100, isAdmin = true))
    }

    @Test
    fun `non admin warning is unchanged`() {
        assertTrue(policy.isWarning(5, isAdmin = false))
        assertFalse(policy.isWarning(6, isAdmin = false))
    }

    @Test
    fun `no ban below ban threshold`() {
        assertNull(policy.decideBan(5, now, previousBan = null))
    }

    @Test
    fun `first ban at threshold uses first ladder step`() {
        val decision = policy.decideBan(6, now, previousBan = null)

        assertEquals(BanDecision(step = 0, startsAt = now, endsAt = now.plus(Duration.ofMinutes(1))), decision)
    }

    @Test
    fun `ban within escalation window steps up`() {
        val previous = PreviousBan(step = 0, endsAt = now.minus(Duration.ofHours(1)))

        val decision = policy.decideBan(6, now, previous)

        assertEquals(1, decision?.step)
        assertEquals(now.plus(Duration.ofMinutes(5)), decision?.endsAt)
    }

    @Test
    fun `ban after escalation window resets to first step`() {
        val previous = PreviousBan(step = 3, endsAt = now.minus(Duration.ofDays(2)))

        val decision = policy.decideBan(6, now, previous)

        assertEquals(0, decision?.step)
        assertEquals(now.plus(Duration.ofMinutes(1)), decision?.endsAt)
    }

    @Test
    fun `last ladder step repeats past the end of the ladder`() {
        val previous = PreviousBan(step = 5, endsAt = now.minus(Duration.ofMinutes(10)))

        val decision = policy.decideBan(6, now, previous)

        assertEquals(6, decision?.step)
        assertEquals(now.plus(Duration.ofHours(24)), decision?.endsAt)
    }

    @Test
    fun `no new ban while previous ban is still active`() {
        val previous = PreviousBan(step = 0, endsAt = now.plus(Duration.ofMinutes(10)))

        assertNull(policy.decideBan(6, now, previous))
    }

    @Test
    fun `manual ban without a previous ban uses the first ladder step`() {
        assertEquals(BanDecision(step = 0, startsAt = now, endsAt = now.plus(Duration.ofMinutes(1))), policy.decideManualBan(now, null))
    }

    @Test
    fun `manual ban within the escalation window steps up`() {
        val previous = PreviousBan(step = 0, endsAt = now.minus(Duration.ofHours(1)))

        val decision = policy.decideManualBan(now, previous)

        assertEquals(1, decision?.step)
        assertEquals(now.plus(Duration.ofMinutes(5)), decision?.endsAt)
    }

    @Test
    fun `manual ban after the escalation window resets to the first step`() {
        val previous = PreviousBan(step = 3, endsAt = now.minus(Duration.ofDays(2)))

        val decision = policy.decideManualBan(now, previous)

        assertEquals(0, decision?.step)
        assertEquals(now.plus(Duration.ofMinutes(1)), decision?.endsAt)
    }

    @Test
    fun `manual ban duration is capped at the last ladder step`() {
        val previous = PreviousBan(step = 5, endsAt = now.minus(Duration.ofMinutes(10)))

        val decision = policy.decideManualBan(now, previous)

        assertEquals(6, decision?.step)
        assertEquals(now.plus(Duration.ofHours(24)), decision?.endsAt)
    }

    @Test
    fun `no manual ban while a previous ban is still active`() {
        assertNull(policy.decideManualBan(now, PreviousBan(step = 0, endsAt = now.plus(Duration.ofMinutes(10)))))
    }

    @Test
    fun `strike window starts at end of previous ban`() {
        val previous = PreviousBan(step = 0, endsAt = now)

        assertNull(policy.strikeWindowStart(null))
        assertEquals(now, policy.strikeWindowStart(previous))
    }

    @Test
    fun `rejected results always count as strikes`() {
        assertTrue(policy.countsAsStrike(MessageResultStatus.REJECTED, 0.8))
    }

    @Test
    fun `validated results never count as strikes`() {
        assertFalse(policy.countsAsStrike(MessageResultStatus.VALIDATED, 0.1))
    }

    @Test
    fun `score based dlt counts as strike`() {
        assertTrue(policy.countsAsStrike(MessageResultStatus.DLT, 0.97))
    }

    @Test
    fun `technical dlt counts as strike only when configured`() {
        assertFalse(policy.countsAsStrike(MessageResultStatus.DLT, null))
        assertTrue(
            ModerationPolicy(ModerationProperties(technicalDltCountsAsStrike = true))
                .countsAsStrike(MessageResultStatus.DLT, null),
        )
    }
}
