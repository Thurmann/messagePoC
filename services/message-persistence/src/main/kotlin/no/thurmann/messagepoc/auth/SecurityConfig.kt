package no.thurmann.messagepoc.auth

import jakarta.servlet.DispatcherType
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.convert.converter.Converter
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.GrantedAuthority
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter
import org.springframework.security.web.SecurityFilterChain

@Configuration
class SecurityConfig(
    private val adminDirectory: AdminDirectory,
    @Value("\${app.message-api-base-url:}") private val messageApiBaseUrl: String,
) {
    @Bean
    fun securityFilterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .csrf { it.disable() }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .authorizeHttpRequests { auth ->
                auth
                    .dispatcherTypeMatchers(DispatcherType.ASYNC, DispatcherType.ERROR).permitAll()
                    .requestMatchers(
                        "/", "/index.html", "/app.js", "/app.css", "/favicon.ico",
                        "/api/config", "/api/chat/history", "/api/chat/stream", "/api/chat/kafka-status",
                        "/actuator/health/**", "/actuator/health",
                    ).permitAll()
                    .requestMatchers("/api/me/**", "/api/me").authenticated()
                    .requestMatchers("/api/admin/**", "/api/audit-logs").hasRole("ADMIN")
                    .anyRequest().denyAll()
            }
            .oauth2ResourceServer { it.jwt { jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter()) } }
            .headers { it.contentSecurityPolicy { csp -> csp.policyDirectives(contentSecurityPolicy(messageApiBaseUrl)) } }
        return http.build()
    }

    private fun jwtAuthenticationConverter(): JwtAuthenticationConverter {
        val converter = JwtAuthenticationConverter()
        converter.setJwtGrantedAuthoritiesConverter(Converter<Jwt, Collection<GrantedAuthority>> { jwt ->
            if (adminDirectory.isAdmin(jwt)) listOf(SimpleGrantedAuthority("ROLE_ADMIN")) else emptyList()
        })
        return converter
    }
}

fun contentSecurityPolicy(messageApiBaseUrl: String): String {
    val connect = listOf("'self'", "https://accounts.google.com/gsi/", messageApiBaseUrl.trim().trimEnd('/'))
        .filter { it.isNotEmpty() }
        .joinToString(" ")
    return listOf(
        "default-src 'self'",
        "script-src 'self' https://accounts.google.com/gsi/client",
        "frame-src https://accounts.google.com/gsi/",
        "connect-src $connect",
        "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
        "img-src 'self' data: https:",
        "object-src 'none'",
        "base-uri 'self'",
    ).joinToString("; ")
}
