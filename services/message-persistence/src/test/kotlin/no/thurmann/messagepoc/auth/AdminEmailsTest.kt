package no.thurmann.messagepoc.auth

import kotlin.test.Test
import kotlin.test.assertEquals

class AdminEmailsTest {
    @Test
    fun `trims lowercases dedupes and drops blanks`() {
        assertEquals(listOf("a@x.com", "b@x.com"), parseAdminEmails(" A@x.com, b@X.com ,,a@x.com , "))
    }

    @Test
    fun `blank input yields nothing`() {
        assertEquals(emptyList(), parseAdminEmails("  "))
    }
}
