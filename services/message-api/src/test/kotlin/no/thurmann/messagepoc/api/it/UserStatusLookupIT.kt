package no.thurmann.messagepoc.api.it

import no.thurmann.messagepoc.api.JdbcUserStatusLookup
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.testcontainers.junit.jupiter.Testcontainers
import java.sql.Timestamp
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@Testcontainers(disabledWithoutDocker = true)
class UserStatusLookupIT {
    private lateinit var jdbc: JdbcTemplate
    private lateinit var lookup: JdbcUserStatusLookup
    private val now: Instant = Instant.now().truncatedTo(ChronoUnit.MILLIS)

    @BeforeEach
    fun setUp() {
        val c = SharedPostgres.container
        jdbc = JdbcTemplate(DriverManagerDataSource(c.jdbcUrl, c.username, c.password))
        listOf("user_ban", "message_result", "app_user", "admin_user").forEach { jdbc.update("DELETE FROM $it") }
        lookup = JdbcUserStatusLookup(jdbc)
    }

    private fun user(sub: String, email: String = "$sub@test.local", handle: String? = null) =
        jdbc.update("INSERT INTO app_user (google_sub, email, handle) VALUES (?, ?, ?)", sub, email, handle)

    private fun ban(sub: String, endsAt: Instant) =
        jdbc.update(
            "INSERT INTO user_ban (user_id, step, starts_at, ends_at) VALUES (?, 1, ?, ?)",
            sub, Timestamp.from(endsAt.minusSeconds(7200)), Timestamp.from(endsAt),
        )

    @Test
    fun `unknown sub returns null`() {
        assertNull(lookup.find("nobody", now))
    }

    @Test
    fun `user without handle has null handle`() {
        user("u1")
        val s = assertNotNull(lookup.find("u1", now))
        assertNull(s.handle)
        assertNull(s.banEndsAt)
        assertFalse(s.isAdmin)
    }

    @Test
    fun `user with handle and no ban`() {
        user("u1", handle = "alice")
        val s = assertNotNull(lookup.find("u1", now))
        assertEquals("alice", s.handle)
        assertNull(s.banEndsAt)
    }

    @Test
    fun `active ban returns latest ends_at`() {
        user("u1", handle = "alice")
        val later = now.plusSeconds(3600)
        ban("u1", now.plusSeconds(600))
        ban("u1", later)
        assertEquals(later, lookup.find("u1", now)?.banEndsAt)
    }

    @Test
    fun `expired ban is ignored`() {
        user("u1", handle = "alice")
        ban("u1", now.minusSeconds(60))
        assertNull(lookup.find("u1", now)?.banEndsAt)
        // another user's active ban does not leak
        user("u2", handle = "bob")
        ban("u2", now.plusSeconds(100))
        assertNull(lookup.find("u1", now)?.banEndsAt)
    }

    @Test
    fun `admin flag matches email case insensitively`() {
        user("a1", email = "Admin@Test.Local", handle = "boss")
        user("u1", email = "someone@test.local", handle = "plain")
        jdbc.update("INSERT INTO admin_user (email, source) VALUES ('admin@test.local', 'ENV')")
        assertTrue(assertNotNull(lookup.find("a1", now)).isAdmin)
        assertFalse(assertNotNull(lookup.find("u1", now)).isAdmin)
    }
}
