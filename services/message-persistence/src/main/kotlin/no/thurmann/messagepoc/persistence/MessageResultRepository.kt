package no.thurmann.messagepoc.persistence

import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import java.time.Instant
import java.util.UUID

interface MessageResultRepository : JpaRepository<MessageResult, UUID> {
    fun findAllByOrderByOccurredAtDesc(): List<MessageResult>

    fun findAllByOrderByOccurredAtDesc(pageable: Pageable): List<MessageResult>

    fun findAllByStatusInOrderByOccurredAtDesc(statuses: Collection<MessageResultStatus>, pageable: Pageable): List<MessageResult>

    fun findAllByMessageId(messageId: UUID): List<MessageResult>

    fun existsByMessageId(messageId: UUID): Boolean

    fun countByAuthorIdAndStrikeTrue(authorId: String): Int

    fun countByAuthorIdAndStrikeTrueAndOccurredAtGreaterThanEqual(authorId: String, since: Instant): Int
}
