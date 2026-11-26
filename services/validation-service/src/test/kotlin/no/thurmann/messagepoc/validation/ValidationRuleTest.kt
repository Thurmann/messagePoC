package no.thurmann.messagepoc.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

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

    @Test
    fun `constructor rejects reject threshold at or above DLT threshold`() {
        assertFailsWith<IllegalArgumentException> { ruleWith(reject = 0.95, dlt = 0.95) }
        assertFailsWith<IllegalArgumentException> { ruleWith(reject = 0.96, dlt = 0.95) }
    }

    @Test
    fun `constructor rejects DLT threshold above one`() {
        assertFailsWith<IllegalArgumentException> { ruleWith(reject = 0.5, dlt = 1.1) }
    }

    @Test
    fun `constructor rejects negative reject threshold`() {
        assertFailsWith<IllegalArgumentException> { ruleWith(reject = -0.1, dlt = 0.95) }
    }

    @Test
    fun `decide rejects scores outside zero to one`() {
        assertFailsWith<IllegalArgumentException> { rule.decide(-0.1) }
        assertFailsWith<IllegalArgumentException> { rule.decide(1.1) }
    }

    @Test
    fun `decide rejects NaN`() {
        assertFailsWith<IllegalArgumentException> { rule.decide(Double.NaN) }
    }

    @Test
    fun `score rejects a scorer returning a value above one`() {
        val outOfRange = ruleWith(reject = 0.7, dlt = 0.95, scorer = ProfanityScorer { 1.5 })

        assertFailsWith<IllegalArgumentException> { outOfRange.score("anything") }
    }

    private fun ruleWith(
        reject: Double,
        dlt: Double,
        scorer: ProfanityScorer = ProfanityScorer { 0.0 },
    ) = ValidationRule(profanityScorer = scorer, rejectThreshold = reject, dltThreshold = dlt)
}
