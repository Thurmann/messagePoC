package no.thurmann.messagepoc.persistence

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.springframework.data.jpa.repository.JpaRepository
import java.time.Instant

@Entity
@Table(name = "admin_user")
open class AdminUser(
    @field:Id
    @field:Column(name = "email", nullable = false)
    open var email: String = "",

    @field:Column(name = "source", nullable = false)
    open var source: String = "ENV",

    @field:Column(name = "created_at", nullable = false)
    open var createdAt: Instant = Instant.EPOCH,
)

interface AdminUserRepository : JpaRepository<AdminUser, String>
