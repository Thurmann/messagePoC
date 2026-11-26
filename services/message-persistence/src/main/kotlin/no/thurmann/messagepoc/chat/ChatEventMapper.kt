package no.thurmann.messagepoc.chat

import com.fasterxml.jackson.annotation.JsonInclude
import no.thurmann.messagepoc.persistence.MessageResult
import no.thurmann.messagepoc.persistence.MessageResultStatus
import java.time.Instant
import java.util.UUID

@JsonInclude(JsonInclude.Include.NON_NULL)
data class PublicChatEvent(
    val type: String,
    val messageId: UUID,
    val occurredAt: Instant,
    val handle: String,
    val text: String? = null,
)

data class BanState(val until: Instant)

data class AdminModerationRow(
    val occurredAt: Instant,
    val messageId: UUID,
    val email: String?,
    val handle: String?,
    val status: MessageResultStatus,
    val score: Double?,
    val text: String,
    val reason: String?,
    val strikesAfter: Int?,
    val currentStrikes: Int?,
    val banState: BanState?,
)

object ChatEventMapper {
    const val UNKNOWN_HANDLE = "anonymous"

    fun publicEvent(result: MessageResult): PublicChatEvent {
        val handle = result.authorHandle ?: UNKNOWN_HANDLE
        return when (result.status) {
            MessageResultStatus.VALIDATED ->
                PublicChatEvent("message", result.messageId, result.occurredAt, handle, result.text)
            MessageResultStatus.REJECTED, MessageResultStatus.DLT ->
                PublicChatEvent("removed", result.messageId, result.occurredAt, handle)
        }
    }

    fun adminRow(result: MessageResult, email: String?, currentStrikes: Int?, banUntil: Instant?): AdminModerationRow =
        AdminModerationRow(
            occurredAt = result.occurredAt,
            messageId = result.messageId,
            email = email,
            handle = result.authorHandle,
            status = result.status,
            score = result.profanityScore,
            text = result.text,
            reason = result.reason,
            strikesAfter = result.strikesAfter,
            currentStrikes = currentStrikes,
            banState = banUntil?.let(::BanState),
        )
}
