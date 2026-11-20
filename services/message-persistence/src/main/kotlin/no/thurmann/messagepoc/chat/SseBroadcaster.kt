package no.thurmann.messagepoc.chat

import org.slf4j.LoggerFactory
import org.springframework.http.CacheControl
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import java.time.Duration
import java.util.concurrent.CopyOnWriteArraySet

@Component
class SseBroadcaster {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val publicEmitters = CopyOnWriteArraySet<SseEmitter>()
    private val adminEmitters = CopyOnWriteArraySet<SseEmitter>()

    fun subscribePublic(): ResponseEntity<SseEmitter> = subscribe(publicEmitters)

    fun subscribeAdmin(): ResponseEntity<SseEmitter> = subscribe(adminEmitters)

    fun publishPublic(event: PublicChatEvent) = publish(publicEmitters, event.type, event)

    fun publishAdmin(row: AdminModerationRow) = publish(adminEmitters, "moderation", row)

    @Scheduled(fixedRate = 15_000)
    fun ping() {
        (publicEmitters + adminEmitters).forEach { emitter ->
            send(emitter, publicEmitters, adminEmitters) { it.send(SseEmitter.event().comment("ping")) }
        }
    }

    private fun subscribe(registry: MutableSet<SseEmitter>): ResponseEntity<SseEmitter> {
        val emitter = SseEmitter(Duration.ofHours(1).toMillis())
        registry.add(emitter)
        emitter.onCompletion { registry.remove(emitter) }
        emitter.onTimeout { registry.remove(emitter) }
        emitter.onError { registry.remove(emitter) }
        send(emitter, registry) { it.send(SseEmitter.event().comment("connected")) }
        return ResponseEntity.ok()
            .contentType(MediaType.TEXT_EVENT_STREAM)
            .cacheControl(CacheControl.noCache())
            .header("X-Accel-Buffering", "no")
            .body(emitter)
    }

    private fun publish(registry: Set<SseEmitter>, name: String, data: Any) {
        registry.forEach { emitter ->
            send(emitter, registry) { it.send(SseEmitter.event().name(name).data(data, MediaType.APPLICATION_JSON)) }
        }
    }

    private fun send(emitter: SseEmitter, vararg registries: Set<SseEmitter>, action: (SseEmitter) -> Unit) {
        try {
            action(emitter)
        } catch (exception: Exception) {
            logger.debug("Removing SSE emitter after send failure", exception)
            registries.forEach { (it as MutableSet<SseEmitter>).remove(emitter) }
        }
    }
}
