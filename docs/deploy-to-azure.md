# Deploy Message PoC to Azure (AKS)

This guide deploys the four application services to Azure Kubernetes Service
(AKS) using the portable manifests in [`deploy/kubernetes`](../deploy/kubernetes/README.md).
The base manifests are reused unchanged. Everything Azure-specific lives in the
committed kustomize overlay [`deploy/azure`](../deploy/azure/README.md), where
you edit the placeholders in step 9. The services run in AKS. The images live in
Azure Container Registry (ACR), the database is Azure Database for PostgreSQL
Flexible Server, and Kafka runs inside the cluster through the Strimzi operator.
(Azure Event Hubs is covered in a short appendix at the end.)

This is a low-traffic proof-of-concept setup, not a highly available or hardened
production architecture. It has not been run end to end against an Azure
subscription. The commands were checked against the repository files. Treat the
first deployment as a learning run and check each step's output.

## What the repository already provides

- `Dockerfile` builds one service per image from a `SERVICE` build argument.
- `deploy/kubernetes` contains a ConfigMap (`message-poc-config`), four
  Deployments and Services, an Ingress, and a kustomization with placeholder
  image names (`ghcr.io/your-org/...`). It has no namespace, no
  `ingressClassName`, and no cert-manager annotation.
- The Ingress already carries the ingress-nginx annotations for long-lived
  Server-Sent Events (SSE) connections (`proxy-read-timeout`, `proxy-send-timeout`,
  `proxy-buffering`). The AKS application routing add-on runs a managed NGINX
  ingress controller, so these annotations apply as they are.
- The base ConfigMap defaults to in-cluster Strimzi: `KAFKA_BOOTSTRAP_SERVERS` is
  `message-poc-kafka-bootstrap:9092` and the security protocol is `PLAINTEXT`.
  `deploy/kubernetes/kafka` defines the Strimzi `Kafka` cluster `message-poc`
  and the four topics. The overlay includes it.
- `deploy/azure` is the committed Azure overlay: namespace, ACR image names,
  ConfigMap values, the Ingress class, hosts and cert-manager annotation, plus a
  `cluster-issuer.yaml`. It sits outside `deploy/kubernetes` because kustomize
  does not allow an overlay inside its own base directory.
- The Secret `message-poc-secrets` is read by name. The keys are `DB_PASSWORD`
  (message-api and message-persistence), `TYPESAFE_API_KEY` (validation-service),
  and the optional `SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG` (all four, only needed for
  managed Kafka).

## 1. Prerequisites

- An Azure subscription where you can create resource groups, AKS, ACR,
  PostgreSQL, and (for the appendix only) Event Hubs. Check that the region has
  quota for two `Standard_D2s_v5` nodes.
- Azure CLI (`az`), `kubectl`, and Helm 3. `psql` is needed for the database
  step, and Docker is optional (the guide uses `az acr build`).
- A clone of this repository, with the current directory set to its root.
- A TypeSafe API key for Jev (`TYPESAFE_API_KEY`).
- Access to Google Cloud Console for the OAuth client ID.
- Access to the Vercel DNS dashboard for the domain.

```bash
az login
az account set --subscription "<subscription-name-or-id>"
```

## 2. Set shell variables

Copy this block into the shell you will use for the rest of the guide. Choose
globally unique names for ACR and PostgreSQL. Replace the example values.

```bash
export RESOURCE_GROUP=rg-message-poc
export LOCATION=norwayeast
export ACR_NAME=acrmessagepoc001          # globally unique, lowercase letters and digits
export AKS_NAME=aks-message-poc
export PG_SERVER=pg-message-poc-001       # globally unique
export PG_ADMIN_USER=pgadmin
export NAMESPACE=message-poc              # must match `namespace:` in deploy/azure/kustomization.yaml
export HOST=messages.example.com          # frontend host; must match the overlay
export API_HOST=api.messages.example.com  # API host; must match the overlay
export IMAGE_TAG=0.1.0
```

Read the passwords into the shell without echoing them. Use alphanumeric
passwords for PostgreSQL, because the SQL in step 5 quotes them.

```bash
read -r -s -p "PostgreSQL admin password: " PG_ADMIN_PASSWORD; echo
read -r -s -p "PostgreSQL password for role message_poc: " DB_PASSWORD; echo
read -r -s -p "TypeSafe API key: " TYPESAFE_API_KEY; echo
```

## 3. Create ACR and build the four images

```bash
az group create -n "$RESOURCE_GROUP" -l "$LOCATION"
az acr create -g "$RESOURCE_GROUP" -n "$ACR_NAME" -l "$LOCATION" --sku Basic
export ACR_LOGIN_SERVER=$(az acr show -n "$ACR_NAME" --query loginServer -o tsv)
```

Build each service with the root `Dockerfile`. The `SERVICE` build argument
selects the Gradle module, which matches `deploy/kubernetes/README.md`. The
image names follow the `message-poc/<service>` pattern the base
kustomization expects.

```bash
for svc in message-api validation-service message-persistence message-audit; do
  az acr build \
    --registry "$ACR_NAME" \
    --image "message-poc/${svc}:${IMAGE_TAG}" \
    --file Dockerfile \
    --build-arg SERVICE="${svc}" \
    .
done
az acr repository list -n "$ACR_NAME" -o table
```

The Dockerfile starts with `# syntax=docker/dockerfile:1.7` and uses a BuildKit
cache mount (`RUN --mount=type=cache`). If `az acr build` fails on that line,
build locally instead. Log in to ACR, then build for `linux/amd64` and push:

```bash
az acr login -n "$ACR_NAME"
for svc in message-api validation-service message-persistence message-audit; do
  docker build --platform linux/amd64 --build-arg SERVICE="${svc}" \
    -t "${ACR_LOGIN_SERVER}/message-poc/${svc}:${IMAGE_TAG}" .
  docker push "${ACR_LOGIN_SERVER}/message-poc/${svc}:${IMAGE_TAG}"
done
```

Use a new `IMAGE_TAG` for every rebuild. The base workloads set
`imagePullPolicy: IfNotPresent`, so a node that already has a tag keeps the old
image when you push again under the same tag.

## 4. Create the AKS cluster

Create the cluster with ACR attached (so nodes can pull the images without
pull secrets) and the application routing add-on enabled (managed NGINX
ingress). Choose the node SKU that your quota allows.

```bash
az aks create -g "$RESOURCE_GROUP" -n "$AKS_NAME" -l "$LOCATION" \
  --node-count 2 \
  --node-vm-size Standard_D2s_v5 \
  --generate-ssh-keys \
  --attach-acr "$ACR_NAME" \
  --enable-app-routing

az aks get-credentials -g "$RESOURCE_GROUP" -n "$AKS_NAME" --overwrite-existing
kubectl get nodes
kubectl get ingressclass
```

The `ingressclass` output should include `webapprouting.kubernetes.azure.com`.
If you already have a cluster, attach the registry with
`az aks update -g "$RESOURCE_GROUP" -n "$AKS_NAME" --attach-acr "$ACR_NAME"`
and enable application routing with `az aks approuting enable -g "$RESOURCE_GROUP" -n "$AKS_NAME"`.

## 5. Create PostgreSQL Flexible Server

The application uses the database `message_poc` and the role `message_poc`,
which match `DB_USER` in the ConfigMap and the database name in `JDBC_URL`.
`message-persistence` runs Flyway migrations (V1 to V3) at startup, so the role
must own the database.

Create the server. The Burstable B1ms SKU keeps costs low. PostgreSQL 17
matches the `postgres:17-alpine` image in `compose.yaml`.

```bash
az postgres flexible-server create -g "$RESOURCE_GROUP" -n "$PG_SERVER" -l "$LOCATION" \
  --tier Burstable \
  --sku-name Standard_B1ms \
  --storage-size 32 \
  --version 17 \
  --admin-user "$PG_ADMIN_USER" \
  --admin-password "$PG_ADMIN_PASSWORD" \
  --yes
```

Flexible Server requires TLS by default. The guide uses public access with a
firewall rule for the AKS outbound IP, which is the simplest setup for a PoC.
The CLI may also add a rule for your current IP. Remove it afterwards if you do
not need it. For a more private setup, use VNet integration when creating the
server (`--vnet` and a delegated `--subnet`).

```bash
AKS_OUTBOUND_IP_ID=$(az aks show -g "$RESOURCE_GROUP" -n "$AKS_NAME" \
  --query "networkProfile.loadBalancerProfile.effectiveOutboundIps[0].id" -o tsv)
AKS_OUTBOUND_IP=$(az network public-ip show --ids "$AKS_OUTBOUND_IP_ID" --query ipAddress -o tsv)

az postgres flexible-server firewall-rule create -g "$RESOURCE_GROUP" -n "$PG_SERVER" \
  --rule-name aks-egress \
  --start-ip-address "$AKS_OUTBOUND_IP" \
  --end-ip-address "$AKS_OUTBOUND_IP"
```

Create the role and the database. Connect on port **5432**. Do not use the
built-in PgBouncer port 6432. Moderation uses `LISTEN`/`NOTIFY`, which needs a
direct session connection (see `deploy/kubernetes/README.md`).

```bash
export PGPASSWORD="$PG_ADMIN_PASSWORD"
psql "host=${PG_SERVER}.postgres.database.azure.com port=5432 dbname=postgres user=${PG_ADMIN_USER} sslmode=require" <<SQL
CREATE ROLE message_poc LOGIN PASSWORD '${DB_PASSWORD}';
CREATE DATABASE message_poc OWNER message_poc;
SQL
unset PGPASSWORD
```

## 6. Kafka: install the Strimzi operator

The services need four topics. The names come from
`contracts/src/main/kotlin/no/thurmann/messagepoc/contracts/KafkaTopics.kt`:

| Topic | Written by | Read by |
| --- | --- | --- |
| `poc.messages.submitted.v1` | message-api | validation-service (`validation-service-v1`) |
| `poc.messages.results.v1` | validation-service | message-persistence (`message-persistence-v1`), message-audit (`message-audit-v1`) |
| `poc.messages.submitted.v1-dlt` | validation-service | message-persistence, message-audit |
| `poc.messages.results.v1-dlt` | nothing in the code today | nothing |

`poc.messages.results.v1-dlt` is declared in `KafkaTopics.kt` but no code uses
it. It is created anyway so the names match the contract. `compose.yaml` creates
only three topics, and `scripts/reset-local.sh` lists stale topic names, so
do not copy those lists.

Kafka runs inside the cluster through [Strimzi](https://strimzi.io): a
single-node KRaft broker with a 10Gi persistent volume, the closest match to the
`apache/kafka` service in `compose.yaml`. You operate the broker yourself, so it
is not production-grade. The cluster and the topics are defined in
`deploy/kubernetes/kafka` and are applied together with the overlay in step 10.
Here you install only the operator, once per cluster:

```bash
kubectl create namespace strimzi
helm install strimzi-cluster-operator oci://quay.io/strimzi-helm/strimzi-kafka-operator \
  --namespace strimzi --set watchAnyNamespace=true
kubectl -n strimzi get pods
```

`kubectl -n strimzi get pods` should show the operator `Running`. Check that
the Kafka `version` in `deploy/kubernetes/kafka/kafka.yaml` (4.3.1, as in
`compose.yaml`) is supported by the installed operator release. If the operator
rejects it, set a version from that release's supported list.

The broker listens inside the cluster without TLS or SASL. The base ConfigMap
already sets `PLAINTEXT` and the bootstrap address
`message-poc-kafka-bootstrap:9092`, and no `SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG`
key is needed.

## 7. Ingress, TLS, and the public IP

The base Ingress has no `ingressClassName` and points to the TLS Secret
`message-poc-tls`. The overlay in step 9 adds the class, the hosts and the
cert-manager annotation. This
section sets up the controller and the certificate.

**Ingress controller.** The application routing add-on runs a managed
ingress-nginx controller. Its class is `webapprouting.kubernetes.azure.com`.
The nginx annotations in `ingress.yaml` work on it unchanged. After you apply
the overlay, confirm the SSE behavior in step 12 (a stream must stay open for
more than 60 seconds).

If you use Application Gateway for Containers or the Application Gateway
Ingress Controller (AGIC) instead, the nginx annotations are ignored. Add
`appgw.ingress.kubernetes.io/request-timeout` to the Ingress with a value
longer than the SSE connections. The base `ingress.yaml` comment mentions the
same annotation. This guide does not cover AGIC.

**Certificates.** Install cert-manager and a Let's Encrypt issuer that solves
HTTP-01 challenges through the application routing class:

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true
```

Wait until the cert-manager pods are `Running` (`kubectl -n cert-manager get pods`). Set the ACME contact email in `deploy/azure/cluster-issuer.yaml`, then apply it.
It is a cluster-scoped resource, so it is applied on its own and is not part of
the overlay's kustomization (the namespace transformer would add a namespace to it):

```bash
kubectl apply -f deploy/azure/cluster-issuer.yaml
```

The overlay adds `cert-manager.io/cluster-issuer: letsencrypt-prod`, so
cert-manager creates `message-poc-tls` after the hosts resolve (step 8).

**Public IP.** Read the external IP of the managed controller:

```bash
kubectl get svc -n app-routing-system nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}{"\n"}'
```

If the service name differs in your cluster, run `kubectl get svc -n app-routing-system`
and use the service that has an external IP. Azure allocates this IP, and it
can change if the service is recreated. To keep it stable, reserve a static
public IP in the AKS node resource group and reference it in the controller
configuration. Azure's application routing documentation describes that
setting.

## 8. Point DNS at the cluster

Keep Vercel as the DNS provider, as in the GCP guide. Add two **A** records
that point at the IP from step 7. Replace the example domain and IP:

| Type | Name | Value |
| --- | --- | --- |
| A | `messages` | `<INGRESS_IP>` |
| A | `api.messages` | `<INGRESS_IP>` |

Wait until both names resolve. Let's Encrypt cannot validate the certificate
until they do:

```bash
dig +short "$HOST"
dig +short "$API_HOST"
```

Vercel's [DNS record instructions](https://vercel.com/docs/domains/working-with-dns)
explain the record editor and propagation.

## 9. Edit the Azure overlay

The overlay in [`deploy/azure`](../deploy/azure/README.md) is committed. It
includes the base (`deploy/kubernetes`) and the Strimzi resources
(`deploy/kubernetes/kafka`) and patches what Azure changes: the namespace, the
image names (to your ACR), the ConfigMap values for PostgreSQL, Loki, Google
sign-in and admins, and the Ingress class, hosts and cert-manager annotation.
Edit these placeholders in `deploy/azure/kustomization.yaml`:

- `<your-acr>` in the four `newName` lines: your `$ACR_LOGIN_SERVER` without the
  `.azurecr.io` suffix, and `newTag` set to your `$IMAGE_TAG`
- `<pg-server>` in `JDBC_URL`: your `$PG_SERVER` (keep port 5432 and `sslmode=require`)
- `GOOGLE_CLIENT_ID` and `ADMIN_EMAILS`
- `messages.example.com` and `api.messages.example.com` (four places in the
  Ingress patch): your `$HOST` and `$API_HOST`
- `namespace:`, only if you do not use `message-poc`

Edit `email:` in `deploy/azure/cluster-issuer.yaml` as well (step 7).

Check the rendered output before applying. The image lines should show your ACR
login server, the hosts should be yours, and no `<...>` placeholder should remain:

```bash
kubectl kustomize deploy/azure | grep -E 'image:|host:|ingressClassName|<'
```

**Logs.** The overlay sets `LOKI_URL` to an in-cluster Loki service. The
`message-audit` panel reads from it, and step 11 deploys Loki.

**Google and admins.** `GOOGLE_CLIENT_ID` and `ADMIN_EMAILS` are the only app
settings that change per deployment. The base comments explain how they are
used. `MESSAGE_API_BASE_URL` stays empty so the frontend calls the API on the
same origin, and `CORS_ALLOWED_ORIGINS` stays empty. The other `MODERATION_*`
values keep their defaults. `MODERATION_TECHNICAL_DLT_COUNTS_AS_STRIKE` defaults
to `false`, and the overlay sets it explicitly. See step 13 before you change it.

## 10. Create the Secret and deploy

Create the Secret in the namespace before applying the overlay. The Deployments
reference it by name and key, and the required keys (`DB_PASSWORD` and
`TYPESAFE_API_KEY`) must exist or the pods will not start.

```bash
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic message-poc-secrets \
  --from-literal=DB_PASSWORD="$DB_PASSWORD" \
  --from-literal=TYPESAFE_API_KEY="$TYPESAFE_API_KEY"
```

Do not commit the Secret or write it to a file in the repository. Hardening
options are in step 15.

Deploy the overlay and wait for the services:

```bash
kubectl apply -k deploy/azure
kubectl -n "$NAMESPACE" get kafka,kafkatopic
kubectl -n "$NAMESPACE" rollout status deploy/message-persistence --timeout=5m
kubectl -n "$NAMESPACE" rollout status deploy/message-api --timeout=5m
kubectl -n "$NAMESPACE" rollout status deploy/validation-service --timeout=5m
kubectl -n "$NAMESPACE" rollout status deploy/message-audit --timeout=5m
```

Startup order matters. `message-persistence` runs Flyway against PostgreSQL
the first time it starts. The services retry while Kafka is still starting, so
some restarts at first are normal. Strimzi needs a few minutes to start the
broker and create the topics (`kubectl -n "$NAMESPACE" get kafka` should show
`READY True`) before you judge the result.

## 11. Observability: Loki for the audit panel

The `/api/audit-logs` endpoint in `message-persistence` calls Loki at `LOKI_URL`
and queries `{service="message-audit"}`. Without Loki it returns HTTP `502`
(the frontend shows an error in the audit panel). Azure Monitor Container
Insights is useful for cluster and pod metrics, but it does not provide the
Loki API that the endpoint reads.

The repo's `observability/` stack is local only. `observability/alloy/config.alloy`
discovers containers through the Docker socket, which does not exist on AKS
nodes. `observability/loki/config.yml` is reusable as is. This step deploys Loki
with the repo's config and a new Alloy configuration that reads pod logs
through the Kubernetes API. The Alloy file is new; it is not in the repo.

Load the repo's Loki config into a ConfigMap and deploy Loki with a persistent
volume:

```bash
kubectl -n "$NAMESPACE" create configmap loki-config \
  --from-file=config.yml=observability/loki/config.yml \
  --dry-run=client -o yaml | kubectl apply -f -

cat <<'EOF' | kubectl -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: loki-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 10Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loki
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: loki
  template:
    metadata:
      labels:
        app: loki
    spec:
      securityContext:
        fsGroup: 10001
      containers:
        - name: loki
          image: grafana/loki:3.7.0
          args: ["-config.file=/etc/loki/config.yml"]
          ports:
            - name: http
              containerPort: 3100
          volumeMounts:
            - name: config
              mountPath: /etc/loki
              readOnly: true
            - name: data
              mountPath: /loki
      volumes:
        - name: config
          configMap:
            name: loki-config
        - name: data
          persistentVolumeClaim:
            claimName: loki-data
---
apiVersion: v1
kind: Service
metadata:
  name: loki
spec:
  selector:
    app: loki
  ports:
    - name: http
      port: 3100
      targetPort: http
EOF
```

Create the Alloy configuration. It keeps only the four application pods and
sets the `service` label from the `app` label. The audit query depends on that
label.

```bash
cat > observability/alloy/kubernetes.alloy <<'EOF'
discovery.kubernetes "pods" {
  role = "pod"
  namespaces {
    names = ["message-poc"]
  }
}

discovery.relabel "message_poc" {
  targets = discovery.kubernetes.pods.targets

  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    regex         = "message-api|validation-service|message-persistence|message-audit"
    action        = "keep"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "service"
  }

  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }

  rule {
    replacement  = "poc"
    target_label = "environment"
  }
}

loki.source.kubernetes "message_poc" {
  targets    = discovery.relabel.message_poc.output
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}
EOF
```

Install Alloy with Helm. Run it as a single Deployment. `loki.source.kubernetes`
reads logs through the API, so several replicas would send duplicates. The
Helm value names can change between chart versions. Check them with
`helm show values grafana/alloy` if the install rejects a flag.

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
helm upgrade --install alloy grafana/alloy -n "$NAMESPACE" \
  --set controller.type=deployment \
  --set-file alloy.configMap.content=observability/alloy/kubernetes.alloy
```

Query Loki from your machine with a port-forward:

```bash
kubectl -n "$NAMESPACE" port-forward svc/loki 3100:3100 &
curl -G -s "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={service="message-audit"}' --data-urlencode 'limit=5'
```

Grafana is not deployed. The repo's Grafana (`grafana/grafana:13.2.0`, with the
provisioned Loki datasource) can be run in the cluster the same way if you want
the Explore view. Its datasource URL would be `http://loki:3100`.

## 12. Verify the deployment

Check the pods and the Ingress:

```bash
kubectl -n "$NAMESPACE" get pods
kubectl -n "$NAMESPACE" get ingress message-poc
kubectl -n "$NAMESPACE" get certificate
kubectl -n "$NAMESPACE" describe certificate message-poc-tls
```

All pods should be `Running` and `READY`. The certificate should become `True`
after DNS resolves. If it stays `False`, look at the `Challenge` objects
(`kubectl -n "$NAMESPACE" get challenges`).

Check the health endpoints. The Ingress routes `/` on the frontend host to
`message-persistence` and `/api/messages` to `message-api`. The API host
routes everything to `message-api`. The health endpoints are public:

```bash
curl -fsS "https://${API_HOST}/actuator/health"
curl -fsS "https://${HOST}/actuator/health"
```

`validation-service` and `message-audit` have no Ingress. Check them through
their logs, or port-forward to their health endpoints.

Check the frontend configuration. The `messageApiBaseUrl` value should be an
empty string, which means the browser calls the API on the same origin:

```bash
curl -fsS "https://${HOST}/api/config"
```

Check the logs. The services log JSON. Look for Flyway, the database listener,
and Kafka:

```bash
kubectl -n "$NAMESPACE" logs deploy/message-persistence --tail=200 | grep -iE 'flyway|Listening for chat_events|error'
kubectl -n "$NAMESPACE" logs deploy/validation-service --tail=100
kubectl -n "$NAMESPACE" logs deploy/message-api --tail=100
```

Check that SSE stays open. The chat uses Server-Sent Events, which must not be
closed by the ingress after 30 to 60 seconds. This command should still be
running after 90 seconds:

```bash
curl -N --max-time 90 "https://${HOST}/api/chat/stream"
```

Open `https://<HOST>` in a browser. Sign in with Google (the origin must be
authorized, see the next section). Choose a handle, then run the moderation
checklist in step 13.

To post from the command line, copy the ID token from the browser console
(`sessionStorage.getItem("idToken")`) and use the repository's helper:

```bash
export ID_TOKEN=eyJ...
MESSAGE_API_URL="https://${API_HOST}/api/messages" ./sendmessage.sh "A message sent to the Azure deployment"
```

### Google sign-in origin

Google's authorized JavaScript origins are exact matches. In Google Cloud
Console, open **APIs & Services → Credentials**, edit the Web application OAuth
client, and add:

- `https://messages.example.com` (replace with `$HOST`)

Keep `http://localhost:8083` if you still run the local stack. The client ID
is public and is set in the overlay, so it is not a secret. An ID token whose
audience does not match `GOOGLE_CLIENT_ID` is rejected with `401`.

## 13. Run the moderation checklist

The `MODERATION_*` settings are in `configmap.yaml`, and the overlay in step 9
sets `MODERATION_TECHNICAL_DLT_COUNTS_AS_STRIKE` to `"false"`. Run this checklist
after the first deployment.

Strike rules for the DLT:

- A score-based DLT result (Jev scores above `MODERATION_DLT_THRESHOLD`) always
  counts as a strike.
- A technical DLT failure (for example, a missing `TYPESAFE_API_KEY` or Jev being
  down) does **not** count as a strike while `MODERATION_TECHNICAL_DLT_COUNTS_AS_STRIKE`
  is `"false"`, which is the default. Set it to `"true"` only if you want
  technical failures to count, because then every message in an outage can
  ban users after six messages.

1. **Clean message.** Post `Thanks for your help with this order.` It should
   appear in the chat for everyone after a few seconds.
2. **Rude message.** Post `You are a disgusting idiot, get lost.` It should be
   replaced by `A message from <handle> was removed by moderation.` Sign in as
   an admin (an address in `ADMIN_EMAILS`) and check the moderation log. The
   user should have one strike.
3. **Warning at 3 strikes** (`MODERATION_WARNING_THRESHOLD`). Post rude messages
   until the warning appears.
4. **Ban at 6 strikes** (`MODERATION_BAN_THRESHOLD`). Posting should return
   `403` with `BANNED` and `bannedUntil` until the first ban (1 minute on the
   default ladder) ends.

5. **Admins are never banned.** Sign in as an admin and repeat the rude
   messages. The admin still gets the warning at 3 strikes, but is never banned
   and can keep posting.

Jev's score can vary by model version. If a rude message is accepted, adjust
the text, not the thresholds.

## 14. Costs and cleanup

The main costs are the two AKS nodes, the PostgreSQL server, and the Azure
public IP and load balancer.
ACR Basic and the Strimzi PVCs also cost something. Check the current prices in
the Azure pricing calculator for your region.

To pause the work without deleting data, stop the cluster and the database:

```bash
az aks stop -g "$RESOURCE_GROUP" -n "$AKS_NAME"
az postgres flexible-server stop -g "$RESOURCE_GROUP" -n "$PG_SERVER"
```

Start them again with `az aks start` and `az postgres flexible-server start`.
PostgreSQL restarts itself after seven days if it is stopped.

To remove everything, delete the resource group. This also removes the AKS node
resource group that AKS creates:

```bash
az group delete -n "$RESOURCE_GROUP" --yes --no-wait
```

Remove the Vercel DNS records and the Google origin afterwards.

## 15. Optional hardening: Azure Key Vault

The Secret in step 10 is a plain Kubernetes Secret. For a stronger setup, keep
the values in Azure Key Vault and sync them into the same `message-poc-secrets`
Secret with the Secrets Store CSI driver and workload identity. The Deployments
can then stay unchanged.

- Enable the add-on: `az aks enable-addons --addons azure-keyvault-secrets-provider -g "$RESOURCE_GROUP" -n "$AKS_NAME"`.
- Enable OIDC and workload identity on the cluster: `az aks update -g "$RESOURCE_GROUP" -n "$AKS_NAME" --enable-oidc-issuer --enable-workload-identity`.
- Create a Key Vault with RBAC authorization, store `DB_PASSWORD` and `TYPESAFE_API_KEY` as secrets, and grant a managed identity read access.
- Add a `SecretProviderClass` with `secretObjects` that creates `message-poc-secrets` with the same keys. The Secret is created only when a pod mounts the CSI volume, so the overlay also needs a volume mount in each pod that reads a key.

Do not create the Secret by hand after you enable this.

## Troubleshooting

- **Pods show `ImagePullBackOff`:** the ACR is not attached to the cluster, or
  the image tag does not exist. Run `az acr repository show-tags -n "$ACR_NAME" --repository message-poc/message-api`
  and check that the cluster has the `AcrPull` role (`az aks update ... --attach-acr`).
- **Pods show `CreateContainerConfigError`:** the Secret or a required key is
  missing. Check `kubectl -n "$NAMESPACE" describe pod <name>`. `DB_PASSWORD` and
  `TYPESAFE_API_KEY` are not optional.
- **Browser cannot open the site:** check that both DNS records resolve to the
  ingress IP, that `kubectl -n "$NAMESPACE" get ingress` shows the address, and
  that the certificate is `True`.
- **Certificate stays `False`:** DNS has not propagated yet, or HTTP-01 cannot
  reach the challenge. Check `kubectl -n "$NAMESPACE" get challenges` and
  `kubectl describe order`.
- **SSE stops after 30 to 60 seconds:** the ingress timeout is too short. With
  application routing, confirm the nginx annotations are applied
  (`kubectl -n "$NAMESPACE" describe ingress message-poc`). With AGIC, set
  `appgw.ingress.kubernetes.io/request-timeout`.
- **Live chat is silent but history loads:** the `LISTEN` connection is not a
  direct session. The JDBC URL must use port 5432, not 6432 (PgBouncer). Check
  that `JDBC_URL` in the overlay ends with `:5432/message_poc?sslmode=require`.
- **401 on sign-in or `POST /api/messages`:** `GOOGLE_CLIENT_ID` does not match
  the client that issued the token, or the origin is not in the authorized
  JavaScript origins. Check `curl -fsS https://${HOST}/api/config`.
- **CORS errors in the browser:** should not happen with this setup. The page
  and `POST /api/messages` share the `messages` host through the Ingress, and
  `CORS_ALLOWED_ORIGINS` is empty. If you see them, check that
  `MESSAGE_API_BASE_URL` is empty in the overlay's effective ConfigMap
  (`kubectl -n "$NAMESPACE" get configmap message-poc-config -o yaml`).
- **Flyway failures in `message-persistence`:** usually the role does not own
  the database, or the connection failed. Check the logs for the error, then
  confirm with `psql` that `message_poc` owns `message_poc`.
- **Kafka connection errors or `Topic ... not present`:** check
  `kubectl -n "$NAMESPACE" get kafka,kafkatopic`. If the `Kafka` resource does not
  become ready, check the operator logs (`kubectl -n strimzi logs deploy/strimzi-cluster-operator`)
  and that the Kafka `version` is supported by the operator. If the ConfigMap
  still has `SASL_SSL`, set `SPRING_KAFKA_PROPERTIES_SECURITY_PROTOCOL` back to
  `PLAINTEXT`. The bootstrap address must be `message-poc-kafka-bootstrap:9092`
  and the pods must run in the same namespace as the `Kafka` resource.
- **Audit panel returns `502`:** Loki is not reachable at `LOKI_URL`, or the
  `service` label is missing. Check the port-forward in step 11 and the Alloy logs.

## Alternative: managed Kafka with Azure Event Hubs

Use this instead of Strimzi if you prefer a managed service. Skip step 6 and
remove `../kubernetes/kafka` from `resources` in `deploy/azure/kustomization.yaml`.
Event Hubs exposes a Kafka endpoint on port 9093 with SASL/SSL and PLAIN, and
each Kafka topic becomes an event hub with the same name. The Standard tier or
higher is required.

```bash
export EH_NAMESPACE=evh-message-poc-001   # globally unique
export TOPICS="poc.messages.submitted.v1 poc.messages.results.v1 poc.messages.submitted.v1-dlt poc.messages.results.v1-dlt"

az eventhubs namespace create -g "$RESOURCE_GROUP" -n "$EH_NAMESPACE" -l "$LOCATION" --sku Standard
for t in $TOPICS; do
  az eventhubs eventhub create -g "$RESOURCE_GROUP" --namespace-name "$EH_NAMESPACE" \
    -n "$t" --partition-count 3 --message-retention 1
done
az eventhubs namespace authorization-rule create -g "$RESOURCE_GROUP" \
  --namespace-name "$EH_NAMESPACE" -n message-poc --rights Send Listen
EH_CONN=$(az eventhubs namespace authorization-rule keys list -g "$RESOURCE_GROUP" \
  --namespace-name "$EH_NAMESPACE" -n message-poc --query primaryConnectionString -o tsv)
export JAAS_CONFIG=$(printf '%s' 'org.apache.kafka.common.security.plain.PlainLoginModule required username="$ConnectionString" password="'"${EH_CONN}"'";')
```

Add these keys to the ConfigMap patch in `deploy/azure/kustomization.yaml`:

```yaml
KAFKA_BOOTSTRAP_SERVERS: "<eh-namespace>.servicebus.windows.net:9093"
SPRING_KAFKA_PROPERTIES_SECURITY_PROTOCOL: "SASL_SSL"
SPRING_KAFKA_PROPERTIES_SASL_MECHANISM: "PLAIN"
```

Add the JAAS value to the Secret in step 10 as the extra key
`SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG="$JAAS_CONFIG"`. If a consumer logs
that a consumer group is missing, create `validation-service-v1`,
`message-persistence-v1` and `message-audit-v1` on the hubs they read. The Event
Hubs Kafka layer has not been tested with this PoC. Idempotent producers and
transactions are the most likely points of difference from Apache Kafka.
