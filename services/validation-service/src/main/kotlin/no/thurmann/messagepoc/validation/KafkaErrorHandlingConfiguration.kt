package no.thurmann.messagepoc.validation

import no.thurmann.messagepoc.contracts.KafkaTopics
import org.apache.kafka.common.TopicPartition
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.kafka.listener.CommonErrorHandler
import org.springframework.kafka.listener.DefaultErrorHandler
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer
import org.springframework.util.backoff.FixedBackOff

@Configuration
class KafkaErrorHandlingConfiguration {
    @Bean
    fun kafkaErrorHandler(kafkaTemplate: KafkaTemplate<String, Any>): CommonErrorHandler {
        val recoverer = DeadLetterPublishingRecoverer(kafkaTemplate) { record, _ ->
            TopicPartition(KafkaTopics.MESSAGE_SUBMITTED_DLT, record.partition())
        }

        // Two retries after the initial delivery, then publish the failed record to the DLT.
        return DefaultErrorHandler(recoverer, FixedBackOff(1_000L, 2L))
    }
}
