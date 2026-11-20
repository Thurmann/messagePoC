package no.thurmann.messagepoc.api

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder

@Configuration
class GoogleJwtConfig {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Bean
    fun jwtDecoder(@Value("\${google.client-id:}") clientId: String): JwtDecoder {
        if (clientId.isBlank()) logger.warn("GOOGLE_CLIENT_ID is not set; all tokens will be rejected")
        val decoder = NimbusJwtDecoder.withJwkSetUri("https://www.googleapis.com/oauth2/v3/certs").build()
        decoder.setJwtValidator(googleJwtValidator(clientId))
        return decoder
    }
}
