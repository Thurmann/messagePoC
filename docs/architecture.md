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
                          +----------------+----------------+
                          |                                 |
                  MessageValidated                 MessageRejected
                          +----------------+----------------+
                                           |
                                           v
                                 poc.messages.results.v1
                                           |
                                           v
                                      message-view
                                           |
                                           v
                                  structured JSON log
```

`messageId` is used as the Kafka record key so all events for one message are
routed to the same partition. A rejected message is a business result and is
therefore published as an event; the DLT is reserved for technical failures in
a later milestone.

## Local observability

```text
message-api ---------+
validation-service --+--> Docker JSON logs --> Grafana Alloy --> Loki --> Grafana
message-view --------+
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
