package no.thurmann.messagepoc.validation

import kotlin.test.Test
import kotlin.test.assertEquals

class ValidationRuleTest {
    private val rule = ValidationRule(
        profanityScorer = ProfanityScorer { 0.0 },
        rejectThreshold = 0.7,
        dltThreshold = 0.95,
    )

    @Test
    fun `scores at or below reject threshold are accepted`() {
        assertEquals(ValidationDecision.ACCEPT, rule.decide(0.0))
        assertEquals(ValidationDecision.ACCEPT, rule.decide(0.7))
    }

    @Test
    fun `scores above reject threshold through DLT threshold are rejected`() {
        assertEquals(ValidationDecision.REJECT, rule.decide(0.7001))
        assertEquals(ValidationDecision.REJECT, rule.decide(0.95))
    }

    @Test
    fun `scores above DLT threshold go to the dead-letter topic`() {
        assertEquals(ValidationDecision.DLT, rule.decide(0.9501))
        assertEquals(ValidationDecision.DLT, rule.decide(1.0))
    }
}
