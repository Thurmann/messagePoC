# Kubernetes deployment

This portable Kubernetes base deploys the four application containers. By
default it expects Kafka in the cluster via the Strimzi operator (see
[Kafka](#kafka) below). PostgreSQL, Loki, and a log shipper are deliberately not
installed by these manifests; use managed services or the platform's supported
operators. The base itself does not include `kafka/`; overlays reference it, so
clusters with managed Kafka can skip it. An example overlay is in
`deploy/azure` (outside this directory, because kustomize forbids an overlay inside its own base).

## Kafka

The base ConfigMap points at `message-poc-kafka-bootstrap:9092` with
`PLAINTEXT`, the bootstrap service of a Strimzi `Kafka` cluster named
`message-poc` in the same namespace. The `kafka/` kustomization defines that
cluster (3 combined controller+broker KRaft nodes, one 10Gi volume each, so 3 PVCs)
and the four topics (3 partitions, replication factor 3, min ISR 2). Install the operator once per cluster, then apply `kafka/` (or an
overlay that includes it):

```sh
kubectl create namespace strimzi
helm install strimzi-cluster-operator oci://quay.io/strimzi-helm/strimzi-kafka-operator \
  -n strimzi --set watchAnyNamespace=true --version 1.3.1
kubectl apply -k deploy/kubernetes/kafka -n <namespace>
```

The manifests use the `kafka.strimzi.io/v1` API, which Strimzi 1.x serves (older
operators only serve `v1beta2`). The `version` in `kafka/kafka.yaml` (4.3.1) must be
supported by the installed operator release; Strimzi 1.3.1 supports it. The cluster runs 3 brokers with replication factor 3 and
`min.insync.replicas` 2. The services produce with `acks=all`, so min ISR 2
lets writes continue with one broker down and through rolling restarts (min ISR
3 would block writes whenever any broker is down). Pod anti-affinity is
preferred, so use at least 3 nodes to get one broker per node.

`message-persistence` also creates one topic that is not in `kafka/`:
`poc.health.v1` (1 partition, replication factor 3, min ISR 2, 1 hour retention).
It is created at startup if missing. The Kafka write probe writes to it every 10
seconds to report whether Kafka accepts writes, so expect a fifth topic. The
probe is configured by the `kafka-health` settings: `KAFKA_HEALTH_ENABLED`
(default `true`), `kafka-health.interval`, `kafka-health.timeout`,
`kafka-health.topic`, `kafka-health.replication-factor`,
`kafka-health.min-insync-replicas` and `kafka-health.failures-before-down`. For a
single-broker Kafka, set the replication factor and min ISR to `1`.

### Alternative: managed Kafka (Event Hubs, Confluent, ...)

Skip `kafka/` and override these ConfigMap values in an overlay:
`KAFKA_BOOTSTRAP_SERVERS` (the provider's address),
`SPRING_KAFKA_PROPERTIES_SECURITY_PROTOCOL: SASL_SSL` and
`SPRING_KAFKA_PROPERTIES_SASL_MECHANISM: PLAIN`. Add the key
`SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG` to `message-poc-secrets`. Create the
four topics with the provider's tooling.

`message-persistence` also needs `poc.health.v1` (see above). It creates the
topic at startup, which needs permission to create topics. If the identity
cannot create topics, create the topic by hand with the same settings, or set
`KAFKA_HEALTH_ENABLED=false` in the ConfigMap.

## Build and publish the application images

The repository's root `Dockerfile` builds one service per image. Replace the
registry and version in `kustomization.yaml`, then build and push each image:

```sh
docker build --build-arg SERVICE=message-api -t ghcr.io/your-org/message-api:0.1.0 .
docker build --build-arg SERVICE=validation-service -t ghcr.io/your-org/validation-service:0.1.0 .
docker build --build-arg SERVICE=message-persistence -t ghcr.io/your-org/message-persistence:0.1.0 .
docker build --build-arg SERVICE=message-audit -t ghcr.io/your-org/message-audit:0.1.0 .
docker push ghcr.io/your-org/message-api:0.1.0
docker push ghcr.io/your-org/validation-service:0.1.0
docker push ghcr.io/your-org/message-persistence:0.1.0
docker push ghcr.io/your-org/message-audit:0.1.0
```

For a private registry, create an `imagePullSecret` in the deployment namespace
and attach it to the pod specs.

## Configure and deploy

Edit `configmap.yaml` with the JDBC URL, Loki URL, and deployment environment
(and the Kafka settings only if you use managed Kafka). Supply credentials through the target platform's secret manager as
a Kubernetes Secret named `message-poc-secrets` with these keys:

- `TYPESAFE_API_KEY`
- `DB_PASSWORD` (used by both `message-persistence` and `message-api`)
- `SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG` only for managed Kafka that needs SASL (optional)

Do not commit secret values. Configure the target cluster's logging collector
to ship structured container stdout to the configured Loki endpoint using the
`service` field as a label; the audit panel queries `message-audit` entries
from Loki.

Change both hosts in `ingress.yaml` to your chosen DNS names and arrange a TLS
Secret named `message-poc-tls`. It is created by cert-manager through the
`cert-manager.io/cluster-issuer` annotation on the Ingress (added in an overlay),
or provided by the platform. The Ingress uses the cluster's default ingress class;
set `spec.ingressClassName` for clusters that require one. On OpenShift, use an
OpenShift Route for each host if the cluster does not provide an Ingress
controller.

Create the platform Secret, then deploy the resources:

```sh
kubectl apply -k deploy/kubernetes
```

The frontend is served by `message-persistence` at the first host, which also
routes `POST /api/messages` to `message-api` on that host. The second host
serves the API directly. Set `MESSAGE_API_URL` in `sendmessage.sh`'s caller
environment to `https://api.messages.example.com/api/messages`.

## Vercel-managed DNS

The app remains in the selected cloud/Kubernetes runtime; Vercel can continue
to manage the domain's DNS. Create CNAME records for the chosen subdomains that
point to the DNS target supplied by the cluster ingress/load balancer. For an
ingress that only supplies an IP address, use the DNS record type supported by
that target and Vercel. Use the exact target and certificate instructions from
the cloud/platform ingress service rather than Vercel's own hosting targets.

## Google sign-in client ID

The live chat signs users in with Google. Create an OAuth client in Google Cloud
Console (APIs & Services → Credentials → Create credentials → OAuth client ID)
with application type **Web application**. Add these authorized JavaScript origins:

- `http://localhost:8083` (local Compose)
- `https://messages.example.com` (the deployed frontend)

Put the resulting client ID into `GOOGLE_CLIENT_ID` in `configmap.yaml`. The
client ID is public and is not a secret, so the ConfigMap is the right place for
it. Both `message-api` and `message-persistence` read it and reject any ID token
whose audience is not this value. An empty value rejects every token.

## Administrators

`ADMIN_EMAILS` is a comma-separated list of email addresses. At startup,
`message-persistence` inserts those addresses into the `admin_user` table
(`ON CONFLICT DO NOTHING`), so the list bootstraps the first admins. A signed-in
user whose verified Google email is in `admin_user` gets the admin rail and the
moderation log. To add more admins without a redeploy, insert rows directly:

```sql
INSERT INTO admin_user (email, source) VALUES ('someone@example.com', 'MANUAL')
ON CONFLICT DO NOTHING;
```

Removing an address from `ADMIN_EMAILS` does not remove its row, so delete the row
explicitly if an admin should lose access. Admins are never banned but still get warnings, and their strikes are logged.

## Moderation parameters

These values in `configmap.yaml` control strikes and bans. They take effect when
the pods restart.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODERATION_WARNING_THRESHOLD` | `3` | Strikes at which the user sees a warning |
| `MODERATION_BAN_THRESHOLD` | `6` | Strikes at which a temporary ban starts |
| `MODERATION_BAN_LADDER` | `1m,5m,30m,2h,12h,24h` | Ban durations by escalation step; the last step repeats |
| `MODERATION_ESCALATION_WINDOW` | `1d` | A new ban counts as the next step if it starts within this time after the previous ban ended |
| `MODERATION_TECHNICAL_DLT_COUNTS_AS_STRIKE` | `false` | Whether messages that failed technically and went to the DLT count as strikes |

Score-based DLT and rejected messages always count as strikes. Strikes reset when
a ban ends.

## Live updates (SSE) and ingress timeouts

The chat and the admin rail use Server-Sent Events on `/api/chat/stream` and
`/api/admin/stream`. `message-persistence` sends a heartbeat every 15 seconds, and the
browser reconnects automatically and re-fetches the history on reconnect.

The ingress must not close idle streams early. The example `ingress.yaml` sets
the ingress-nginx annotations `proxy-read-timeout` and `proxy-send-timeout` to
`3600` and `proxy-buffering` to `off`. Other controllers need their equivalent
setting:

- **Azure Application Gateway Ingress Controller:** its request timeout defaults to
  30 seconds. Set `appgw.ingress.kubernetes.io/request-timeout` on the Ingress to a
  larger value. The heartbeat and client reconnect keep the chat working even if
  a connection is cut.

## Postgres LISTEN/NOTIFY needs a direct connection

Moderation publishes new results with `pg_notify`, and each `message-persistence`
replica holds one dedicated `LISTEN` connection. That connection must be a direct
session connection. It does not work through PgBouncer in transaction pooling
mode, because the session that listens is not kept.

On Azure Database for PostgreSQL Flexible Server, connect on port **5432**, not the
built-in PgBouncer port **6432**. Use `JDBC_URL` with port 5432 in `configmap.yaml`.

## Shared database

`message-api` reads `app_user` and `user_ban` from the same PostgreSQL database
that `message-persistence` migrates and writes. It uses the same `JDBC_URL`,
`DB_USER`, and `DB_PASSWORD`. `message-persistence` is the only writer of
strikes and bans. If `message-api` cannot reach the database, it returns 503 for
posts.
