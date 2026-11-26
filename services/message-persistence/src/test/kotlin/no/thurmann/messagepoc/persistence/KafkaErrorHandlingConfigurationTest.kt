package no.thurmann.messagepoc.persistence

import no.thurmann.messagepoc.contracts.KafkaTopics
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.common.TopicPartition
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class KafkaErrorHandlingConfigurationTest {
    @Test
    fun `results records go to the results DLT on the same partition`() {
        val record = ConsumerRecord<String, Any>(KafkaTopics.MESSAGE_RESULTS, 2, 10L, "key", "value")

        assertEquals(TopicPartition(KafkaTopics.MESSAGE_RESULTS_DLT, 2), resultsDltDestination(record))
    }

    @Test
    fun `submitted DLT records are not republished`() {
        val record = ConsumerRecord<String, Any>(KafkaTopics.MESSAGE_SUBMITTED_DLT, 0, 1L, "key", "value")

        assertNull(resultsDltDestination(record))
    }
}
