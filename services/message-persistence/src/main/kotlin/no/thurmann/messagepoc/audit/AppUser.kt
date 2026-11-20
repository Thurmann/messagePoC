package no.thurmann.messagepoc.audit

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.springframework.data.jpa.repository.JpaRepository
import java.time.Instant

@Entity
@Table(name = "app_user")
open class AppUser(
    @field:Id
    @field:Column(name = "google_sub", nullable = false)
    open var googleSub: String = "",

    @field:Column(name = "email", nullable = false)
    open var email: String = "",

    @field:Column(name = "handle", nullable = true)
    open var handle: String? = null,

    @field:Column(name = "created_at", nullable = false)
    open var createdAt: Instant = Instant.EPOCH,

    @field:Column(name = "last_login_at", nullable = true)
    open var lastLoginAt: Instant? = null,
)

interface AppUserRepository : JpaRepository<AppUser, String>
