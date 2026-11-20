package no.thurmann.messagepoc.api

import jakarta.servlet.DispatcherType
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.web.SecurityFilterChain
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.CorsConfigurationSource
import org.springframework.web.cors.UrlBasedCorsConfigurationSource

@Configuration
class SecurityConfig(
    @Value("\${cors.allowed-origins:}") private val allowedOrigins: String,
) {
    @Bean
    fun securityFilterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .csrf { it.disable() }
            .cors { it.configurationSource(corsConfigurationSource()) }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .authorizeHttpRequests { auth ->
                auth
                    .dispatcherTypeMatchers(DispatcherType.ASYNC, DispatcherType.ERROR).permitAll()
                    .requestMatchers(HttpMethod.POST, "/api/messages").authenticated()
                    .requestMatchers("/actuator/health/**", "/actuator/health").permitAll()
                    .anyRequest().denyAll()
            }
            .oauth2ResourceServer { it.jwt { } }
        return http.build()
    }

    private fun corsConfigurationSource(): CorsConfigurationSource {
        val origins = allowedOrigins.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        val source = UrlBasedCorsConfigurationSource()
        if (origins.isNotEmpty()) {
            val config = CorsConfiguration()
            config.allowedOrigins = origins
            config.allowedMethods = listOf("POST", "OPTIONS")
            config.allowedHeaders = listOf("Authorization", "Content-Type", "X-Correlation-Id")
            config.allowCredentials = false
            source.registerCorsConfiguration("/api/**", config)
        }
        return source
    }
}
