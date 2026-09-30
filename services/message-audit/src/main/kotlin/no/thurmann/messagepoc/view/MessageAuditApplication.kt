package no.thurmann.messagepoc.view

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class MessageAuditApplication

fun main(args: Array<String>) {
    runApplication<MessageAuditApplication>(*args)
}
