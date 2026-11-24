package no.thurmann.messagepoc.chat

import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.info.BuildProperties
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/config")
class ConfigController(
    @Value("\${google.client-id:}") private val googleClientId: String,
    @Value("\${app.message-api-base-url:}") private val messageApiBaseUrl: String,
    buildProperties: ObjectProvider<BuildProperties>,
) {
    // Empty when build info is missing, for example when run from an IDE without a Gradle build.
    private val version = buildProperties.ifAvailable?.version.orEmpty()

    @GetMapping
    fun config() = ClientConfig(googleClientId, messageApiBaseUrl, version)
}

data class ClientConfig(val googleClientId: String, val messageApiBaseUrl: String, val version: String)
