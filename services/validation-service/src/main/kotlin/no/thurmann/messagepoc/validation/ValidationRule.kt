package no.thurmann.messagepoc.validation

import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component

@Component
class ValidationRule(
    private val profanityScorer: ProfanityScorer,
    @Value("\${moderation.reject-threshold:0.65}")
    val rejectThreshold: Double,
    @Value("\${moderation.dlt-threshold:0.95}")
    private val dltThreshold: Double,
) {
    init {
        require(rejectThreshold >= 0.0 && rejectThreshold < dltThreshold && dltThreshold <= 1.0) {
            "Moderation thresholds must satisfy 0 <= reject < DLT <= 1"
        }
    }

    fun score(text: String): Double = profanityScorer.score(text).also {
        require(it.isFinite() && it in 0.0..1.0) { "Profanity score must be between 0 and 1" }
    }

    fun decide(score: Double): ValidationDecision {
        require(score.isFinite() && score in 0.0..1.0) { "Profanity score must be between 0 and 1" }
        return when {
            score > dltThreshold -> ValidationDecision.DLT
            score > rejectThreshold -> ValidationDecision.REJECT
            else -> ValidationDecision.ACCEPT
        }
    }
}

enum class ValidationDecision {
    ACCEPT,
    REJECT,
    DLT,
}
