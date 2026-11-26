package no.thurmann.messagepoc.persistence

import no.thurmann.messagepoc.contracts.KafkaTopics
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.common.TopicPartition
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.kafka.listener.CommonErrorHandler
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer
import org.springframework.kafka.listener.DefaultErrorHandler
import org.springframework.util.backoff.FixedBackOff

/**
 * Failed records from the results topic go to the results DLT (same partition as the source).
 * Failed records from any other topic (the submitted DLT) are not republished: they are logged
 * and skipped after the retries, so a poisoned DLT record can never loop back into a DLT.
 */
fun resultsDltDestination(record: ConsumerRecord<*, *>): TopicPartition? =
    if (record.topic() == KafkaTopics.MESSAGE_RESULTS) {
        TopicPartition(KafkaTopics.MESSAGE_RESULTS_DLT, record.partition())
    } else {
        null
    }

@Configuration
class KafkaErrorHandlingConfiguration {
    @Bean
    fun kafkaErrorHandler(kafkaTemplate: KafkaTemplate<String, Any>): CommonErrorHandler {
        val recoverer = DeadLetterPublishingRecoverer(kafkaTemplate) { record, _ -> resultsDltDestination(record) }

        // Two retries after the initial delivery, then publish the failed record to the results DLT.
        return DefaultErrorHandler(recoverer, FixedBackOff(1_000L, 2L))
    }
}
