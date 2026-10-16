# Message PoC

Local Kotlin/Spring Boot PoC for learning Kafka application development. The
project contains three services, shared event contracts, Kafka in KRaft mode,
PostgreSQL for a later milestone, Kafbat UI, and centralized local logging with
Grafana Alloy, Loki, and Grafana.

## Prerequisites

- Java 21
- Docker with Docker Compose

The project uses its own Gradle Wrapper; no global Gradle installation is
required.

## Start the complete local environment

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
different API address. The inbox refreshes every three seconds; messages appear
after the Kafka validation and persistence steps finish.

The database-backed JSON endpoint is also available at
`http://localhost:8083/api/messages`.
The adjacent audit panel reads the 50 newest result entries from `message-audit`
through Loki at `http://localhost:8083/api/audit-logs`.

Accepted by the validation rule:

```bash
curl -i -X POST http://localhost:8080/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"Order 123 is ready"}'
```

Rejected by the validation rule:

```bash
curl -i -X POST http://localhost:8080/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"text":"No digits here"}'
```

The API returns `202 Accepted`. The final `VALIDATED` or `REJECTED` result is
visible in the application logs in Grafana and as an event in Kafbat UI.

## Force a dead-letter event

The validation service retries a failed record twice, then publishes it to
`poc.messages.submitted.v1-dlt`. To trigger this path:

```bash
./sendmessage.sh "__FORCE_DLT__"
```

This reserved text deliberately makes the validation listener throw an
exception. Inspect the DLT in Kafbat UI at <http://localhost:8085>. The message
is sent through the API successfully, but it is not written to the normal
results topic or the message inbox.

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
