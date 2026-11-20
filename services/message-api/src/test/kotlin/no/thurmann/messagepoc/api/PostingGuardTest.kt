package no.thurmann.messagepoc.api

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class PostingGuardTest {
    private val now = Instant.parse("2026-01-01T12:00:00Z")

    @Test
    fun `allows user with handle and no ban`() {
        assertEquals(PostingDecision.Allowed("alice"), PostingGuard.evaluate(UserStatus("alice", null), now))
    }

    @Test
    fun `requires handle when user is unknown`() {
        assertEquals(PostingDecision.HandleRequired, PostingGuard.evaluate(null, now))
    }

    @Test
    fun `requires handle when handle is null`() {
        assertEquals(PostingDecision.HandleRequired, PostingGuard.evaluate(UserStatus(null, null), now))
    }

    @Test
    fun `bans with remaining seconds rounded up`() {
        val until = now.plusMillis(90_500)
        assertEquals(PostingDecision.Banned(until, 91), PostingGuard.evaluate(UserStatus("alice", until), now))
    }

    @Test
    fun `admin with active ban is allowed`() {
        val until = now.plusSeconds(600)
        assertEquals(PostingDecision.Allowed("root"), PostingGuard.evaluate(UserStatus("root", until, isAdmin = true), now))
    }

    @Test
    fun `admin without handle still requires handle`() {
        assertEquals(PostingDecision.HandleRequired, PostingGuard.evaluate(UserStatus(null, null, isAdmin = true), now))
    }

    @Test
    fun `treats expired ban as allowed`() {
        assertEquals(PostingDecision.Allowed("alice"), PostingGuard.evaluate(UserStatus("alice", now.minusSeconds(1)), now))
        assertEquals(PostingDecision.Allowed("alice"), PostingGuard.evaluate(UserStatus("alice", now), now))
    }
}
