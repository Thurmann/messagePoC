package no.thurmann.messagepoc.auth

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HandleRulesTest {
    @Test
    fun `accepts valid handles`() {
        assertTrue(HandleRules.isValid("abc"))
        assertTrue(HandleRules.isValid("User_123"))
        assertTrue(HandleRules.isValid("a".repeat(20)))
    }

    @Test
    fun `rejects invalid handles`() {
        assertFalse(HandleRules.isValid("ab"))
        assertFalse(HandleRules.isValid("a".repeat(21)))
        assertFalse(HandleRules.isValid("has space"))
        assertFalse(HandleRules.isValid("bad-char"))
        assertFalse(HandleRules.isValid("abc\n"))
        assertFalse(HandleRules.isValid(""))
    }
}
