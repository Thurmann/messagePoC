package no.thurmann.messagepoc.chat

import no.thurmann.messagepoc.audit.MessageResultStatus
import org.postgresql.PGConnection
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.SmartLifecycle
import org.springframework.stereotype.Component
import java.sql.DriverManager
import java.util.UUID

@Component
class PgNotificationListener(
    private val chatQueryService: ChatQueryService,
    private val broadcaster: SseBroadcaster,
    @Value("\${spring.datasource.url}") private val url: String,
    @Value("\${spring.datasource.username}") private val username: String,
    @Value("\${spring.datasource.password}") private val password: String,
) : SmartLifecycle {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Volatile
    private var running = false
    private var thread: Thread? = null

    override fun start() {
        running = true
        thread = Thread(::listenLoop, "pg-notification-listener").apply {
            isDaemon = true
            start()
        }
    }

    override fun stop() {
        running = false
        thread?.interrupt()
        thread?.join(10_000)
        thread = null
    }

    override fun isRunning(): Boolean = running

    private fun listenLoop() {
        var backoffMillis = INITIAL_BACKOFF_MILLIS
        while (running) {
            try {
                DriverManager.getConnection(url, username, password).use { connection ->
                    connection.createStatement().use { it.execute("LISTEN chat_events") }
                    val pgConnection = connection.unwrap(PGConnection::class.java)
                    logger.info("Listening for chat_events notifications")
                    backoffMillis = INITIAL_BACKOFF_MILLIS
                    while (running) {
                        pgConnection.getNotifications(5000)?.forEach { handle(it.parameter) }
                    }
                }
            } catch (_: InterruptedException) {
                return
            } catch (exception: Exception) {
                if (!running) return
                logger.warn("Postgres notification listener failed; retrying in {} ms", backoffMillis, exception)
                try {
                    Thread.sleep(backoffMillis)
                } catch (_: InterruptedException) {
                    return
                }
                backoffMillis = minOf(backoffMillis * 2, MAX_BACKOFF_MILLIS)
            }
        }
    }

    private fun handle(payload: String?) {
        try {
            val messageId = UUID.fromString(payload)
            val results = chatQueryService.byMessageId(messageId)
            results.forEach { broadcaster.publishPublic(ChatEventMapper.publicEvent(it)) }
            val moderated = results.filter { it.status != MessageResultStatus.VALIDATED }
            if (moderated.isNotEmpty()) {
                chatQueryService.adminRows(moderated).forEach(broadcaster::publishAdmin)
            }
        } catch (exception: Exception) {
            logger.warn("Could not handle chat_events notification payload={}", payload, exception)
        }
    }

    private companion object {
        const val INITIAL_BACKOFF_MILLIS = 1_000L
        const val MAX_BACKOFF_MILLIS = 30_000L
    }
}
