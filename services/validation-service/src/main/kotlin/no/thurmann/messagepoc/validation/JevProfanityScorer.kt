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
                        "type" to "noul",
                        "instructions" to PROFANITY_QUESTION,
                        "criteria" to mapOf(
                            "true" to OFFENSIVE_CRITERION,
                            "false" to NOT_OFFENSIVE_CRITERION,
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

        val probabilityNode = objectMapper.readTree(response.body())
            .path("answers")
            .path(PROFANITY_QUESTION_ID)
            .path("noul")
        check(probabilityNode.isNumber) { "Jev response did not contain a numeric profanity probability" }

        return probabilityNode.doubleValue().also { probability ->
            check(probability.isFinite() && probability in 0.0..1.0) {
                "Jev returned a profanity probability outside the expected 0–1 range"
            }
        }
    }

    private companion object {
        // Ask whether the message is offensive, not whether it contains swear words:
        // Norwegian intensifiers such as "jævla bra dag" are common and harmless.
        const val PROFANITY_QUESTION_ID = "offensive"
        const val PROFANITY_QUESTION =
            "Is this chat message offensive? Judge the meaning and intent of the whole " +
                "message, not whether individual swear words appear. The message may be " +
                "written in any language, including Norwegian."
        const val OFFENSIVE_CRITERION =
            "The message is offensive: it insults, demeans, harasses or threatens a " +
                "person or group (for example calling someone an idiot), contains hate " +
                "speech or slurs, or contains sexually explicit or very vulgar descriptions."
        const val NOT_OFFENSIVE_CRITERION =
            "The message is not offensive. Swear words used as intensifiers or " +
                "exclamations that are not aimed at anyone, such as 'damn good day', " +
                "'damn fine guy', 'hell!' or cursing at a thing or situation, are not " +
                "offensive on their own."
    }
}
