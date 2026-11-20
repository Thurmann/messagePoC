package no.thurmann.messagepoc.auth

object HandleRules {
    private val pattern = Regex("^[A-Za-z0-9_]{3,20}$")

    fun isValid(handle: String): Boolean = pattern.matches(handle)
}
