# Message PoC

Kotlin/Spring Boot PoC for Kafka application development. The project contains
four services, shared event contracts, Kafka, PostgreSQL-backed message
results, Kafbat UI, and centralized local logging with Grafana Alloy, Loki, and
Grafana.

## Prerequisites

- Java 21
- Docker with Docker Compose

The project uses its own Gradle Wrapper; no global Gradle installation is
required.

## Start the complete local environment

Set a TypeSafe API key before starting the validation service:

```bash
cp .env.example .env
# Edit .env and set TYPESAFE_API_KEY
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

Kafka is available at `localhost:9092`, PostgreSQL at `localhost:5432`, and
the API at `localhost:8080`. The message inbox is served by
`message-persistence` at <http://localhost:8083>.

Local tools:

| Tool | URL | Purpose |
| --- | --- | --- |
| Kafbat UI | <http://localhost:8085> | Inspect Kafka topics, records, and consumer groups |
| Message inbox | <http://localhost:8083> | Compare database results with recent `message-audit` logs |
| Grafana | <http://localhost:3000> | Search logs from all application instances |
| Alloy UI | <http://localhost:12345> | Inspect the local log collection pipeline |
| Loki readiness | <http://localhost:3100/ready> | Check whether the log store is ready |

The Grafana instance is bound to localhost and allows anonymous local access,
including Explore for log queries. The Loki data source is provisioned
automatically.

## Send messages

Send a message using the helper script:

```bash
./sendmessage.sh "some text to be shown in the frontend"
```

It posts to `http://localhost:8080/api/messages`. Set `MESSAGE_API_URL` to use a
different API address. The inbox refreshes every five seconds; messages appear
after the Kafka validation and persistence steps finish.

The database-backed JSON endpoint is also available at
`http://localhost:8083/api/messages`.
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
  -d '{"text":"Thanks for your help with this order."}'
```

Rejected example (Jev's assessment can vary by model version):

```bash
curl -i -X POST http://localhost:8080/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"You are a disgusting idiot, get lost."}'
```

The API returns `202 Accepted`. The final `VALIDATED` or `REJECTED` result is
visible in the application logs in Grafana and as an event in Kafbat UI. The
validation service needs `TYPESAFE_API_KEY`; if Jev is unavailable, Kafka's
listener retry handler sends the failed record to the DLT after its retries.

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
is sent through the API successfully, but it is not written to the normal
results topic or the message inbox.

## Deployment

The application services are containerized and can run on Kubernetes-compatible
platforms. The portable manifests and instructions are in
[`deploy/kubernetes`](deploy/kubernetes/README.md). They expect managed or
platform-provided Kafka, PostgreSQL, and Loki; no cloud-specific stateful
services are bundled into the application deployment. Set `TYPESAFE_API_KEY`
through the platform's secret manager.

Vercel can manage DNS for a domain whose runtime is hosted elsewhere. Point the
chosen subdomain CNAME at the hostname supplied by the cluster ingress/load
balancer, and configure TLS at that ingress. See Vercel's
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

Reset Kafka topics, records, and application consumer-group offsets, then
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
