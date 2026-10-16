package no.thurmann.messagepoc.validation

import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

fun interface ProfanityScorer {
    fun score(text: String): Double
}

@Component
class JevProfanityScorer(
    @Value("\${TYPESAFE_API_KEY:}") private val apiKey: String,
    @Value("\${TYPESAFE_API_URL:https://api.typesafe.ai/v1/systemone}") apiUrl: String,
    private val objectMapper: ObjectMapper,
) : ProfanityScorer {
    private val endpoint = URI.create(apiUrl)
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    override fun score(text: String): Double {
        check(apiKey.isNotBlank()) { "TYPESAFE_API_KEY is required to score submitted messages" }

        val requestBody = objectMapper.writeValueAsString(
            mapOf(
                "model" to "jev-latest",
                "state" to text,
                "questions" to mapOf(
                    PROFANITY_QUESTION_ID to mapOf(
                        "type" to "score",
                        "instructions" to PROFANITY_QUESTION,
                        "criteria" to listOf(
                            "The text contains no profanity, cursing, or very rude descriptions.",
                            "The text contains profanity, cursing, or very rude descriptions.",
                        ),
                    ),
                ),
            ),
        )
        val request = HttpRequest.newBuilder(endpoint)
            .timeout(Duration.ofSeconds(10))
            .header("Authorization", "Bearer $apiKey")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(requestBody))
            .build()

        val response = try {
            httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        } catch (exception: InterruptedException) {
            Thread.currentThread().interrupt()
            throw IllegalStateException("Jev profanity scoring request was interrupted", exception)
        } catch (exception: Exception) {
            throw IllegalStateException("Jev profanity scoring request failed", exception)
        }

        check(response.statusCode() in 200..299) {
            "Jev profanity scoring request returned HTTP ${response.statusCode()}"
        }

        val scoreNode = objectMapper.readTree(response.body())
            .path("answers")
            .path(PROFANITY_QUESTION_ID)
            .path("score")
        check(scoreNode.isNumber) { "Jev response did not contain a numeric profanity score" }

        return scoreNode.doubleValue().also { score ->
            check(score.isFinite() && score in 0.0..1.0) {
                "Jev returned a profanity score outside the expected 0–1 range"
            }
        }
    }

    private companion object {
        const val PROFANITY_QUESTION_ID = "profanity"
        const val PROFANITY_QUESTION =
            "Does the text contain any profanities, cursing or very rude descriptions?"
    }
}
