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
            prob <= 0.65          prob > 0.65
                    |               +-------+--------+
                    |               |                |
                    |        prob <= 0.95       prob > 0.95
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
routed to the same partition. The validation service asks Jev a yes/no (`noul`)
"is this message offensive" question and uses the returned probability on the 0–1 scale. Probabilities
through `0.65` produce `MessageValidated`; probabilities above `0.65` through `0.95`
produce `MessageRejected`; probabilities above `0.95` go to
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
retrying in the background for up to `delivery.timeout.ms` (default 120 s), so
the record may still arrive. The browser shows the line as "not confirmed yet –
retrying…" and resends with the same `messageId` (six attempts, about a minute),
then shows "not confirmed – it may still appear". After a longer outage the
message may be lost and must be sent again. Because only the first result for a
`messageId` is stored, a resend does not create a second message.

Known limit: the first result per `messageId` wins. If one copy of a resent
message ends in the technical DLT (for example during a scoring service outage)
before a later copy is validated, the message shows as removed.

## Persistence, strikes, and bans

```text
poc.messages.results.v1 ----> message-persistence (MessageResultListener)
poc.messages.submitted.v1-dlt -> message-persistence (DltListener)
                                      |
                                      v
                       ModerationService (one DB transaction)
                         - lock app_user row (SELECT ... FOR UPDATE)
                         - lock on the messageId; skip if the eventId or messageId is already stored
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

Admins can also ban a user by hand (`POST /api/admin/users/ban`). It uses the same
ladder and escalation, is rejected for admins and for users already banned, and
is stored as a `user_ban` row with `banned_by` set to the admin. Since it is the
latest ban, strikes count from its end.

Presence is a `last_seen_at` timestamp on the user row (not indexed, so the
heartbeat stays a cheap HOT update). The browser sends `POST /api/me/presence`
every 30 s and `DELETE` on sign-out; a user is online if seen within
`PRESENCE_ONLINE_WINDOW` (90 s). Closing a tab does not send `DELETE`, since
another tab may still be open; the user drops off when the window expires. `GET /api/users/online` feeds the
users pane and adds `isAdmin` and `bannedUntil` for admin callers.

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
becomes `DOWN`. The browser shows "live · Kafka unavailable, messages delayed"
while the status is `DOWN`. Sending is not disabled.

Known limit: with several `message-persistence` replicas, each runs its own
probe, so the indicator may briefly disagree between replicas.

The probe is not a Spring health indicator. `/actuator/health` and the Kubernetes
liveness and readiness probes do not depend on Kafka.

## Shared database reads in message-api

`message-api` does not run migrations. It reads `app_user` (handle) and `user_ban`
(active ban) with JDBC, using the same database as `message-persistence`. This
is a deliberate shortcut for the PoC. The database schema is owned by
`message-persistence`. In production, expose a service API or a read model
instead.
