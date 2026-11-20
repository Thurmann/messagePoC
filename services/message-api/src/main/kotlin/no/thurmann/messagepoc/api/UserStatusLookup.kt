package no.thurmann.messagepoc.api

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import java.sql.Timestamp
import java.time.Instant

interface UserStatusLookup {
    fun find(sub: String, now: Instant): UserStatus?
}

@Repository
class JdbcUserStatusLookup(private val jdbcTemplate: JdbcTemplate) : UserStatusLookup {
    override fun find(sub: String, now: Instant): UserStatus? =
        jdbcTemplate.query(
            """
            SELECT u.handle,
                   (SELECT b.ends_at FROM user_ban b
                     WHERE b.user_id = u.google_sub AND b.ends_at > ?
                     ORDER BY b.ends_at DESC LIMIT 1) AS ban_ends_at
            FROM app_user u
            WHERE u.google_sub = ?
            """.trimIndent(),
            { rs, _ -> UserStatus(rs.getString("handle"), rs.getTimestamp("ban_ends_at")?.toInstant()) },
            Timestamp.from(now),
            sub,
        ).firstOrNull()
}
