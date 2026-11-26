package no.thurmann.messagepoc.it

import no.thurmann.messagepoc.auth.googleJwtValidator
import no.thurmann.messagepoc.contracts.MessageAuthor
import no.thurmann.messagepoc.contracts.MessageRejectedEvent
import no.thurmann.messagepoc.contracts.MessageRejectedPayload
import no.thurmann.messagepoc.contracts.MessageValidatedEvent
import no.thurmann.messagepoc.contracts.MessageValidatedPayload
import no.thurmann.messagepoc.persistence.MessagePersistenceApplication
import no.thurmann.messagepoc.persistence.MessageResult
import org.junit.jupiter.api.BeforeEach
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.context.annotation.Primary
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.security.oauth2.jwt.BadJwtException
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.postgresql.PostgreSQLContainer
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

const val TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com"
const val ADMIN_EMAIL = "admin@test.local"

/** One Postgres container per JVM, shared by every integration test class. Started lazily so Docker-less builds still work. */
object SharedPostgres {
    val container: PostgreSQLContainer by lazy {
        PostgreSQLContainer("postgres:17-alpine").withDatabaseName("message_poc").withUsername("message_poc")
            .withPassword("message_poc").also { it.start() }
    }
}

/** Replaces the Google JWKS-backed decoder: tokens are opaque keys into a registry, but the real Google claim validator still runs. */
class TestJwtDecoder : JwtDecoder {
    override fun decode(token: String): Jwt {
        val jwt = tokens[token] ?: throw BadJwtException("unknown test token")
        val result = googleJwtValidator(TEST_CLIENT_ID).validate(jwt)
        if (result.hasErrors()) throw BadJwtException(result.errors.first().description ?: "invalid token")
        return jwt
    }

    companion object {
        private val tokens = ConcurrentHashMap<String, Jwt>()

        fun bearer(
            sub: String,
            email: String,
            emailVerified: Boolean = true,
            aud: String = TEST_CLIENT_ID,
            iss: String = "https://accounts.google.com",
        ): String {
            val token = UUID.randomUUID().toString()
            val now = Instant.now()
            tokens[token] = Jwt.withTokenValue(token)
                .header("alg", "none")
                .subject(sub)
                .issuer(iss)
                .audience(listOf(aud))
                .issuedAt(now)
                .expiresAt(now.plusSeconds(3600))
                .claim("email", email)
                .claim("email_verified", emailVerified)
                .build()
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

@SpringBootTest(
    classes = [MessagePersistenceApplication::class],
    properties = [
        "spring.kafka.listener.auto-startup=false",
        "spring.kafka.bootstrap-servers=localhost:1",
        "kafka-health.enabled=false",
        "google.client-id=$TEST_CLIENT_ID",
        "admin.emails=$ADMIN_EMAIL",
        "LOKI_URL=http://localhost:1",
    ],
)
@AutoConfigureMockMvc
@Import(TestJwtConfig::class)
@Testcontainers(disabledWithoutDocker = true)
abstract class AbstractIntegrationTest {
    /** The listener auto-startup property alone proved unreliable here; replacing the registry guarantees no Kafka consumer is ever created. */
    @MockitoBean
    lateinit var kafkaListenerEndpointRegistry: org.springframework.kafka.config.KafkaListenerEndpointRegistry

    @Autowired
    protected lateinit var jdbc: JdbcTemplate

    @BeforeEach
    fun resetDatabase() {
        // DELETE rather than TRUNCATE: cached contexts keep PgNotificationListener threads reading these tables, and TRUNCATE can deadlock with them.
        listOf("user_ban", "message_result", "app_user", "admin_user").forEach { jdbc.update("DELETE FROM $it") }
        jdbc.update("INSERT INTO admin_user (email, source) VALUES (?, 'ENV')", ADMIN_EMAIL)
    }

    protected fun createUser(sub: String, email: String = "$sub@test.local", handle: String? = null) {
        jdbc.update("INSERT INTO app_user (google_sub, email, handle) VALUES (?, ?, ?)", sub, email, handle)
    }

    protected fun rejected(authorId: String?, eventId: UUID = UUID.randomUUID(), occurredAt: Instant = Instant.now(), text: String = "bad words", score: Double? = 0.9): MessageResult =
        MessageResult.from(
            MessageRejectedEvent(
                eventId = eventId, occurredAt = occurredAt, messageId = UUID.randomUUID(), correlationId = UUID.randomUUID(),
                causationId = UUID.randomUUID(), producer = "test", payload = MessageRejectedPayload(text, "PROFANITY"),
                profanityScore = score, author = authorId?.let { MessageAuthor(it, "h-$it") },
            ),
        )

    protected fun validated(authorId: String?, eventId: UUID = UUID.randomUUID(), occurredAt: Instant = Instant.now(), text: String = "hello"): MessageResult =
        MessageResult.from(
            MessageValidatedEvent(
                eventId = eventId, occurredAt = occurredAt, messageId = UUID.randomUUID(), correlationId = UUID.randomUUID(),
                causationId = UUID.randomUUID(), producer = "test", payload = MessageValidatedPayload(text),
                profanityScore = 0.0, author = authorId?.let { MessageAuthor(it, "h-$it") },
            ),
        )

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun datasource(registry: DynamicPropertyRegistry) {
            val c = SharedPostgres.container
            registry.add("spring.datasource.url") { c.jdbcUrl }
            registry.add("spring.datasource.username") { c.username }
            registry.add("spring.datasource.password") { c.password }
        }
    }
}
