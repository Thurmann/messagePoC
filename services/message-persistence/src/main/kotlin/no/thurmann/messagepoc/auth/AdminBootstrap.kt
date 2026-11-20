package no.thurmann.messagepoc.auth

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component

fun parseAdminEmails(raw: String): List<String> =
    raw.split(',', ';', ' ', '\n')
        .map { it.trim().lowercase() }
        .filter { it.isNotEmpty() }
        .distinct()

@Component
class AdminBootstrap(
    private val jdbcTemplate: JdbcTemplate,
    @Value("\${admin.emails:}") private val adminEmails: String,
) : ApplicationRunner {
    private val logger = LoggerFactory.getLogger(javaClass)

    override fun run(args: ApplicationArguments) {
        val emails = parseAdminEmails(adminEmails)
        emails.forEach { email ->
            jdbcTemplate.update("INSERT INTO admin_user (email, source) VALUES (?, 'ENV') ON CONFLICT DO NOTHING", email)
        }
        logger.info("Admin bootstrap ensured {} admin email(s)", emails.size)
    }
}
