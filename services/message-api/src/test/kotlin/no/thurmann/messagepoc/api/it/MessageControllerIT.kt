package no.thurmann.messagepoc.api.it

import no.thurmann.messagepoc.api.JdbcUserStatusLookup
import no.thurmann.messagepoc.api.UserStatusLookup
import no.thurmann.messagepoc.contracts.KafkaTopics
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.clients.producer.RecordMetadata
import org.apache.kafka.common.TopicPartition
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentCaptor
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.never
import org.mockito.Mockito.reset
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.Mockito.`when`
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.dao.QueryTimeoutException
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.kafka.support.SendResult
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.options
import org.springframework.test.web.servlet.post
import org.testcontainers.junit.jupiter.Testcontainers
import tools.jackson.databind.json.JsonMapper
import java.sql.Timestamp
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CompletableFuture
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@SpringBootTest(
    classes = [no.thurmann.messagepoc.api.MessageApiApplication::class],
    properties = [
        "spring.kafka.bootstrap-servers=localhost:1",
        "google.client-id=$TEST_CLIENT_ID",
        "cors.allowed-origins=http://localhost:8083",
    ],
)
@AutoConfigureMockMvc
@Import(TestJwtConfig::class)
@Testcontainers(disabledWithoutDocker = true)
class MessageControllerIT {
    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var jdbc: JdbcTemplate

    /** Nothing is ever sent to a real broker. */
    @MockitoBean lateinit var kafka: KafkaTemplate<String, Any>

    /** Delegates to the real JDBC lookup by default; replaced per test to simulate failures. */
    @MockitoBean lateinit var mockLookup: UserStatusLookup

    private lateinit var realLookup: JdbcUserStatusLookup

    private val adminEmail = "admin@test.local"
    private val mapper = JsonMapper.builder().build()

    @BeforeEach
    fun setUp() {
        reset(kafka, mockLookup)
        realLookup = JdbcUserStatusLookup(jdbc)
        listOf("user_ban", "message_result", "app_user", "admin_user").forEach { jdbc.update("DELETE FROM $it") }
        jdbc.update("INSERT INTO admin_user (email, source) VALUES (?, 'ENV')", adminEmail)
        `when`(mockLookup.find(anyString(), anyInstant())).thenAnswer { realLookup.find(it.getArgument(0), it.getArgument(1)) }
        val metadata = RecordMetadata(TopicPartition(KafkaTopics.MESSAGE_SUBMITTED, 0), 0, 0, 0L, 0, 0)
        val record = ProducerRecord<String, Any>(KafkaTopics.MESSAGE_SUBMITTED, "k", "v")
        `when`(kafka.send(anyString(), anyString(), any()))
            .thenReturn(CompletableFuture.completedFuture(SendResult(record, metadata)))
    }

    private fun user(sub: String, email: String = "$sub@test.local", handle: String? = null) {
        jdbc.update("INSERT INTO app_user (google_sub, email, handle) VALUES (?, ?, ?)", sub, email, handle)
    }

    private fun activeBan(sub: String) {
        jdbc.update(
            "INSERT INTO user_ban (user_id, step, starts_at, ends_at) VALUES (?, 1, ?, ?)",
            sub, Timestamp.from(Instant.now().minusSeconds(60)), Timestamp.from(Instant.now().plusSeconds(600)),
        )
    }

    private fun post(auth: String?, text: String, correlation: String? = null) =
        mvc.post("/api/messages") {
            auth?.let { header("Authorization", it) }
            correlation?.let { header("X-Correlation-Id", it) }
            contentType = MediaType.APPLICATION_JSON
            content = """{"text":${mapper.writeValueAsString(text)}}"""
        }

    private fun bearer(sub: String, email: String = "$sub@test.local") = TestJwtDecoder.bearer(sub, email)

    @Test
    fun `no token is 401`() {
        post(null, "hi").andExpect { status { isUnauthorized() } }
        verifyNoInteractions(kafka)
    }

    @Test
    fun `wrong audience is 401`() {
        user("u1", handle = "alice")
        post(TestJwtDecoder.bearer("u1", "u1@test.local", aud = "other"), "hi").andExpect { status { isUnauthorized() } }
        verifyNoInteractions(kafka)
    }

    @Test
    fun `user without handle is 409`() {
        user("u1")
        post(bearer("u1"), "hi").andExpect {
            status { isConflict() }
            jsonPath("$.error") { value("HANDLE_REQUIRED") }
        }
        verifyNoInteractions(kafka)
    }

    @Test
    fun `unknown user is 409`() {
        post(bearer("ghost"), "hi").andExpect { status { isConflict() }; jsonPath("$.error") { value("HANDLE_REQUIRED") } }
    }

    @Test
    fun `active ban is 403 with retry-after`() {
        user("u1", handle = "alice")
        activeBan("u1")
        val res = post(bearer("u1"), "hi").andExpect {
            status { isForbidden() }
            jsonPath("$.error") { value("BANNED") }
            jsonPath("$.bannedUntil") { exists() }
            jsonPath("$.remainingSeconds") { exists() }
        }.andReturn().response
        val retry = res.getHeader("Retry-After")!!.toLong()
        assertTrue(retry in 1..600, "retry=$retry")
        verifyNoInteractions(kafka)
    }

    @Test
    fun `admin with active ban can still post`() {
        user("a1", email = "Admin@Test.Local", handle = "boss")
        activeBan("a1")
        post(bearer("a1", "Admin@Test.Local"), "hi").andExpect { status { isAccepted() } }
    }

    @Test
    fun `allowed user gets 202 and event is published`() {
        user("u1", handle = "alice")
        val corr = UUID.randomUUID()
        val body = post(bearer("u1"), "  hello world  ", corr.toString()).andExpect {
            status { isAccepted() }
            jsonPath("$.messageId") { exists() }
            jsonPath("$.correlationId") { value(corr.toString()) }
            jsonPath("$.status") { value("PENDING") }
        }.andReturn().response.contentAsString
        val messageId = Regex("\"messageId\":\"([^\"]+)\"").find(body)!!.groupValues[1]

        val topic = ArgumentCaptor.forClass(String::class.java)
        val key = ArgumentCaptor.forClass(String::class.java)
        val value = ArgumentCaptor.forClass(Any::class.java)
        verify(kafka).send(topic.capture(), key.capture(), value.capture())
        assertEquals("poc.messages.submitted.v1", topic.value)
        assertEquals(messageId, key.value)
        val event = value.value as MessageSubmittedEvent
        assertEquals(messageId, event.messageId.toString())
        assertEquals(corr, event.correlationId)
        assertEquals("u1", event.author?.userId)
        assertEquals("alice", event.author?.handle)
        assertEquals("hello world", event.payload.text)
    }

    @Test
    fun `invalid correlation id is replaced by a generated one`() {
        user("u1", handle = "alice")
        post(bearer("u1"), "hi", "not-a-uuid").andExpect {
            status { isAccepted() }
            jsonPath("$.correlationId") { exists() }
        }
    }

    @Test
    fun `text validation`() {
        user("u1", handle = "alice")
        post(bearer("u1"), "   ").andExpect { status { isBadRequest() } }
        post(bearer("u1"), "").andExpect { status { isBadRequest() } }
        post(bearer("u1"), "a".repeat(501)).andExpect { status { isBadRequest() } }
        verifyNoInteractions(kafka)
        post(bearer("u1"), "a".repeat(500)).andExpect { status { isAccepted() } }
    }

    @Test
    fun `database failure is 503`() {
        `when`(mockLookup.find(anyString(), anyInstant())).thenThrow(QueryTimeoutException("db down"))
        post(bearer("u1"), "hi").andExpect {
            status { isServiceUnavailable() }
            jsonPath("$.error") { value("UNAVAILABLE") }
        }
        verify(kafka, never()).send(anyString(), anyString(), any())
    }

    @Test
    fun `cors preflight allows configured origin only`() {
        mvc.options("/api/messages") {
            header("Origin", "http://localhost:8083")
            header("Access-Control-Request-Method", "POST")
            header("Access-Control-Request-Headers", "Authorization, Content-Type")
        }.andExpect {
            status { isOk() }
            header { string("Access-Control-Allow-Origin", "http://localhost:8083") }
        }
        val evil = mvc.options("/api/messages") {
            header("Origin", "http://evil.example")
            header("Access-Control-Request-Method", "POST")
            header("Access-Control-Request-Headers", "Authorization, Content-Type")
        }.andReturn().response
        assertNull(evil.getHeader("Access-Control-Allow-Origin"))
        assertTrue(evil.status >= 400, "status=${evil.status}")
    }

    @Test
    fun `everything else is denied but health is public`() {
        val auth = bearer("u1")
        for (path in listOf("/api/messages", "/api/other", "/", "/actuator/info")) {
            for (a in listOf<String?>(null, auth)) {
                val status = mvc.get(path) { a?.let { header("Authorization", it) } }.andReturn().response.status
                assertTrue(status !in 200..299, "$path auth=${a != null} -> $status")
            }
        }
        mvc.get("/actuator/health").andExpect { status { isOk() } }
    }

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

/** Kotlin-safe matcher: registers any(Instant) and returns a non-null placeholder. */
private fun anyInstant(): Instant {
    any(Instant::class.java)
    return Instant.EPOCH
}
