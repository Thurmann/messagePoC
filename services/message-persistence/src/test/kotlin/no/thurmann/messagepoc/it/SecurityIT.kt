package no.thurmann.messagepoc.it

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.put
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SecurityIT : AbstractIntegrationTest() {
    @Autowired
    lateinit var mvc: MockMvc

    private fun user(sub: String, verified: Boolean = true) = TestJwtDecoder.bearer(sub, "$sub@test.local", verified)
    private fun admin(verified: Boolean = true) = TestJwtDecoder.bearer("admin-sub", ADMIN_EMAIL, verified)

    @Test
    fun `public endpoints are reachable without authentication`() {
        mvc.get("/api/config").andExpect { status { isOk() }; jsonPath("$.googleClientId") { value(TEST_CLIENT_ID) }; jsonPath("$.version") { isNotEmpty() } }
        mvc.get("/api/chat/history").andExpect { status { isOk() } }
        mvc.get("/api/chat/kafka-status").andExpect { status { isOk() }; jsonPath("$.status") { value("UNKNOWN") } }
        mvc.get("/").andExpect { status { isOk() } }
        mvc.get("/js/theme.js").andExpect { status { isOk() } }
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

    private fun presence(auth: String) = mvc.post("/api/me/presence") { header("Authorization", auth) }

    private fun online(auth: String) = mvc.get("/api/users/online") { header("Authorization", auth) }

    private fun setHandle(auth: String, handle: String) {
        mvc.put("/api/me/handle") { header("Authorization", auth); contentType = MediaType.APPLICATION_JSON; content = """{"handle":"$handle"}""" }
            .andExpect { status { isOk() } }
    }

    /** Registers the user like the frontend does: GET /api/me, pick a handle, then heartbeat. */
    private fun signIn(sub: String, handle: String, auth: String = user(sub)) {
        mvc.get("/api/me") { header("Authorization", auth) }.andExpect { status { isOk() } }
        setHandle(auth, handle)
        presence(auth).andExpect { status { isOk() } }
    }

    @Test
    fun `online users requires authentication`() {
        mvc.get("/api/users/online").andExpect { status { isUnauthorized() } }
        mvc.post("/api/me/presence").andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `a user with a handle who sent presence is listed without admin fields for plain callers`() {
        signIn("p1", "Alice")
        signIn("p2", "bob")
        mvc.get("/api/me") { header("Authorization", user("p3")) }.andExpect { status { isOk() } }
        presence(user("p3")).andExpect { status { isOk() } }

        val body = online(user("p2")).andExpect {
            status { isOk() }
            jsonPath("$.length()") { value(2) }
            jsonPath("$[0].handle") { value("Alice") }
            jsonPath("$[1].handle") { value("bob") }
            jsonPath("$[0].isAdmin") { doesNotExist() }
            jsonPath("$[0].bannedUntil") { doesNotExist() }
        }.andReturn().response.contentAsString
        assertFalse(body.contains("isAdmin") || body.contains("bannedUntil"), body)
    }

    @Test
    fun `admin sees isAdmin and bannedUntil for online users`() {
        signIn("p1", "alice")
        signIn("admin-sub", "boss", admin())
        mvc.post("/api/admin/users/ban") {
            header("Authorization", admin()); contentType = MediaType.APPLICATION_JSON; content = """{"handle":"alice"}"""
        }.andExpect { status { isOk() } }

        online(admin()).andExpect {
            status { isOk() }
            jsonPath("$[0].handle") { value("alice") }
            jsonPath("$[0].isAdmin") { value(false) }
            jsonPath("$[0].bannedUntil") { exists() }
            jsonPath("$[1].handle") { value("boss") }
            jsonPath("$[1].isAdmin") { value(true) }
            jsonPath("$[1].bannedUntil") { doesNotExist() }
        }
    }

    @Test
    fun `stale users are not listed and leaving removes a user`() {
        signIn("p1", "alice")
        signIn("p2", "bob")
        signIn("p3", "carol")
        jdbc.update("UPDATE app_user SET last_seen_at = now() - interval '10 minutes' WHERE google_sub = 'p1'")

        online(user("p2")).andExpect { jsonPath("$.length()") { value(2) }; jsonPath("$[0].handle") { value("bob") } }

        mvc.delete("/api/me/presence") { header("Authorization", user("p2")) }.andExpect { status { isNoContent() } }
        assertNull(jdbc.queryForObject("SELECT last_seen_at FROM app_user WHERE google_sub = 'p2'", java.sql.Timestamp::class.java))
        online(user("p3")).andExpect { jsonPath("$.length()") { value(1) }; jsonPath("$[0].handle") { value("carol") } }
    }

    @Test
    fun `presence for a user without an app_user row is 404`() {
        presence(user("ghost")).andExpect { status { isNotFound() }; jsonPath("$.error") { value("UNKNOWN_USER") } }
    }

    @Test
    fun `presence returns null ban for a user that is not banned`() {
        mvc.get("/api/me") { header("Authorization", user("p1")) }
        presence(user("p1")).andExpect { status { isOk() }; jsonPath("$.ban") { doesNotExist() } }
    }

    @Test
    fun `manual ban endpoint enforces authentication and role`() {
        fun ban(auth: String?, body: String) = mvc.post("/api/admin/users/ban") {
            auth?.let { header("Authorization", it) }; contentType = MediaType.APPLICATION_JSON; content = body
        }
        ban(null, """{"handle":"alice"}""").andExpect { status { isUnauthorized() } }
        ban(user("plain"), """{"handle":"alice"}""").andExpect { status { isForbidden() } }
        ban(admin(), """{"handle":"a!"}""").andExpect { status { isBadRequest() }; jsonPath("$.error") { value("INVALID_HANDLE") } }
        ban(admin(), "{}").andExpect { status { isBadRequest() } }
        ban(admin(), """{"handle":"nobody"}""").andExpect { status { isNotFound() }; jsonPath("$.error") { value("UNKNOWN_HANDLE") } }

        signIn("p1", "alice")
        ban(admin(), """{"handle":"ALICE"}""").andExpect {
            status { isOk() }
            jsonPath("$.handle") { value("alice") }
            jsonPath("$.step") { value(0) }
            jsonPath("$.until") { exists() }
            jsonPath("$.remainingSeconds") { isNumber() }
        }
        ban(admin(), """{"handle":"alice"}""").andExpect {
            status { isConflict() }
            jsonPath("$.error") { value("ALREADY_BANNED") }
            jsonPath("$.until") { exists() }
        }
        assertEquals(ADMIN_EMAIL, jdbc.queryForObject("SELECT banned_by FROM user_ban", String::class.java))

        signIn("admin-sub", "boss", admin())
        ban(admin(), """{"handle":"boss"}""").andExpect { status { isConflict() }; jsonPath("$.error") { value("CANNOT_BAN_ADMIN") } }
    }

    @Test
    fun `a banned user sees the ban from presence and me`() {
        signIn("p1", "alice")
        mvc.post("/api/admin/users/ban") {
            header("Authorization", admin()); contentType = MediaType.APPLICATION_JSON; content = """{"handle":"alice"}"""
        }.andExpect { status { isOk() } }

        presence(user("p1")).andExpect { status { isOk() }; jsonPath("$.ban.until") { exists() }; jsonPath("$.ban.remainingSeconds") { isNumber() } }
        mvc.get("/api/me") { header("Authorization", user("p1")) }.andExpect { status { isOk() }; jsonPath("$.ban.until") { exists() } }
    }
}
