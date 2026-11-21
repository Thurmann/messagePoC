package no.thurmann.messagepoc.chat

import jakarta.annotation.PreDestroy
import org.slf4j.LoggerFactory
import org.springframework.http.CacheControl
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import java.time.Duration
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Fans events out to SSE clients. Sends never run on the caller's thread: each subscriber has its own
 * serial queue drained on a shared executor, so a stalled client only delays itself.
 */
@Component
class SseBroadcaster {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val publicSubscribers = CopyOnWriteArraySet<Subscriber>()
    private val adminSubscribers = CopyOnWriteArraySet<Subscriber>()
    private val threadCounter = AtomicInteger()
    private val executor = Executors.newCachedThreadPool(
        ThreadFactory { runnable ->
            Thread(runnable, "sse-fanout-${threadCounter.incrementAndGet()}").apply { isDaemon = true }
        },
    )

    private inner class Subscriber(val emitter: SseEmitter, private val registry: MutableSet<Subscriber>) {
        private val queue = ConcurrentLinkedQueue<(SseEmitter) -> Unit>()
        private val draining = AtomicBoolean(false)
        private val size = AtomicInteger()

        @Volatile
        var closed = false

        fun enqueue(action: (SseEmitter) -> Unit) {
            if (closed) return
            if (size.incrementAndGet() > MAX_QUEUED_EVENTS) {
                logger.debug("Dropping SSE emitter with a full send queue")
                fail(null)
                return
            }
            queue.add(action)
            scheduleDrain()
        }

        private fun scheduleDrain() {
            if (!draining.compareAndSet(false, true)) return
            try {
                executor.execute(::drain)
            } catch (exception: Exception) {
                draining.set(false)
                fail(exception)
            }
        }

        private fun drain() {
            try {
                while (!closed) {
                    val action = queue.poll() ?: break
                    size.decrementAndGet()
                    action(emitter)
                }
            } catch (exception: Exception) {
                fail(exception)
            } finally {
                draining.set(false)
                if (!closed && queue.isNotEmpty()) scheduleDrain()
            }
        }

        fun fail(exception: Exception?) {
            if (exception != null) logger.debug("Removing SSE emitter after send failure", exception)
            closed = true
            queue.clear()
            registry.remove(this)
            try {
                emitter.complete()
            } catch (_: Exception) {
                // already completed
            }
        }
    }

    fun subscribePublic(): ResponseEntity<SseEmitter> = subscribe(publicSubscribers)

    fun subscribeAdmin(): ResponseEntity<SseEmitter> = subscribe(adminSubscribers)

    fun publishPublic(event: PublicChatEvent) = publish(publicSubscribers, event.type, event)

    fun publishAdmin(row: AdminModerationRow) = publish(adminSubscribers, "moderation", row)

    fun publishKafkaStatus(status: no.thurmann.messagepoc.kafka.KafkaStatusView) = publish(publicSubscribers, "kafka", status)

    /** Tells every client to reload state it may have missed (e.g. after the notification listener reconnected). */
    fun publishResync() {
        publish(publicSubscribers, "resync", emptyMap<String, String>())
        publish(adminSubscribers, "resync", emptyMap<String, String>())
    }

    @Scheduled(fixedRate = 15_000)
    fun ping() {
        (publicSubscribers + adminSubscribers).forEach { it.enqueue { emitter -> emitter.send(SseEmitter.event().comment("ping")) } }
    }

    @PreDestroy
    fun shutdown() {
        executor.shutdownNow()
        (publicSubscribers + adminSubscribers).forEach { it.closed = true }
        publicSubscribers.clear()
        adminSubscribers.clear()
    }

    private fun subscribe(registry: MutableSet<Subscriber>): ResponseEntity<SseEmitter> {
        val emitter = SseEmitter(Duration.ofHours(1).toMillis())
        val subscriber = Subscriber(emitter, registry)
        registry.add(subscriber)
        emitter.onCompletion { subscriber.closed = true; registry.remove(subscriber) }
        emitter.onTimeout { subscriber.closed = true; registry.remove(subscriber) }
        emitter.onError { subscriber.closed = true; registry.remove(subscriber) }
        subscriber.enqueue { it.send(SseEmitter.event().comment("connected")) }
        return ResponseEntity.ok()
            .contentType(MediaType.TEXT_EVENT_STREAM)
            .cacheControl(CacheControl.noCache())
            .header("X-Accel-Buffering", "no")
            .body(emitter)
    }

    private fun publish(registry: Set<Subscriber>, name: String, data: Any) {
        registry.forEach { subscriber ->
            subscriber.enqueue { it.send(SseEmitter.event().name(name).data(data, MediaType.APPLICATION_JSON)) }
        }
    }

    private companion object {
        const val MAX_QUEUED_EVENTS = 1_000
    }
}
