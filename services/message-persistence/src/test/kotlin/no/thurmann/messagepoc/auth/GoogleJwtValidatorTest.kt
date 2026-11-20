package no.thurmann.messagepoc.auth

import org.springframework.security.oauth2.jwt.Jwt
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class GoogleJwtValidatorTest {
    private fun jwt(issuer: String = "https://accounts.google.com", audience: List<String> = listOf("client-1"), expiresIn: Long = 3600): Jwt {
        val now = Instant.now()
        return Jwt.withTokenValue("token")
            .header("alg", "RS256")
            .claim("iss", issuer)
            .audience(audience)
            .subject("sub-1")
            .issuedAt(now.minusSeconds(7200))
            .expiresAt(now.plusSeconds(expiresIn))
            .build()
    }

    private fun valid(jwt: Jwt, clientId: String = "client-1") = !googleJwtValidator(clientId).validate(jwt).hasErrors()

    @Test
    fun `accepts both google issuer forms`() {
        assertTrue(valid(jwt(issuer = "https://accounts.google.com")))
        assertTrue(valid(jwt(issuer = "accounts.google.com")))
    }

    @Test
    fun `rejects wrong issuer`() {
        assertFalse(valid(jwt(issuer = "https://evil.example.com")))
    }

    @Test
    fun `rejects wrong audience`() {
        assertFalse(valid(jwt(audience = listOf("other-client"))))
    }

    @Test
    fun `rejects everything when client id is blank`() {
        assertFalse(valid(jwt(), clientId = ""))
    }

    @Test
    fun `rejects expired token`() {
        assertFalse(valid(jwt(expiresIn = -3600)))
    }
}
