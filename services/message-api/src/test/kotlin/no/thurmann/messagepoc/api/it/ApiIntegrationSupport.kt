package no.thurmann.messagepoc.api.it

import no.thurmann.messagepoc.api.googleJwtValidator
import org.flywaydb.core.Flyway
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.security.oauth2.jwt.BadJwtException
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.testcontainers.postgresql.PostgreSQLContainer
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

const val TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com"

/** One Postgres per JVM (random port), migrated with message-persistence's own migration files. */
object SharedPostgres {
    val container: PostgreSQLContainer by lazy {
        PostgreSQLContainer("postgres:17-alpine").withDatabaseName("message_poc").withUsername("message_poc")
            .withPassword("message_poc").also {
                it.start()
                val dir = requireNotNull(System.getProperty("persistence.migration.dir")) { "persistence.migration.dir not set" }
                Flyway.configure().dataSource(it.jdbcUrl, it.username, it.password).locations("filesystem:$dir").load().migrate()
            }
    }
}

class TestJwtDecoder : JwtDecoder {
    override fun decode(token: String): Jwt {
        val jwt = tokens[token] ?: throw BadJwtException("unknown test token")
        val result = googleJwtValidator(TEST_CLIENT_ID).validate(jwt)
        if (result.hasErrors()) throw BadJwtException(result.errors.first().description ?: "invalid token")
        return jwt
    }

    companion object {
        private val tokens = ConcurrentHashMap<String, Jwt>()

        fun bearer(sub: String, email: String, aud: String = TEST_CLIENT_ID): String {
            val token = UUID.randomUUID().toString()
            val now = Instant.now()
            tokens[token] = Jwt.withTokenValue(token).header("alg", "none").subject(sub)
                .issuer("https://accounts.google.com").audience(listOf(aud))
                .issuedAt(now).expiresAt(now.plusSeconds(3600))
                .claim("email", email).claim("email_verified", true).build()
            return "Bearer $token"
        }
    }
}

@TestConfiguration(proxyBeanMethods = false)
class TestJwtConfig {
    @Bean
    @Primary
    fun testJwtDecoder(): JwtDecoder = TestJwtDecoder()
}
