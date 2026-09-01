package no.messagepoc.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ValidationRuleTest {
    private val rule = ValidationRule()

    @Test
    fun `accepts messages containing a digit`() {
        assertTrue(rule.accepts("Order 123 is ready"))
    }

    @Test
    fun `rejects messages without a digit`() {
        assertFalse(rule.accepts("No digits here"))
    }
}
