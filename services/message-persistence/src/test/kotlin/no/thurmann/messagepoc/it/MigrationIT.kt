package no.thurmann.messagepoc.it

import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.testcontainers.junit.jupiter.Testcontainers
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

@Testcontainers(disabledWithoutDocker = true)
class MigrationIT {
    private fun freshDatabase(name: String): Pair<Flyway, JdbcTemplate> {
        val admin = SharedPostgres.container
        val adminJdbc = JdbcTemplate(DriverManagerDataSource(admin.jdbcUrl, admin.username, admin.password))
        adminJdbc.execute("CREATE DATABASE $name")
        val url = admin.jdbcUrl.replace("/${admin.databaseName}", "/$name")
        val ds = DriverManagerDataSource(url, admin.username, admin.password)
        val flyway = Flyway.configure().dataSource(ds).locations("classpath:db/migration")
        return flyway.load() to JdbcTemplate(ds)
    }

    private fun uniqueName() = "mig_" + UUID.randomUUID().toString().replace("-", "").take(12)

    private fun insertResult(jdbc: JdbcTemplate, status: String, extraCols: String = "", extraVals: List<Any?> = emptyList()) {
        val placeholders = extraVals.joinToString("") { ", ?" }
        jdbc.update(
            "INSERT INTO message_result (event_id, event_type, event_version, occurred_at, message_id, correlation_id, producer, status, text$extraCols) " +
                "VALUES (?, 'T', 1, now(), ?, ?, 'p', ?, 'txt'$placeholders)",
            UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), status, *extraVals.toTypedArray(),
        )
    }

    @Test
    fun `fresh database migrates to V4 with all tables columns and status constraint`() {
        val (flyway, jdbc) = freshDatabase(uniqueName())
        val result = flyway.migrate()
        assertEquals(4, result.migrationsExecuted)
        assertEquals("4", flyway.info().current().version.version)

        val tables = jdbc.queryForList("SELECT table_name FROM information_schema.tables WHERE table_schema='public'", String::class.java)
        assertTrue(tables.containsAll(listOf("message_result", "app_user", "admin_user", "user_ban")), "tables: $tables")

        val columns = jdbc.queryForList(
            "SELECT column_name FROM information_schema.columns WHERE table_name='message_result'", String::class.java,
        )
        assertTrue(columns.containsAll(listOf("profanity_score", "author_id", "author_handle", "strike", "strikes_after")), "columns: $columns")

        assertTrue(
            jdbc.queryForList("SELECT column_name FROM information_schema.columns WHERE table_name='app_user'", String::class.java).contains("last_seen_at"),
        )
        assertTrue(
            jdbc.queryForList("SELECT column_name FROM information_schema.columns WHERE table_name='user_ban'", String::class.java).contains("banned_by"),
        )

        val constraint = jdbc.queryForObject(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='message_result_status_chk'", String::class.java,
        )!!
        assertTrue(constraint.contains("DLT"), constraint)

        insertResult(jdbc, "DLT")
        insertResult(jdbc, "VALIDATED")
        insertResult(jdbc, "REJECTED")
        assertFailsWith<DataIntegrityViolationException> { insertResult(jdbc, "BOGUS") }
        assertEquals(3, jdbc.queryForObject("SELECT count(*) FROM message_result", Int::class.java))

        // case-insensitive unique handle index
        jdbc.update("INSERT INTO app_user (google_sub, email, handle) VALUES ('a', 'a@x', 'Bob')")
        assertFailsWith<DataIntegrityViolationException> {
            jdbc.update("INSERT INTO app_user (google_sub, email, handle) VALUES ('b', 'b@x', 'bob')")
        }
    }

    @Test
    fun `V2 era row survives upgrade to latest with strike false and null author`() {
        val (flyway, jdbc) = freshDatabase(uniqueName())
        val v2 = Flyway.configure().configuration(flyway.configuration).target("2").load()
        v2.migrate()
        assertEquals("2", v2.info().current().version.version)
        val eventId = UUID.randomUUID()
        jdbc.update(
            "INSERT INTO message_result (event_id, event_type, event_version, occurred_at, message_id, correlation_id, producer, status, text, profanity_score) " +
                "VALUES (?, 'T', 1, now(), ?, ?, 'p', 'VALIDATED', 'old message', 0.25)",
            eventId, UUID.randomUUID(), UUID.randomUUID(),
        )

        flyway.migrate()

        assertEquals("4", flyway.info().current().version.version)
        val row = jdbc.queryForMap("SELECT * FROM message_result WHERE event_id = ?", eventId)
        assertEquals("old message", row["text"])
        assertEquals(0.25, row["profanity_score"])
        assertEquals(false, row["strike"])
        assertNull(row["author_id"])
        assertNull(row["strikes_after"])
    }
}
