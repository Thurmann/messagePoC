# Local architecture

```text
POST /api/messages
        |
        v
  message-api -- MessageSubmitted --> poc.messages.submitted.v1
                                           |
                                           v
                 validation-service
                                           |
                    +------+----------------+
                    |                       |
            score <= 0.70          score > 0.70
                    |               +-------+--------+
                    |               |                |
                    |        score <= 0.95      score > 0.95
                    |               |                |
                    |         MessageRejected   submitted DLT
                    |               |
            MessageValidated        |
                    +-------+-------+
                            |
                            v
                 poc.messages.results.v1
                            |
              +-------------+-------------+
              |                           |
      message-persistence           message-audit
              |                           |
              v                           v
     persist messages in DB       structured JSON log
```

`messageId` is used as the Kafka record key so all events for one message are
routed to the same partition. The validation service asks Jev for a profanity
score on the 0–1 scale. Scores through `0.70` produce `MessageValidated`; scores
above `0.70` through `0.95` produce `MessageRejected`; scores above `0.95` go to
the submitted DLT. Technical processing failures also go to that DLT after
Kafka listener retries.

## Local observability

```text
message-api ---------+
validation-service --+--> Docker JSON logs --> Grafana Alloy --> Loki --> Grafana
message-persistence --------+
```

The applications log structured JSON to standard output when they run in
Compose. Docker provides the container stream and bounded local log rotation;
Alloy discovers the application containers and persists its read positions;
Loki retains and indexes the logs; Grafana provides the query interface.

Stable, low-cardinality values such as `environment` and `service` are Loki
labels. Per-message values such as `correlationId`, `messageId`, `eventId`,
Kafka partition, and offset are JSON fields parsed at query time. This avoids
creating an unbounded number of Loki streams.

Kafka remains the event record and Loki is the diagnostic record. A consumed
Kafka event is not deleted by log retention or by a consumer committing its
offset.
