package no.thurmann.messagepoc.audit

import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface MessageResultRepository : JpaRepository<MessageResult, UUID>
