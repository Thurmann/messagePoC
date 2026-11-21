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

Records from `poc.messages.results.v1` that `message-persistence` or
`message-audit` cannot process are retried twice and then published to
`poc.messages.results.v1-dlt` (inspect in Kafbat UI). Failures while consuming the
submitted DLT are logged and skipped.

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

Locally, Kafka is a three-broker KRaft cluster (host ports 9092, 9094, 9096)
with replication factor 3 and `min.insync.replicas=2`, so producing with
`acks=all` and consuming continue when one broker is down. Services use all
three brokers as bootstrap servers.

Kafka remains the event record and Loki is the diagnostic record. A consumed
Kafka event is not deleted by log retention or by a consumer committing its
offset.

## Live chat: author flow

```text
Browser (Google sign-in, ID token)
        |
        | POST /api/messages  (Authorization: Bearer)
        v
  message-api -- verifies token, checks handle + active ban (shared DB, read-only)
        |
        | MessageSubmitted (with author.userId + author.handle) --> poc.messages.submitted.v1
        v
  validation-service --> MessageValidated / MessageRejected --> poc.messages.results.v1
```

`message-api` checks the author before it publishes anything. Users without a
handle get `409`, and users under an active ban get `403` with the ban end time.
Authors are identified by the Google `sub` claim. Email addresses are not put on
Kafka.

The browser sends its own `messageId` (UUID) with each message and reuses it when
it retries. If Kafka does not confirm the send in time, `message-api` returns
`503 UNCONFIRMED`. The outcome is unknown, not failed: the producer keeps
retrying in the background and the record usually arrives later. The browser
shows the line as "not confirmed yet – retrying…" and resends with the same
`messageId` (up to six attempts). Because only the first result for a `messageId`
is stored, a resend does not create a second message.

## Persistence, strikes, and bans

```text
poc.messages.results.v1 ----> message-persistence (MessageResultListener)
poc.messages.submitted.v1-dlt -> message-persistence (DltListener)
                                      |
                                      v
                       ModerationService (one DB transaction)
                         - lock on the messageId, skip if the eventId or messageId is already stored
                         - lock app_user row (SELECT ... FOR UPDATE)
                         - insert message_result row
                         - count strikes; create user_ban if the ban threshold is reached
                         - SELECT pg_notify('chat_events', messageId)
```

Strike rows are rejected messages, score-based DLT messages, and (by default)
technical DLT messages. Strikes count from the end of the latest ban. Warnings
start at the warning threshold. Bans follow the escalation ladder, and the step
increases when a new ban starts within the escalation window after the previous one.
The ladder is `MODERATION_BAN_LADDER`. The defaults are documented in
`deploy/kubernetes/README.md` and the root `README.md`.

A result whose `messageId` is already stored is ignored, even if its `eventId`
differs, so a resent message produces no second row, strike, ban or SSE event.
`message-audit` still logs every result it receives, so the same `messageId` can
appear more than once in the logs.

## Live fan-out to browsers

```text
message-persistence replica A                     message-persistence replica B
  PgNotificationListener                            PgNotificationListener
  (dedicated JDBC LISTEN connection)                (dedicated JDBC LISTEN connection)
        ^                                                   ^
        |  NOTIFY chat_events, '<messageId>'  (after commit)|
        +---------------------- PostgreSQL -----------------+
        |                                                   |
  SseBroadcaster -> SSE clients                     SseBroadcaster -> SSE clients
  (/api/chat/stream, /api/admin/stream)             (heartbeat every 15 s)
```

The notification payload is only the message ID. Each replica loads the row and
its moderation state from the database, so every replica sends the same events
regardless of which replica persisted the result. Clients that reconnect re-fetch
`/api/chat/history`. The LISTEN connection requires a direct Postgres connection,
not a transaction-pooled one.

## Kafka write status

```text
message-persistence (write probe, every 10 s)
  produce one small acks=all record -> poc.health.v1
        |
        +--> GET /api/chat/kafka-status  ({status, since, checkedAt})
        +--> SSE event "kafka" on /api/chat/stream
```

The probe status is `UNKNOWN` at startup, `DOWN` after two consecutive failed
probes, and `UP` again after one success. The probe writes a real record instead
of reading cluster metadata, because metadata can still be served after the KRaft
controller quorum is lost. With one of three brokers down, writes still succeed
and the status stays `UP`; with two down, writes are refused and the status
becomes `DOWN`. The browser shows "live · sending paused (Kafka unavailable)"
while the status is `DOWN`.

The probe is not a Spring health indicator. `/actuator/health` and the Kubernetes
liveness and readiness probes do not depend on Kafka.

## Shared database reads in message-api

`message-api` does not run migrations. It reads `app_user` (handle) and `user_ban`
(active ban) with JDBC, using the same database as `message-persistence`. This
is a deliberate shortcut for the PoC. The database schema is owned by
`message-persistence`. In production, expose a service API or a read model
instead.
