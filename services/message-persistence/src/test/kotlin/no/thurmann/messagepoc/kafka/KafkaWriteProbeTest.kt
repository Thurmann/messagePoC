package no.thurmann.messagepoc.kafka

import no.thurmann.messagepoc.chat.SseBroadcaster
import org.apache.kafka.clients.admin.Admin
import org.apache.kafka.clients.admin.CreateTopicsResult
import org.apache.kafka.clients.producer.MockProducer
import org.apache.kafka.common.KafkaFuture
import org.apache.kafka.common.errors.TopicExistsException
import org.apache.kafka.common.serialization.StringSerializer
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import kotlin.test.assertEquals

class KafkaWriteProbeTest {
    private val broadcaster = mock(SseBroadcaster::class.java)

    private fun published() = org.mockito.Mockito.mockingDetails(broadcaster).invocations.count { it.method.name == "publishKafkaStatus" }

    private fun admin(): Admin {
        val admin = mock(Admin::class.java)
        val result = mock(CreateTopicsResult::class.java)
        `when`(result.all()).thenReturn(KafkaFuture.completedFuture(null))
        `when`(admin.createTopics(org.mockito.ArgumentMatchers.anyCollection<org.apache.kafka.clients.admin.NewTopic>())).thenReturn(result)
        return admin
    }

    @Test
    fun `success and failures drive state and publish only on change`() {
        val producer = MockProducer(false, null, StringSerializer(), StringSerializer())
        val probe = KafkaWriteProbe(KafkaHealthProperties(), broadcaster, producer) { admin() }
        val t = Thread { probe.probe() }
        t.start()
        while (producer.history().isEmpty()) Thread.sleep(10)
        producer.completeNext()
        t.join()
        assertEquals("UP", probe.view().status)
        assertEquals(1, published())

        repeat(2) {
            val th = Thread { probe.probe() }
            th.start()
            while (producer.history().size < 2 + it) Thread.sleep(10)
            producer.errorNext(RuntimeException("not enough replicas"))
            th.join()
            if (it == 0) assertEquals("UP", probe.view().status)
        }
        assertEquals("DOWN", probe.view().status)
        assertEquals(2, published())
    }

    @Test
    fun `topic creation failure counts as failed probe and does not touch the producer`() {
        val admin = mock(Admin::class.java)
        `when`(admin.createTopics(org.mockito.ArgumentMatchers.anyCollection<org.apache.kafka.clients.admin.NewTopic>())).thenThrow(RuntimeException("boom"))
        val producer = MockProducer(true, null, StringSerializer(), StringSerializer())
        val probe = KafkaWriteProbe(KafkaHealthProperties(), broadcaster, producer) { admin }
        probe.probe(); probe.probe()
        assertEquals("DOWN", probe.view().status)
        assertEquals(0, producer.history().size)
        assertEquals(1, published())
    }

    @Test
    fun `existing topic is tolerated`() {
        val admin = mock(Admin::class.java)
        val result = mock(CreateTopicsResult::class.java)
        `when`(result.all()).thenReturn(KafkaFuture.completedFuture<Void>(null).let {
            val f = org.apache.kafka.common.internals.KafkaFutureImpl<Void>(); f.completeExceptionally(TopicExistsException("x")); f
        })
        `when`(admin.createTopics(org.mockito.ArgumentMatchers.anyCollection<org.apache.kafka.clients.admin.NewTopic>())).thenReturn(result)
        val probe = KafkaWriteProbe(KafkaHealthProperties(), broadcaster, MockProducer(true, null, StringSerializer(), StringSerializer())) { admin }
        probe.probe()
        assertEquals("UP", probe.view().status)
        assertEquals(1, published())
    }
}
