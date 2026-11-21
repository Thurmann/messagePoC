# Message PoC

Kotlin/Spring Boot PoC for Kafka application development. The project contains
four services, shared event contracts, Kafka, PostgreSQL-backed message
results, a Google sign-in live chat with moderation, Kafbat UI, and centralized
local logging with Grafana Alloy, Loki, and Grafana.

## Prerequisites

- Java 25
- Docker with Docker Compose
- A Google OAuth client ID for sign-in (see [Get a Google client ID](#get-a-google-client-id-locally))

The project uses its own Gradle Wrapper; no global Gradle installation is
required.

## Start the complete local environment

Set a TypeSafe API key before starting the validation service:

```bash
cp .env.example .env
# Edit .env and set TYPESAFE_API_KEY and GOOGLE_CLIENT_ID
```

```bash
docker compose up --build -d
docker compose ps
```

Stop any services previously started with `bootRun` before using the complete
Compose environment. Mixing host processes and Compose containers creates extra
members in the same Kafka consumer groups, and a host `message-api` may continue
to receive traffic on port 8080. This is useful when deliberately testing
rebalancing, but confusing as the default development mode.

Kafka runs as a three-broker KRaft cluster (`kafka-1`, `kafka-2`, `kafka-3`)
reachable from the host at `localhost:9092`, `localhost:9094`, and
`localhost:9096`. Topics use replication factor 3 and `min.insync.replicas=2`,
so the cluster keeps accepting `acks=all` writes with one broker down. Each
broker has a 512 MB heap cap.
PostgreSQL is at `localhost:5432` and the message API at `localhost:8080`. The live chat is served by
`message-persistence` at <http://localhost:8083>.

If you previously ran the single-broker setup, run `docker compose down`
first. The old `kafka-data` volume is no longer used and can be removed with
`docker volume rm message-poc_kafka-data`; the new brokers start with fresh
volumes and `kafka-init` recreates the topics.

Local tools:

| Tool | URL | Purpose |
| --- | --- | --- |
| Kafbat UI | <http://localhost:8085> | Inspect Kafka topics, records, and consumer groups |
| Live chat | <http://localhost:8083> | Sign in with Google, pick a handle, chat, and (for admins) watch the moderation log |
| Grafana | <http://localhost:3000> | Search logs from all application instances |
| Alloy UI | <http://localhost:12345> | Inspect the local log collection pipeline |
| Loki readiness | <http://localhost:3100/ready> | Check whether the log store is ready |

The Grafana instance is bound to localhost and allows anonymous local access,
including Explore for log queries. The Loki data source is provisioned
automatically.

## Live chat

Open <http://localhost:8083> (not `127.0.0.1`: CORS and Google's authorized
JavaScript origins are exact matches), sign in with Google, and choose a handle. The
handle is chosen once, is unique (case-insensitive), and cannot be changed later.
Messages from other users appear live over Server-Sent Events. Each message is
moderated before it is shown to everyone:

1. The message is posted to `message-api`, which checks your handle and any
   active ban, then publishes it to Kafka.
2. `validation-service` scores the text with Jev (see below) and publishes a
   validated or rejected result.
3. `message-persistence` stores the result and updates your strike count. The
   chat shows the message to everyone, or shows "A message from <handle> was
   removed by moderation." if it was rejected.

> **Note:** `MODERATION_TECHNICAL_DLT_COUNTS_AS_STRIKE` defaults to `false`, so a
> message that ends in the DLT because of a technical failure (for example a
> missing `TYPESAFE_API_KEY` or Jev being down) is not a strike. Set it to `true`
> to count those as well; users would then be banned after 6 messages during an
> outage.

Strikes and bans:

- A rejected message, or a message whose score sends it to the DLT, is one strike.
  A technical failure that ends in the DLT is not a strike unless
  `MODERATION_TECHNICAL_DLT_COUNTS_AS_STRIKE=true`.
- At 3 strikes (`MODERATION_WARNING_THRESHOLD`) you get a warning.
- At 6 strikes (`MODERATION_BAN_THRESHOLD`) you are banned temporarily. The ban
  lengths follow `MODERATION_BAN_LADDER`, which defaults to 1 minute, 5 minutes,
  30 minutes, 2 hours, 12 hours, and 24 hours. The last step repeats.
- Admins (`ADMIN_EMAILS` / `admin_user`) are never banned but still get warnings,
  and their strikes are logged.

- A new ban starts the next step on the ladder if it starts within
  `MODERATION_ESCALATION_WINDOW` (default `1d`) after the previous ban ended.
  Otherwise it starts at the first step again.
- Strikes count from the end of your latest ban, so the counter resets when a
  ban ends.

Admins (addresses in `ADMIN_EMAILS`, or added to the `admin_user` table) see an
admin rail with the moderation log, which lists rejected and DLT results (not validated ones), with
score, strike state, and the current ban state. The log is also streamed live.

### Get a Google client ID locally

1. In Google Cloud Console, open APIs & Services → Credentials, and choose
   Create credentials → OAuth client ID.
2. Choose application type **Web application**.
3. Under Authorized JavaScript origins, add `http://localhost:8083` and, for the
   deployed frontend, `https://messages.example.com`.
4. Copy the client ID into `GOOGLE_CLIENT_ID` in `.env`, then run
   `docker compose up -d --build`.

The client ID is public, so it is safe to commit in deployment config. Only the
Compose `.env` file is local.

### Configuration

Set these variables in `.env` (Compose) or in `configmap.yaml` (Kubernetes).
Defaults apply when a variable is unset.

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | message-api, message-persistence | empty (all tokens rejected) | OAuth Web client ID; ID token audience |
| `CORS_ALLOWED_ORIGINS` | message-api | `http://localhost:8083` (Compose); empty (Kubernetes) | Browser origins allowed to call `POST /api/messages` |
| `ADMIN_EMAILS` | message-persistence | `christian.thurmann@gmail.com` | Comma-separated admin emails; inserted into `admin_user` at startup |
| `MESSAGE_API_BASE_URL` | message-persistence | empty (same origin); `http://localhost:8080` (Compose) | Message API base URL sent to the frontend by `/api/config` |
| `MODERATION_WARNING_THRESHOLD` | message-persistence | `3` | Strikes that trigger a warning |
| `MODERATION_BAN_THRESHOLD` | message-persistence | `6` | Strikes that trigger a ban |
| `MODERATION_BAN_LADDER` | message-persistence | `1m,5m,30m,2h,12h,24h` | Ban durations by step; the last step repeats |
| `MODERATION_ESCALATION_WINDOW` | message-persistence | `1d` | Window after a ban in which the next ban escalates |
| `MODERATION_TECHNICAL_DLT_COUNTS_AS_STRIKE` | message-persistence | `false` | Whether technical DLT failures count as strikes. **Warning:** if set to `true`, a missing `TYPESAFE_API_KEY` or a Jev outage sends every message to the DLT and bans users after 6 messages |
| `KAFKA_HEALTH_ENABLED` | message-persistence | `true` | Runs the Kafka write probe that drives the chat's connection status. Set to `false` to turn it off |

`message-api` also uses the database variables `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD`, and `JDBC_URL`, the same as `message-persistence`. It
reads the handle and ban state from that database.

### Endpoints

| Service | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| message-api | `POST /api/messages` | Bearer ID token | Submit a message; optional `messageId` (UUID) in the body, generated if absent; returns `202` with `messageId`. Errors: `400` (`INVALID_MESSAGE_ID`), `401`, `403` (`BANNED`, with `bannedUntil`), `409` (handle required), `503` (`UNCONFIRMED`: outcome unknown, resend with the same `messageId`; `UNAVAILABLE`: database unreachable) |
| message-persistence | `GET /api/config` | public | Client ID and message API base URL for the frontend |
| message-persistence | `GET /api/chat/history?limit=100` | public | Recent public messages and removed placeholders (never rejected text) |
| message-persistence | `GET /api/chat/stream` | public | Live `message`, `removed` and `kafka` events (SSE) |
| message-persistence | `GET /api/chat/kafka-status` | public | Kafka write probe state: `{status, since, checkedAt}` (`UNKNOWN`, `UP` or `DOWN`) |
| message-persistence | `GET /api/me` | Bearer ID token | Your handle, strikes, warning and ban state; creates your user record |
| message-persistence | `PUT /api/me/handle` | Bearer ID token | Choose your handle once (`^[A-Za-z0-9_]{3,20}$`) |
| message-persistence | `GET /api/admin/moderation-log?limit=200` | admin | Moderation log |
| message-persistence | `GET /api/admin/stream` | admin | Live moderation rows (SSE) |
| message-persistence | `GET /api/audit-logs` | admin | Recent `message-audit` entries from Loki |
| all services | `GET /actuator/health` | public | Health probes |

## Send messages from the command line

The helper script posts as a signed-in user, so it needs a Google ID token. Sign
in at <http://localhost:8083> (use `localhost`, not `127.0.0.1`), open the browser
DevTools console, and copy the token the page keeps in session storage:

```js
sessionStorage.getItem("idToken")
```

Then export it:

```bash
export ID_TOKEN=eyJ...
./sendmessage.sh "some text to be shown in the chat"
```

The token expires after about an hour, and it must have been issued for the
`GOOGLE_CLIENT_ID` the services use. The script posts to
`http://localhost:8080/api/messages` with `Authorization: Bearer $ID_TOKEN`. Set
`MESSAGE_API_URL` to use a different API address. The chat updates live over
Server-Sent Events. Messages appear after the Kafka validation and persistence
steps finish.

The database-backed history is available at
`http://localhost:8083/api/chat/history`. It replaces the former
`/api/messages` GET endpoint.
The adjacent audit panel reads the 50 newest result entries from `message-audit`
through Loki at `http://localhost:8083/api/audit-logs`.

The validation service sends each submitted text to Jev and asks:
“Does the text contain any profanities, cursing or very rude descriptions?”
Jev returns a score from 0 to 1. Scores at or below `0.70` are accepted;
scores above `0.70` through `0.95` are rejected; scores above `0.95` are sent
to the DLT. The thresholds can be changed with
`MODERATION_REJECT_THRESHOLD` and `MODERATION_DLT_THRESHOLD`.
Submitted text is sent to the TypeSafe API for scoring; avoid sending sensitive
content unless that processing is appropriate for your data.

Accepted example:

```bash
curl -i -X POST http://localhost:8080/api/messages \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ID_TOKEN" \
  -d '{"text":"Thanks for your help with this order."}'
```

Rejected example (Jev's assessment can vary by model version):

```bash
curl -i -X POST http://localhost:8080/api/messages \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ID_TOKEN" \
  -d '{"text":"You are a disgusting idiot, get lost."}'
```

The API returns `202 Accepted`. The final `VALIDATED` or `REJECTED` result is
shown in the chat and is visible in the application logs in Grafana and as an event in Kafbat UI. The
validation service needs `TYPESAFE_API_KEY`; if Jev is unavailable, Kafka's
listener retry handler sends the failed record to the DLT after its retries.

If Kafka does not confirm the send within 5 seconds (`message-api.kafka-send-timeout`),
the API returns `503` with `Retry-After: 5` and `"status":"UNCONFIRMED"`. The
message may still be delivered, so resend with the same `messageId`; only the
first result for a `messageId` is stored. `sendmessage.sh` does not send a
`messageId`, so the server generates one and a script retry creates a new message.

## Force a dead-letter event

The validation service publishes messages with Jev scores above the configured
DLT threshold to `poc.messages.submitted.v1-dlt`. The listener also retries
unexpected processing failures twice before sending them to that DLT. To force
the technical-failure path locally:

```bash
./sendmessage.sh "__FORCE_DLT__"
```

This reserved text deliberately makes the validation listener throw an
exception. Inspect the DLT in Kafbat UI at <http://localhost:8085>. The message
is sent through the API successfully, but it is not shown in the public chat.
`message-persistence` consumes the DLT event, stores it as a `DLT` row, and shows
it in the admin moderation log. It does not count as a strike unless
`MODERATION_TECHNICAL_DLT_COUNTS_AS_STRIKE=true`.

If `message-persistence` or `message-audit` fail to process a record from
`poc.messages.results.v1` (after two retries), the record is published to
`poc.messages.results.v1-dlt`; inspect it in Kafbat UI. Failures on the submitted
DLT itself are logged and skipped, not republished.

## Deployment

The application services are containerized and can run on Kubernetes-compatible
platforms. The portable manifests and instructions are in
[`deploy/kubernetes`](deploy/kubernetes/README.md). They expect managed or
platform-provided Kafka, PostgreSQL, and Loki; no cloud-specific stateful
services are bundled into the application deployment. Set `TYPESAFE_API_KEY`
through the platform's secret manager. `GOOGLE_CLIENT_ID` is public and goes in
the ConfigMap. See [`deploy/kubernetes/README.md`](deploy/kubernetes/README.md)
for the Google client setup, admins, moderation parameters, SSE and ingress
timeouts, and the direct-connection requirement for LISTEN/NOTIFY.

To run the application on Azure (AKS) for a demo, use the scripted showcase:
`scripts/azure-up.sh` creates the environment and deploys a release, and
`scripts/azure-down.sh` deletes it again. See "Scripted showcase" in
[`docs/deploy-to-azure.md`](docs/deploy-to-azure.md) for the setup, the costs and
the limits (the first real-Azure run needed several reruns and fixes; a full
clean run of the fixed scripts is still to be done).

Vercel can manage DNS for a domain whose runtime is hosted elsewhere. Point the
chosen subdomain at the ingress: a CNAME at the hostname supplied by the cluster
ingress/load balancer, or, when the ingress has a static IP as in the Azure
guide, an A record at that IP. Configure TLS at that ingress. See Vercel's
[instructions for pointing a subdomain to an external service](https://vercel.com/kb/guide/pointing-subdomains-to-external-services).

## Search centralized logs

Open Grafana, select **Explore**, and use the `Loki` data source. Some useful
LogQL queries are:

All application logs:

```logql
{environment="local"}
```

Structured logs from `message-persistence`:

```logql
{environment="local", service="message-persistence"} | json
```

Follow one message through all services by copying `correlationId` from the API
response:

```logql
{environment="local"} | json | correlationId="PUT-CORRELATION-ID-HERE"
```

Application log entries include `service`, `instanceId`, `eventId`,
`messageId`, and `correlationId`. Consumer logs also include Kafka topic,
partition, and offset. IDs remain JSON fields rather than Loki labels to avoid
high-cardinality labels.

All application containers can also be followed without Grafana:

```bash
docker compose logs -f message-api validation-service message-persistence
```

Alloy collects application containers started by Compose. Services started
directly with Gradle are intentionally not collected by this Docker-based
pipeline.

## Run multiple consumers

To demonstrate Kafka partition assignment across two `message-persistence` instances:

```bash
docker compose up -d --scale message-persistence=2
```

Use the `instanceId`, `partition`, and `offset` fields in Grafana to see which
instance processed each result.

After a code change, rebuild only the affected service, for example:

```bash
docker compose up --build -d message-persistence
```

## Reset local test data

Reset Kafka topics (recreated with replication factor 3 and `min.insync.replicas=2`), records, and application consumer-group offsets, then
restart the three Compose services:

```bash
./scripts/reset-local.sh
```

The normal project topology uses three partitions. For a simpler test where
every topic has only one partition:

```bash
./scripts/reset-local.sh --partitions 1
```

Also reset the PostgreSQL `public` schema:

```bash
./scripts/reset-local.sh --database
```

The script asks for confirmation unless `--yes` is supplied. It refuses to
delete topics while `bootRun` or IDE-started consumers are still members of the
Kafka groups; stop those processes and run it again. Use `--no-restart` to leave
the application services stopped after the reset.

Resetting records does not normally require changing the number of partitions.
Three partitions are intentional because they let the PoC demonstrate consumer
scaling and partition assignment. Use one partition only when that behavior is
not part of the test.

## Build and test

```bash
./gradlew build
```

The integration tests (`*IT` classes in `message-persistence` and `message-api`)
start a throwaway PostgreSQL 17 container with Testcontainers, so Docker must be
running for them to execute. Without Docker they are skipped, and only the unit
tests run. They cover the Flyway migrations, strikes, warnings and escalating
bans (including concurrent and redelivered events), LISTEN/NOTIFY fan-out, the
security rules for public, signed-in and admin endpoints, and `message-api`'s
posting checks and CORS. They never connect to the Compose Kafka or PostgreSQL,
so they can run while the local stack is up.

## CI, releases and deployment

GitHub Actions builds and tests every pull request and push to `main`, and also
builds the four images and renders the Kubernetes manifests. Each green push to
`main` is tagged with the next patch version (such as `v0.2.1`), which publishes
the images to GHCR, creates a GitHub release, and, once it is enabled, deploys the
release to AKS. See [CI, releases and deployment](docs/ci-cd.md).

## Stop

Keep data:

```bash
docker compose down
```

Delete all local Kafka, PostgreSQL, Loki, and Grafana data:

```bash
docker compose down --volumes
```

This also deletes locally retained Loki logs and Grafana state. Loki is
configured with seven-day retention while its volume exists.

See [the architecture description](docs/architecture.md) for the event flow.
