package no.thurmann.messagepoc.validation

import com.sun.net.httpserver.HttpServer
import tools.jackson.databind.json.JsonMapper
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class JevProfanityScorerTest {
    private val objectMapper = JsonMapper.builder().build()
    private val capturedBody = AtomicReference<String>()
    private val capturedAuthorization = AtomicReference<String>()
    private val responseBody = AtomicReference("{}")
    private lateinit var server: HttpServer
    private lateinit var scorer: JevProfanityScorer

    @BeforeTest
    fun startFakeJev() {
        server = HttpServer.create(InetSocketAddress("localhost", 0), 0)
        server.createContext("/v1/systemone") { exchange ->
            capturedBody.set(exchange.requestBody.readBytes().toString(Charsets.UTF_8))
            capturedAuthorization.set(exchange.requestHeaders.getFirst("Authorization"))
            val bytes = responseBody.get().toByteArray(Charsets.UTF_8)
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        scorer = JevProfanityScorer(
            apiKey = "test-key",
            apiUrl = "http://localhost:${server.address.port}/v1/systemone",
            objectMapper = objectMapper,
        )
    }

    @AfterTest
    fun stopFakeJev() {
        server.stop(0)
    }

    @Test
    fun `sends a noul question and returns the yes probability`() {
        val text = "hello there"
        responseBody.set("""{"answers":{"offensive":{"type":"noul","noul":0.83}}}""")

        val score = scorer.score(text)

        assertEquals(0.83, score)
        assertEquals("Bearer test-key", capturedAuthorization.get())

        val body = objectMapper.readTree(capturedBody.get())
        assertEquals("jev-latest", body.path("model").asString())
        assertEquals(text, body.path("state").asString())
        val question = body.path("questions").path("offensive")
        assertEquals("noul", question.path("type").asString())
        assertTrue(question.path("criteria").has("true"))
        assertTrue(question.path("criteria").has("false"))
    }

    @Test
    fun `response without a noul probability is rejected`() {
        responseBody.set("""{"answers":{"offensive":{"type":"score","score":0.5}}}""")

        assertFailsWith<IllegalStateException> { scorer.score("hello") }
    }

    @Test
    fun `out-of-range noul probability is rejected`() {
        responseBody.set("""{"answers":{"offensive":{"type":"noul","noul":1.5}}}""")

        assertFailsWith<IllegalStateException> { scorer.score("hello") }
    }
}
