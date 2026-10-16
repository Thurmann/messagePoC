package no.thurmann.messagepoc.audit

import org.springframework.beans.factory.annotation.Value
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets.UTF_8
import java.time.Duration
import java.time.Instant

@RestController
@RequestMapping("/api/audit-logs")
class AuditLogController(
    @Value("\${LOKI_URL:http://localhost:3100}") private val lokiUrl: String,
    private val objectMapper: ObjectMapper,
) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .build()

    @GetMapping
    fun list(): List<AuditLogEntry> {
        val end = Instant.now()
        val start = end.minusSeconds(24 * 60 * 60)

        val query = listOf(
            "query" to "{service=\"message-audit\"} |~ \"Message result received|Received DLT event on type=|Received unsupported message result type=\"",
            "start" to start.toString(),
            "end" to end.toString(),
            "limit" to "50",
            "direction" to "backward",
        ).joinToString("&") { (name, value) ->
            "${name.encodeQueryValue()}=${value.encodeQueryValue()}"
        }
        val request = HttpRequest.newBuilder()
            .uri(URI.create("${lokiUrl.trimEnd('/')}/loki/api/v1/query_range?$query"))
            .timeout(Duration.ofSeconds(8))
            .GET()
            .build()

        val response = try {
            val result = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
            if (result.statusCode() !in 200..299) {
                throw IllegalStateException("Loki returned HTTP ${result.statusCode()}: ${result.body()}")
            }
            objectMapper.readTree(result.body())
        } catch (exception: Exception) {
            logger.warn("Could not fetch message-audit logs from Loki", exception)
            throw ResponseStatusException(HttpStatus.BAD_GATEWAY, "Could not read message-audit logs from Loki", exception)
        }

        return response.path("data").path("result").valueStream()
            .flatMap { stream -> stream.path("values").valueStream() }
            .toList()
            .mapNotNull { toAuditLogEntry(it) }
            .sortedByDescending { it.timestamp }
            .toList()
    }

    private fun toAuditLogEntry(value: JsonNode): AuditLogEntry? {
        if (value.size() < 2) return null

        val timestampNanos = value[0].textValue()?.toLongOrNull() ?: return null
        val timestamp = Instant.ofEpochSecond(0, timestampNanos)
        val logLine = value[1].textValue() ?: return null
        val fields = runCatching { objectMapper.readTree(logLine) }.getOrNull() ?: return null
        val rawMessage = fields.text("message") ?: "Message audit log"
        val legacyDltType = rawMessage
            .takeIf { it.startsWith("Received unsupported message result type=") }
            ?.removePrefix("Received unsupported message result type=")
            ?.takeIf { it == "no.thurmann.messagepoc.contracts.MessageSubmittedEvent" }
        val isDlt = fields.text("result") == "DLT" || legacyDltType != null

        return AuditLogEntry(
            timestamp = timestamp,
            message = if (legacyDltType != null) "Received DLT event on type=$legacyDltType" else rawMessage,
            result = if (isDlt) "DLT" else fields.text("result"),
            text = fields.text("text"),
            messageId = fields.text("messageId"),
            correlationId = fields.text("correlationId"),
            profanityScore = fields.get("profanityScore")?.takeIf(JsonNode::isNumber)?.doubleValue(),
        )
    }

    private fun JsonNode.text(name: String): String? =
        get(name)?.takeUnless(JsonNode::isNull)?.textValue()
}

private fun String.encodeQueryValue(): String = URLEncoder.encode(this, UTF_8)

data class AuditLogEntry(
    val timestamp: Instant,
    val message: String,
    val result: String?,
    val text: String?,
    val messageId: String?,
    val correlationId: String?,
    val profanityScore: Double?,
)
