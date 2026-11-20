package no.thurmann.messagepoc.chat

import no.thurmann.messagepoc.audit.AppUserRepository
import no.thurmann.messagepoc.audit.MessageResult
import no.thurmann.messagepoc.audit.MessageResultRepository
import no.thurmann.messagepoc.audit.MessageResultStatus
import no.thurmann.messagepoc.moderation.ModerationService
import org.springframework.data.domain.PageRequest
import org.springframework.stereotype.Service

@Service
class ChatQueryService(
    private val messageResultRepository: MessageResultRepository,
    private val appUserRepository: AppUserRepository,
    private val moderationService: ModerationService,
) {
    fun history(limit: Int): List<PublicChatEvent> =
        messageResultRepository.findAllByOrderByOccurredAtDesc(PageRequest.of(0, limit))
            .map(ChatEventMapper::publicEvent)
            .asReversed()

    fun moderationLog(limit: Int): List<AdminModerationRow> =
        adminRows(
            messageResultRepository.findAllByStatusInOrderByOccurredAtDesc(
                listOf(MessageResultStatus.REJECTED, MessageResultStatus.DLT),
                PageRequest.of(0, limit),
            ),
        )

    fun byMessageId(messageId: java.util.UUID): List<MessageResult> =
        messageResultRepository.findAllByMessageId(messageId)

    fun adminRows(results: List<MessageResult>): List<AdminModerationRow> {
        val authors = results.mapNotNull { it.authorId }.distinct()
        val emails = appUserRepository.findAllById(authors).associate { it.googleSub to it.email }
        val strikes = authors.associateWith { moderationService.currentStrikes(it) }
        val bans = authors.associateWith { moderationService.activeBan(it)?.endsAt }
        return results.map {
            ChatEventMapper.adminRow(it, emails[it.authorId], it.authorId?.let(strikes::get), it.authorId?.let(bans::get))
        }
    }
}
