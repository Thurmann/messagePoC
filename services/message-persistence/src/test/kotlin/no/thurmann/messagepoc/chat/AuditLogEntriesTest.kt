package no.thurmann.messagepoc.chat

import tools.jackson.databind.json.JsonMapper
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class AuditLogEntriesTest {
    private val mapper = JsonMapper.builder().build()

    private fun lokiResponse(vararg streams: List<List<String>>): String {
        val result = streams.joinToString(",") { values ->
            val encoded = values.joinToString(",") { pair -> pair.joinToString(",", "[", "]") { mapper.writeValueAsString(it) } }
            """{"stream":{"service":"message-audit"},"values":[$encoded]}"""
        }
        return """{"status":"success","data":{"resultType":"streams","result":[$result]}}"""
    }

    private fun parse(vararg streams: List<List<String>>) =
        parseAuditLogEntries(mapper.readTree(lokiResponse(*streams)), mapper)

    private val receivedLine = """
        {"message":"Message result received","result":"REJECTED","text":"bad words","messageId":"m-1",
         "correlationId":"c-1","profanityScore":0.75}
    """.trimIndent().replace("\n", "")

    @Test
    fun `received line maps its fields`() {
        val entries = parse(listOf(listOf("1767225600000000000", receivedLine)))

        assertEquals(
            listOf(
                AuditLogEntry(
                    timestamp = Instant.parse("2026-01-01T00:00:00Z"),
                    message = "Message result received",
                    result = "REJECTED",
                    text = "bad words",
                    messageId = "m-1",
                    correlationId = "c-1",
                    profanityScore = 0.75,
                ),
            ),
            entries,
        )
    }

    @Test
    fun `legacy unsupported type line is reported as a DLT event`() {
        val line = """{"message":"Received unsupported message result type=no.thurmann.messagepoc.contracts.MessageSubmittedEvent"}"""

        val entry = parse(listOf(listOf("1767225600000000000", line))).single()

        assertEquals("DLT", entry.result)
        assertEquals("Received DLT event on type=no.thurmann.messagepoc.contracts.MessageSubmittedEvent", entry.message)
    }

    @Test
    fun `non JSON lines and short values are skipped`() {
        val response = mapper.readTree(
            """{"data":{"result":[{"values":[["1767225600000000000","not json"],["1767225600000000000"],["1767225600000000000",${mapper.writeValueAsString(receivedLine)}]]}]}}""",
        )

        val entries = parseAuditLogEntries(response, mapper)

        assertEquals(listOf("m-1"), entries.map { it.messageId })
    }

    @Test
    fun `entries from several streams are sorted newest first`() {
        fun line(id: String) = """{"message":"Message result received","result":"VALIDATED","messageId":"$id"}"""

        val entries = parse(
            listOf(listOf("1767225600000000000", line("old")), listOf("1767225800000000000", line("newest"))),
            listOf(listOf("1767225700000000000", line("middle"))),
        )

        assertEquals(listOf("newest", "middle", "old"), entries.map { it.messageId })
    }
}
