package no.thurmann.messagepoc.chat

import com.fasterxml.jackson.annotation.JsonInclude
import no.thurmann.messagepoc.auth.AdminDirectory
import no.thurmann.messagepoc.auth.PresenceProperties
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.time.Instant

@RestController
@RequestMapping("/api/users")
class UsersController(
    private val jdbcTemplate: JdbcTemplate,
    private val adminDirectory: AdminDirectory,
    private val presenceProperties: PresenceProperties,
) {
    @GetMapping("/online")
    fun online(@AuthenticationPrincipal jwt: Jwt): List<OnlineUser> {
        val callerIsAdmin = adminDirectory.isAdmin(jwt)
        return jdbcTemplate.query(
            """
            SELECT u.handle,
                   (a.email IS NOT NULL) AS is_admin,
                   (SELECT max(b.ends_at) FROM user_ban b WHERE b.user_id = u.google_sub AND b.ends_at > now()) AS banned_until
            FROM app_user u
            LEFT JOIN admin_user a ON lower(a.email) = lower(u.email)
            WHERE u.handle IS NOT NULL AND u.last_seen_at > now() - make_interval(secs => ?)
            ORDER BY lower(u.handle)
            LIMIT 200
            """.trimIndent(),
            { rs, _ ->
                val userIsAdmin = rs.getBoolean("is_admin")
                OnlineUser(
                    handle = rs.getString("handle"),
                    isAdmin = if (callerIsAdmin) userIsAdmin else null,
                    bannedUntil = if (callerIsAdmin && !userIsAdmin) rs.getTimestamp("banned_until")?.toInstant() else null,
                )
            },
            presenceProperties.onlineWindow.toMillis() / 1000.0,
        )
    }
}

@JsonInclude(JsonInclude.Include.NON_NULL)
data class OnlineUser(val handle: String, val isAdmin: Boolean? = null, val bannedUntil: Instant? = null)
