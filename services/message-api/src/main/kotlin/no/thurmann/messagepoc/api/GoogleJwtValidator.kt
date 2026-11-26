package no.thurmann.messagepoc.api

import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2Error
import org.springframework.security.oauth2.core.OAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtTimestampValidator

private val GOOGLE_ISSUERS = setOf("https://accounts.google.com", "accounts.google.com")

/** Identical copy in message-persistence auth/GoogleJwtValidator.kt; keep both in sync (services deploy independently). */
class GoogleClaimsValidator(private val clientId: String) : OAuth2TokenValidator<Jwt> {
    override fun validate(token: Jwt): OAuth2TokenValidatorResult {
        if (clientId.isBlank()) return failure("Google client id is not configured")
        if (token.getClaimAsString("iss") !in GOOGLE_ISSUERS) return failure("Invalid issuer")
        if (clientId !in (token.audience ?: emptyList())) return failure("Invalid audience")
        return OAuth2TokenValidatorResult.success()
    }

    private fun failure(description: String) =
        OAuth2TokenValidatorResult.failure(OAuth2Error("invalid_token", description, null))
}

fun googleJwtValidator(clientId: String): OAuth2TokenValidator<Jwt> =
    DelegatingOAuth2TokenValidator(JwtTimestampValidator(), GoogleClaimsValidator(clientId))
