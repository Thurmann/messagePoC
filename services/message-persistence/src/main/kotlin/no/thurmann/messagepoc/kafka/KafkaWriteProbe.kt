package no.thurmann.messagepoc.kafka

import jakarta.annotation.PreDestroy
import no.thurmann.messagepoc.chat.SseBroadcaster
import org.apache.kafka.clients.admin.Admin
import org.apache.kafka.clients.admin.AdminClientConfig
import org.apache.kafka.clients.admin.NewTopic
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.Producer
import org.apache.kafka.clients.producer.ProducerConfig
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.common.errors.TopicExistsException
import org.apache.kafka.common.serialization.StringSerializer
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.kafka.autoconfigure.KafkaProperties
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import java.time.Instant
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * Periodically produces one tiny acks=all record to a health topic. A real write is the only reliable signal that
 * Kafka accepts writes: metadata (describeCluster, ISR) can be stale when the KRaft controller quorum is lost.
 */
@Component
@ConditionalOnProperty(prefix = "kafka-health", name = ["enabled"], havingValue = "true", matchIfMissing = true)
class KafkaWriteProbe internal constructor(
    private val props: KafkaHealthProperties,
    private val broadcaster: SseBroadcaster,
    private val producer: Producer<String, String>,
    private val adminFactory: () -> Admin,
) {
    @Autowired
    constructor(kafkaProperties: KafkaProperties, props: KafkaHealthProperties, broadcaster: SseBroadcaster) :
        this(props, broadcaster, buildProducer(kafkaProperties, props), { buildAdmin(kafkaProperties, props) })

    private val logger = LoggerFactory.getLogger(javaClass)
    private val state = KafkaHealthState(props.failuresBeforeDown)

    @Volatile
    private var topicEnsured = false

    fun view(): KafkaStatusView = state.view()

    @Scheduled(
        fixedDelayString = "\${kafka-health.interval:10s}",
        initialDelayString = "\${kafka-health.initial-delay:5s}",
    )
    fun probe() {
        try {
            if (!topicEnsured) ensureTopic()
            producer.send(ProducerRecord(props.topic, "probe", Instant.now().toString()))
                .get(props.timeout.toMillis() + 1000, TimeUnit.MILLISECONDS)
            onResult(state.recordSuccess(Instant.now()), null)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            onResult(state.recordFailure(Instant.now(), "interrupted"), "interrupted")
        } catch (e: Exception) {
            val cause = if (e is ExecutionException && e.cause != null) e.cause!! else e
            val reason = "${cause.javaClass.simpleName}: ${cause.message}"
            onResult(state.recordFailure(Instant.now(), reason), reason)
        }
    }

    private fun onResult(changed: Boolean, reason: String?) {
        val view = state.view()
        if (changed) {
            logger.warn("Kafka write status is now {}{}", view.status, reason?.let { " ($it)" } ?: "")
            try {
                broadcaster.publishKafkaStatus(view)
            } catch (e: Exception) {
                logger.debug("Could not publish Kafka status", e)
            }
        } else if (reason != null) {
            logger.debug("Kafka write probe failed: {}", reason)
        }
    }

    private fun ensureTopic() {
        val admin = adminFactory()
        try {
            val topic = NewTopic(props.topic, 1, props.replicationFactor).configs(
                mapOf(
                    "min.insync.replicas" to props.minInsyncReplicas.toString(),
                    "retention.ms" to "3600000",
                    "cleanup.policy" to "delete",
                ),
            )
            try {
                admin.createTopics(listOf(topic)).all().get(props.timeout.toMillis(), TimeUnit.MILLISECONDS)
            } catch (e: ExecutionException) {
                if (e.cause !is TopicExistsException) throw e
            }
            topicEnsured = true
        } finally {
            try {
                admin.close(java.time.Duration.ofSeconds(1))
            } catch (_: Exception) {
            }
        }
    }

    @PreDestroy
    fun close() {
        try {
            producer.close(java.time.Duration.ofSeconds(1))
        } catch (e: Exception) {
            logger.debug("Error closing health producer", e)
        }
    }

    private companion object {
        fun buildProducer(kafkaProperties: KafkaProperties, props: KafkaHealthProperties): Producer<String, String> {
            val timeoutMs = props.timeout.toMillis().toInt()
            val config = kafkaProperties.buildProducerProperties().toMutableMap<String, Any?>()
            config[ProducerConfig.ACKS_CONFIG] = "all"
            config[ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG] = false
            config[ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG] = timeoutMs
            config[ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG] = maxOf(1000, timeoutMs - 1000)
            config[ProducerConfig.LINGER_MS_CONFIG] = 0
            config[ProducerConfig.MAX_BLOCK_MS_CONFIG] = timeoutMs
            config[ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG] = StringSerializer::class.java
            config[ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG] = StringSerializer::class.java
            // delivery.timeout.ms must be >= linger.ms + request.timeout.ms
            if (timeoutMs < config[ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG] as Int) {
                config[ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG] = config[ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG]!!
            }
            config.remove(ProducerConfig.TRANSACTIONAL_ID_CONFIG)
            return KafkaProducer(config)
        }

        fun buildAdmin(kafkaProperties: KafkaProperties, props: KafkaHealthProperties): Admin {
            val timeoutMs = props.timeout.toMillis().toInt()
            val config = kafkaProperties.buildAdminProperties().toMutableMap()
            config[AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG] = timeoutMs
            config[AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG] = timeoutMs
            return Admin.create(config)
        }
    }
}
