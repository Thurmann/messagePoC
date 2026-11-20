package no.thurmann.messagepoc.it

import no.thurmann.messagepoc.chat.AdminModerationRow
import no.thurmann.messagepoc.chat.PublicChatEvent
import no.thurmann.messagepoc.chat.SseBroadcaster
import no.thurmann.messagepoc.moderation.ModerationService
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean
import kotlin.test.assertEquals

class NotifyIT : AbstractIntegrationTest() {
    @Autowired
    lateinit var service: ModerationService

    @MockitoSpyBean
    lateinit var broadcaster: SseBroadcaster

    @Test
    fun `committed moderation result is delivered through pg notify to the broadcaster`() {
        createUser("u1", handle = "alice")
        // let the LISTEN connection come up before notifying (notifications sent earlier would be missed)
        Thread.sleep(1500)
        val result = rejected("u1", text = "secret rude text")

        service.record(result)

        fun calls(name: String) = org.mockito.Mockito.mockingDetails(broadcaster).invocations.filter { it.method.name == name }.map { it.arguments[0] }
        org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(10)).until { calls("publishPublic").isNotEmpty() && calls("publishAdmin").isNotEmpty() }

        val event = calls("publishPublic").single() as PublicChatEvent
        assertEquals("removed", event.type)
        assertEquals(result.messageId, event.messageId)
        assertEquals("h-u1", event.handle)
        assertEquals(null, event.text)

        val row = calls("publishAdmin").single() as AdminModerationRow
        assertEquals("secret rude text", row.text)
        assertEquals(1, row.strikesAfter)
    }
}
