package no.thurmann.messagepoc.chat

import org.springframework.beans.factory.annotation.Value
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/config")
class ConfigController(
    @Value("\${google.client-id:}") private val googleClientId: String,
    @Value("\${app.message-api-base-url:}") private val messageApiBaseUrl: String,
) {
    @GetMapping
    fun config() = ClientConfig(googleClientId, messageApiBaseUrl)
}

data class ClientConfig(val googleClientId: String, val messageApiBaseUrl: String)
