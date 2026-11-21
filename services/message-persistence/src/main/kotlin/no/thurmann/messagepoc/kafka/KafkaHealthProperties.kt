package no.thurmann.messagepoc.kafka

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties("kafka-health")
data class KafkaHealthProperties(
    val enabled: Boolean = true,
    val interval: Duration = Duration.ofSeconds(10),
    val timeout: Duration = Duration.ofSeconds(5),
    val topic: String = "poc.health.v1",
    val replicationFactor: Short = 3,
    val minInsyncReplicas: Int = 2,
    val failuresBeforeDown: Int = 2,
)
