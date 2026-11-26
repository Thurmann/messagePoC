package no.thurmann.messagepoc.auth

import no.thurmann.messagepoc.persistence.AdminUserRepository
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.stereotype.Component
import java.util.concurrent.ConcurrentHashMap

@Component
class AdminDirectory(
    private val adminUserRepository: AdminUserRepository,
) {
    private data class Entry(val admin: Boolean, val loadedAt: Long)

    private val cache = ConcurrentHashMap<String, Entry>()

    fun isAdmin(jwt: Jwt): Boolean {
        if (jwt.claims["email_verified"] != true) return false
        val email = jwt.getClaimAsString("email")?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return false
        val now = System.currentTimeMillis()
        val cached = cache[email]
        if (cached != null && now - cached.loadedAt < CACHE_MILLIS) return cached.admin
        val admin = adminUserRepository.existsById(email)
        cache[email] = Entry(admin, now)
        return admin
    }

    private companion object {
        const val CACHE_MILLIS = 30_000L
    }
}
