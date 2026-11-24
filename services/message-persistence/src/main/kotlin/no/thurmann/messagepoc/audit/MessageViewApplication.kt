package no.thurmann.messagepoc.audit

import no.thurmann.messagepoc.auth.PresenceProperties
import no.thurmann.messagepoc.moderation.ModerationProperties
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

@SpringBootApplication(scanBasePackages = ["no.thurmann.messagepoc"])
@EnableConfigurationProperties(ModerationProperties::class, PresenceProperties::class, no.thurmann.messagepoc.kafka.KafkaHealthProperties::class)
@EnableScheduling
class MessageViewApplication

fun main(args: Array<String>) {
    runApplication<MessageViewApplication>(*args)
}
