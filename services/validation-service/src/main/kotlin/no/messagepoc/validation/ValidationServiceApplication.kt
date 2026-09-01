package no.messagepoc.validation

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class ValidationServiceApplication

fun main(args: Array<String>) {
    runApplication<ValidationServiceApplication>(*args)
}
