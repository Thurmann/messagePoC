package no.thurmann.messagepoc.api

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class MessageApiApplication

fun main(args: Array<String>) {
    runApplication<MessageApiApplication>(*args)
}
