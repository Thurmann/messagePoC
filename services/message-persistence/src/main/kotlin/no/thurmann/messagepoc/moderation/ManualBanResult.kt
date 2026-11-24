package no.thurmann.messagepoc.moderation

import java.time.Instant

sealed interface ManualBanResult {
    data class Banned(val handle: String, val step: Int, val until: Instant) : ManualBanResult

    data class AlreadyBanned(val until: Instant) : ManualBanResult

    data object UnknownHandle : ManualBanResult

    data object CannotBanAdmin : ManualBanResult
}
