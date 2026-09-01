# Message PoC

Local Kotlin/Spring Boot PoC for learning Kafka application development. This
first milestone contains three independently runnable services, shared event
contracts, Kafka in KRaft mode, PostgreSQL for the next milestone, and Kafbat UI.

## Prerequisites

- Java 21
- Docker with Docker Compose

The project uses its own Gradle Wrapper; no global Gradle installation is
required.

## Start local infrastructure

```bash
docker compose up -d
docker compose ps
```

Kafka is available at `localhost:9092`, PostgreSQL at `localhost:5432`, and
Kafbat UI at <http://localhost:8085>.

## Start the services

Run each command in a separate terminal:

```bash
./gradlew :services:message-view:bootRun
./gradlew :services:validation-service:bootRun
./gradlew :services:message-api:bootRun
```

Ports:

| Service | Port |
| --- | ---: |
| message-api | 8080 |
| validation-service | 8081 |
| message-view | 8082 |

## Send messages

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
visible in the `message-view` terminal and in Kafbat UI.

## Build and test

```bash
./gradlew build
```

## Stop

Keep data:

```bash
docker compose down
```

Delete local Kafka and PostgreSQL data:

```bash
docker compose down --volumes
```

See [the architecture description](docs/architecture.md) for the event flow.
