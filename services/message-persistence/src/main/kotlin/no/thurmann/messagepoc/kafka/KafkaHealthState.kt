package no.thurmann.messagepoc.kafka

import java.time.Instant

enum class KafkaWriteStatus { UNKNOWN, UP, DOWN }

data class KafkaStatusView(val status: String, val since: Instant?, val checkedAt: Instant?) {
    companion object {
        val UNKNOWN = KafkaStatusView(KafkaWriteStatus.UNKNOWN.name, null, null)
    }
}

/** Debounced up/down state derived from real write probes. Thread-safe. */
class KafkaHealthState(private val failuresBeforeDown: Int = 2) {
    private var status = KafkaWriteStatus.UNKNOWN
    private var since: Instant? = null
    private var checkedAt: Instant? = null
    private var consecutiveFailures = 0

    /** Returns true when the state changed. */
    @Synchronized
    fun recordSuccess(now: Instant): Boolean {
        checkedAt = now
        consecutiveFailures = 0
        return transition(KafkaWriteStatus.UP, now)
    }

    /** Returns true when the state changed. */
    @Synchronized
    fun recordFailure(now: Instant, reason: String): Boolean {
        checkedAt = now
        consecutiveFailures++
        return if (consecutiveFailures >= failuresBeforeDown) transition(KafkaWriteStatus.DOWN, now) else false
    }

    @Synchronized
    fun view(): KafkaStatusView = KafkaStatusView(status.name, since, checkedAt)

    private fun transition(to: KafkaWriteStatus, now: Instant): Boolean {
        if (status == to) return false
        status = to
        since = now
        return true
    }
}
