package no.thurmann.messagepoc.it

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.put
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class SecurityIT : AbstractIntegrationTest() {
    @Autowired
    lateinit var mvc: MockMvc

    private fun user(sub: String, verified: Boolean = true) = TestJwtDecoder.bearer(sub, "$sub@test.local", verified)
    private fun admin(verified: Boolean = true) = TestJwtDecoder.bearer("admin-sub", ADMIN_EMAIL, verified)

    @Test
    fun `public endpoints are reachable without authentication`() {
        mvc.get("/api/config").andExpect { status { isOk() }; jsonPath("$.googleClientId") { value(TEST_CLIENT_ID) } }
        mvc.get("/api/chat/history").andExpect { status { isOk() } }
        mvc.get("/").andExpect { status { isOk() } }
        mvc.get("/actuator/health").andExpect { status { isOk() } }
    }

    @Test
    fun `index carries a content security policy`() {
        val csp = mvc.get("/").andReturn().response.getHeader("Content-Security-Policy")
        assertTrue(csp != null && csp.contains("default-src 'self'") && csp.contains("object-src 'none'"), "csp=$csp")
    }

    @Test
    fun `me requires a token and upserts the user`() {
        mvc.get("/api/me").andExpect { status { isUnauthorized() } }
        mvc.get("/api/me") { header("Authorization", "Bearer not-a-known-token") }.andExpect { status { isUnauthorized() } }

        mvc.get("/api/me") { header("Authorization", user("sub-1")) }.andExpect {
            status { isOk() }
            jsonPath("$.email") { value("sub-1@test.local") }
            jsonPath("$.isAdmin") { value(false) }
            jsonPath("$.strikes") { value(0) }
        }
        assertEquals("sub-1@test.local", jdbc.queryForObject("SELECT email FROM app_user WHERE google_sub='sub-1'", String::class.java))
    }

    @Test
    fun `token with wrong audience or issuer is rejected`() {
        mvc.get("/api/me") { header("Authorization", TestJwtDecoder.bearer("s", "s@x", aud = "someone-else")) }.andExpect { status { isUnauthorized() } }
        mvc.get("/api/me") { header("Authorization", TestJwtDecoder.bearer("s", "s@x", iss = "https://evil.example")) }.andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `setting the handle validates and rejects case insensitive duplicates`() {
        fun put(auth: String, handle: String) = mvc.put("/api/me/handle") {
            header("Authorization", auth); contentType = MediaType.APPLICATION_JSON; content = """{"handle":"$handle"}"""
        }
        put(user("h1"), "a!").andExpect { status { isBadRequest() } }
        put(user("h1"), "Alice").andExpect { status { isOk() }; jsonPath("$.handle") { value("Alice") } }
        assertEquals("Alice", jdbc.queryForObject("SELECT handle FROM app_user WHERE google_sub='h1'", String::class.java))
        put(user("h2"), "alice").andExpect { status { isConflict() } }
        // handle can only be set once
        put(user("h1"), "Other").andExpect { status { isConflict() } }
    }

    @Test
    fun `admin endpoints enforce authentication role and verified email`() {
        for (path in listOf("/api/admin/moderation-log", "/api/audit-logs")) {
            mvc.get(path).andExpect { status { isUnauthorized() } }
            mvc.get(path) { header("Authorization", user("plain")) }.andExpect { status { isForbidden() } }
            mvc.get(path) { header("Authorization", admin(verified = false)) }.andExpect { status { isForbidden() } }
        }
        mvc.get("/api/admin/moderation-log") { header("Authorization", admin()) }.andExpect { status { isOk() } }
        val code = mvc.get("/api/audit-logs") { header("Authorization", admin()) }.andReturn().response.status
        assertTrue(code == 200 || code == 502, "audit-logs status $code")
    }

    @Test
    fun `unknown paths are denied`() {
        for (auth in listOf(null, admin())) {
            val status = mvc.get("/api/does-not-exist") { auth?.let { header("Authorization", it) } }.andReturn().response.status
            assertNotEquals(200, status)
            assertTrue(status in listOf(401, 403, 404), "status $status")
        }
    }

    @Test
    fun `public history hides rejected text while admin moderation log exposes it`() {
        createUser("u1", handle = "alice")
        val ok = validated("u1", text = "hello world", occurredAt = Instant.now().minusSeconds(10))
        val bad = rejected("u1", text = "SECRET-PROFANE-TEXT")
        jdbc.update("INSERT INTO message_result (event_id,event_type,event_version,occurred_at,message_id,correlation_id,producer,status,text,reason,author_id,author_handle) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            bad.eventId, bad.eventType, 1, java.sql.Timestamp.from(bad.occurredAt), bad.messageId, bad.correlationId, "t", "REJECTED", bad.text, "PROFANITY", "u1", "alice")
        jdbc.update("INSERT INTO message_result (event_id,event_type,event_version,occurred_at,message_id,correlation_id,producer,status,text,author_id,author_handle) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ok.eventId, ok.eventType, 1, java.sql.Timestamp.from(ok.occurredAt), ok.messageId, ok.correlationId, "t", "VALIDATED", ok.text, "u1", "alice")

        val history = mvc.get("/api/chat/history").andExpect { status { isOk() } }.andReturn().response.contentAsString
        assertFalse(history.contains("SECRET-PROFANE-TEXT"), history)
        assertFalse(history.contains("PROFANITY"), history)
        assertTrue(history.contains("hello world"))
        mvc.get("/api/chat/history").andExpect {
            jsonPath("$.length()") { value(2) }
            jsonPath("$[0].type") { value("message") }
            jsonPath("$[1].type") { value("removed") }
            jsonPath("$[1].messageId") { value(bad.messageId.toString()) }
            jsonPath("$[1].text") { doesNotExist() }
        }

        mvc.get("/api/admin/moderation-log") { header("Authorization", admin()) }.andExpect {
            status { isOk() }
            jsonPath("$.length()") { value(1) }
            jsonPath("$[0].text") { value("SECRET-PROFANE-TEXT") }
            jsonPath("$[0].status") { value("REJECTED") }
        }
    }

    @Test
    fun `me reports ban and warning state`() {
        createUser("sub-2", email = "sub-2@test.local", handle = "bob")
        UUID.randomUUID()
        repeat(3) { jdbc.update("INSERT INTO message_result (event_id,event_type,event_version,occurred_at,message_id,correlation_id,producer,status,text,author_id,strike) VALUES (?,?,?,now(),?,?,?,?,?,?,true)",
            UUID.randomUUID(), "T", 1, UUID.randomUUID(), UUID.randomUUID(), "t", "REJECTED", "x", "sub-2") }
        mvc.get("/api/me") { header("Authorization", user("sub-2")) }.andExpect {
            status { isOk() }
            jsonPath("$.strikes") { value(3) }
            jsonPath("$.warning") { value(true) }
            jsonPath("$.ban") { doesNotExist() }
        }
    }
}
