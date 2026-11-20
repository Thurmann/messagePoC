package no.thurmann.messagepoc.audit

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.springframework.data.jpa.repository.JpaRepository
import java.time.Instant
import java.util.UUID

@Entity
@Table(name = "user_ban")
open class UserBan(
    @field:Id
    @field:GeneratedValue(strategy = GenerationType.IDENTITY)
    @field:Column(name = "id", nullable = false)
    open var id: Long? = null,

    @field:Column(name = "user_id", nullable = false)
    open var userId: String = "",

    @field:Column(name = "step", nullable = false)
    open var step: Int = 0,

    @field:Column(name = "starts_at", nullable = false)
    open var startsAt: Instant = Instant.EPOCH,

    @field:Column(name = "ends_at", nullable = false)
    open var endsAt: Instant = Instant.EPOCH,

    @field:Column(name = "strikes_at_ban", nullable = true)
    open var strikesAtBan: Int? = null,

    @field:Column(name = "trigger_message_id", nullable = true)
    open var triggerMessageId: UUID? = null,

    @field:Column(name = "created_at", nullable = false)
    open var createdAt: Instant = Instant.EPOCH,
)

interface UserBanRepository : JpaRepository<UserBan, Long> {
    fun findFirstByUserIdOrderByEndsAtDesc(userId: String): UserBan?
}
