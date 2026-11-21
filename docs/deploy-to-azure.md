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
production architecture. The scripted path below has been used once against a
real Pay-As-You-Go subscription (Sweden Central, Azure CLI 2.93, Helm 4.3,
Strimzi 1.3.1, cert-manager v1.21.3). That first run needed several reruns, and
the fixes are in the scripts and this guide, but the fixed scripts have not yet
had a single clean run from an empty subscription. The manual steps follow the
same commands, but have not been run on their own, so check each step's output.

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

## Scripted showcase (recommended for occasional demos)

If you only need the environment for a few hours at a time, do not keep it
running. Two scripts create and delete it:

- [`scripts/azure-up.sh`](../scripts/azure-up.sh) creates everything and deploys a
  released version (about 20 to 30 minutes).
- [`scripts/azure-down.sh`](../scripts/azure-down.sh) deletes it again, after an
  optional database backup.

The environment is split into two resource groups:

- The **persistent** group (`PERSISTENT_RG`) holds only one resource, the
  static public IP of the ingress. It survives `azure-down.sh`, so the DNS
  records and the Google origin stay valid between showcases.
- The **ephemeral** group (`EPHEMERAL_RG`) holds the container registry, the AKS
  cluster (with its node resource group) and PostgreSQL. `azure-down.sh` deletes
  it, and `azure-up.sh` creates it again.

Both scripts are written for Bash 3.2, so they run with the macOS default shell.
They need `az`, `kubectl`, Helm, `psql`, `openssl`, `curl` and `git`, plus
`pg_dump` and `pg_restore` for backups. `gh` and `dig` are optional. On macOS,
`brew install azure-cli` installs `az`.

**One-time setup.**

1. Sign in and select the subscription: `az login`, then
   `az account set --subscription "<subscription-name-or-id>"`.
2. Copy the settings file and fill in the values. The file is ignored by Git.
   Environment variables with the same names override it, and it must not contain
   secrets (the scripts reject `TYPESAFE_API_KEY`, `DB_PASSWORD` and similar keys):

   ```bash
   cp scripts/azure.env.example scripts/azure.env
   ```

   Set at least `AZ_SUBSCRIPTION`, `HOST`, `API_HOST`, `ACME_EMAIL` and
   `ADMIN_EMAILS`. The ACR and PostgreSQL names must be globally unique.
3. Run `./scripts/azure-up.sh --dry-run` to see the checks and the plan without
   changing anything. Then run `./scripts/azure-up.sh`. The first run reserves
   the static IP and prints it. The script asks for `TYPESAFE_API_KEY` unless it
   is exported.
4. In the Vercel DNS dashboard, create **A** records for `HOST` and `API_HOST`
   that point at the printed static IP (step 8). You set them once.
5. Add `https://<HOST>` as an authorized JavaScript origin of the Google OAuth
   client (step 12).

**Each showcase.**

1. Run `./scripts/azure-up.sh` about 20 to 30 minutes before you need the
   environment. The script deploys the latest release; use `--version X.Y.Z` to
   choose one. It ends with the URLs and a reminder to tear down.
2. Run `./scripts/azure-down.sh` afterwards. It offers a database backup
   (`--backup` or `--no-backup` to answer in advance) and deletes the ephemeral
   group. Restore a backup in the next run with `--restore-db FILE`.

**Confirmations.** Before it changes anything, each script prints what it will
create or delete, what data is lost and what it costs. It then asks twice:
`Continue? [y/N]`, and you type the name of the ephemeral resource group.
Anything but `y` stops the script without a change. For automation only,
`--yes-i-understand` skips both questions. It does not skip the extra
confirmation of `azure-down.sh --include-persistent`, which deletes the static
IP as well. After that the IP is released for good, the next run gets a new
address, and you have to change the DNS records.

**Backups and certificates.** Backups are written outside the repository, by
default to `~/message-poc-backups` (`--backup-dir` or `BACKUP_DIR` change it).
`azure-down.sh` also saves the TLS Secret, and `azure-up.sh` reuses it when it
is still valid for at least seven days, so that repeated showcases do not hit
the Let's Encrypt rate limits (`--no-save-tls` and `--no-restore-tls` turn this
off). For test runs, use `./scripts/azure-up.sh --staging-cert`; browsers warn
about the staging certificate. `--with-loki` also deploys Loki and Alloy for the
audit panel (step 11).

**Secrets on the command line.** The generated PostgreSQL admin password and the
GHCR token are passed to `az` as command-line arguments, so they are visible in
the local process list (for example with `ps`) while those commands run. Run the
scripts only on a machine you trust.

**Costs** (approximate, check the Azure pricing calculator for your region):

| State | Cost |
| --- | --- |
| Running | about $11 to $13 per day, or about $0.50 per hour |
| Idle (only the persistent group) | about $0.12 per day for the static IP |
| One 6-hour showcase, including setup and teardown | about $3 to $4 |

Billing starts when the resources exist, even if a script fails halfway. If you
forget to tear down, the running cost adds up to about $350 to $400 per month.

**Region and VM size.** Before it creates anything, `azure-up.sh` checks that
`AKS_NODE_VM_SIZE` is offered to your subscription in `LOCATION` and that the
VM family has enough vCPU quota for `AKS_NODE_COUNT` nodes. New Pay-As-You-Go
subscriptions are not offered VMs in every region: in testing, `norwayeast` and
`northeurope` returned `NotAvailableForSubscription` for every small D-series size,
and the `DSv5` family had a quota of 0 everywhere. The defaults are therefore
`swedencentral` and `Standard_D2s_v6` (2 vCPU, 8 GB). To check another region
yourself:

```bash
az vm list-skus -l <region> --size Standard_D2s_v6 --all \
  --query "[0].{family:family, blocked:restrictions[?type=='Location'].reasonCode}" -o json
az vm list-usage -l <region> -o table | grep -iE "Total Regional|Dsv6"
```

`list-usage` returns nothing until the `Microsoft.Compute` provider is
registered (`az provider register --namespace Microsoft.Compute --wait`, free).

**Reruns.** The scripts are safe to rerun after a failure. On a rerun,
`azure-up.sh` reuses what exists and skips slow steps that are already done:
PostgreSQL firewall rules, images already in the registry, and the Strimzi and
cert-manager releases when they are installed at the pinned chart versions
(`STRIMZI_CHART_VERSION`, `CERT_MANAGER_CHART_VERSION`). It still resets the
PostgreSQL admin password, because that password is generated per run and never
stored.

**Manifests from the release tag.** `azure-up.sh` renders `deploy/` from the
release tag it deploys, so a fix to the manifests takes effect with the next
release. To deploy manifest changes that are not released yet, add
`--manifests-from-worktree`; the images are still the release's. The summary
shows which source is used.

**Limitations.** The manual guide below explains what each script step does. The scripts do not change any GitHub setting; see
[CI, releases and deployment](ci-cd.md) for how they interact with the deploy
workflow.

## 1. Prerequisites

- An Azure subscription where you can create resource groups, AKS, ACR,
  PostgreSQL, and (for the appendix only) Event Hubs. Check that the region
  offers the node size to your subscription and has quota for three nodes
  (see "Region and VM size" above).
- Azure CLI (`az`, tested with 2.93), `kubectl`, and Helm 3 or 4. `psql` is needed for the database
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
export LOCATION=swedencentral
export PERSISTENT_RG=rg-message-poc-persistent   # holds only the static ingress IP (step 7)
export INGRESS_PIP_NAME=pip-message-poc-ingress
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
ingress). Choose the node SKU that your quota allows. Use at least 3 nodes so
the pod anti-affinity can place one Kafka broker per node.

```bash
az aks create -g "$RESOURCE_GROUP" -n "$AKS_NAME" -l "$LOCATION" \
  --node-count 3 \
  --node-vm-size Standard_D2s_v6 \
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

az postgres flexible-server firewall-rule create -g "$RESOURCE_GROUP" --server-name "$PG_SERVER" \
  --name aks-egress \
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
# On Azure the public schema belongs to azure_pg_admin, not to the database owner.
# Without this, Flyway fails with "permission denied for schema public".
psql "host=${PG_SERVER}.postgres.database.azure.com port=5432 dbname=message_poc user=${PG_ADMIN_USER} sslmode=require" \
  -c 'ALTER SCHEMA public OWNER TO message_poc'
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
| `poc.messages.results.v1-dlt` | message-persistence, message-audit (after retries) | nothing (inspect manually) |

`poc.messages.results.v1-dlt` receives result records that message-persistence
or message-audit failed to process after two retries. No service consumes it;
inspect it with a Kafka client or Kafbat UI. The same four topics are created by
`compose.yaml` and `scripts/reset-local.sh` locally.

Kafka runs inside the cluster through [Strimzi](https://strimzi.io): a
three-node KRaft cluster (combined controller and broker roles) with a 10Gi
persistent volume per node, so 3 PVCs. Topics use replication factor 3 and
`min.insync.replicas` 2, which lets writes (the services use `acks=all`)
continue with one broker down and survive rolling restarts. You operate the
brokers yourself, so it is not production-grade. The cluster and the topics are defined in
`deploy/kubernetes/kafka` and are applied together with the overlay in step 10.
Here you install only the operator, once per cluster:

```bash
kubectl create namespace strimzi
helm install strimzi-cluster-operator oci://quay.io/strimzi-helm/strimzi-kafka-operator \
  --namespace strimzi --set watchAnyNamespace=true --version 1.3.1
kubectl -n strimzi get pods
```

`kubectl -n strimzi get pods` should show the operator `Running`. Pin the chart
version. The manifests in `deploy/kubernetes/kafka` use the `kafka.strimzi.io/v1`
API, which Strimzi 1.x serves (it no longer serves `v1beta2`), and Kafka 4.3.1 (as
in `compose.yaml`), which Strimzi 1.3.1 supports. Before you change the chart
version, check that the release still serves `v1` and supports that Kafka
`version`.

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
  --set crds.enabled=true --version v1.21.3
```

On AKS, the admissions enforcer adds a `namespaceSelector` to the cert-manager
webhook configurations. A later `helm upgrade` with Helm 4 (server-side apply)
then fails with `conflict with "admissionsenforcer"`. Add `--force-conflicts` to
the upgrade; the enforcer adds its selector again afterwards.

Wait until the cert-manager pods are `Running` (`kubectl -n cert-manager get pods`). Set the ACME contact email in `deploy/azure/cluster-issuer.yaml`, then apply it.
It is a cluster-scoped resource, so it is applied on its own and is not part of
the overlay's kustomization (the namespace transformer would add a namespace to it):

```bash
kubectl apply -f deploy/azure/cluster-issuer.yaml
```

The overlay adds `cert-manager.io/cluster-issuer: letsencrypt-prod`, so
cert-manager creates `message-poc-tls` after the hosts resolve (step 8).

**Public IP.** By default Azure allocates the ingress IP in the AKS node
resource group, so it is lost when the cluster is deleted. To keep one address
across clusters (the scripts do this), reserve a static IP in a separate
resource group and point the managed controller at it. Create the group and the
IP:

```bash
az group create -n "$PERSISTENT_RG" -l "$LOCATION" \
  --tags project=message-poc managed-by=message-poc-scripts lifecycle=persistent
az network public-ip create -g "$PERSISTENT_RG" -n "$INGRESS_PIP_NAME" -l "$LOCATION"   --sku Standard --allocation-method Static --version IPv4
export INGRESS_IP=$(az network public-ip show -g "$PERSISTENT_RG" -n "$INGRESS_PIP_NAME" \
  --query ipAddress -o tsv)
echo "$INGRESS_IP"
```

The identity of the AKS cluster needs the **Network Contributor** role on that
resource group, so that the load balancer can use an IP outside the node
resource group:

```bash
AKS_PRINCIPAL_ID=$(az aks show -g "$RESOURCE_GROUP" -n "$AKS_NAME" --query identity.principalId -o tsv)
az role assignment create --assignee-object-id "$AKS_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal --role "Network Contributor" \
  --scope "$(az group show -n "$PERSISTENT_RG" --query id -o tsv)"
```

Role assignments can take a few minutes to take effect. Then change the add-on's
default controller, the `NginxIngressController` named `default`, to use the IP.
Its ingress class stays `webapprouting.kubernetes.azure.com`, so nothing else
changes. If the resource does not exist yet, wait a minute and retry. Newer
Azure CLI versions can switch the default controller to annotation control with
`az aks approuting update --nginx AnnotationControlled`; the scripts do this when
the CLI supports it.

```bash
kubectl patch nginxingresscontroller default --type merge -p "$(cat <<EOF
{"spec":{"loadBalancerAnnotations":{
  "service.beta.kubernetes.io/azure-pip-name":"${INGRESS_PIP_NAME}",
  "service.beta.kubernetes.io/azure-load-balancer-resource-group":"${PERSISTENT_RG}"}}}
EOF
)"
```

The patch is the same as this resource:

```yaml
apiVersion: approuting.kubernetes.azure.com/v1alpha1
kind: NginxIngressController
metadata:
  name: default
spec:
  ingressClassName: webapprouting.kubernetes.azure.com
  controllerNamePrefix: nginx
  loadBalancerAnnotations:
    service.beta.kubernetes.io/azure-pip-name: "<INGRESS_PIP_NAME>"
    service.beta.kubernetes.io/azure-load-balancer-resource-group: "<PERSISTENT_RG>"
```

Check that the controller service took the IP (it can take a few minutes):

```bash
kubectl get svc -n app-routing-system nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}{"\n"}'
```

The output must equal `$INGRESS_IP`. If it does not, run
`kubectl -n app-routing-system describe svc nginx`. `AuthorizationFailed` for
`publicIPAddresses/join/action` means that the role is still taking effect. If you
skip the static IP, the same `kubectl get svc` command shows the IP that Azure
allocated, which can change if the service is recreated.

## 8. Point DNS at the cluster

Keep Vercel as the DNS provider, as in the GCP guide. Add two **A** records
that point at the static IP from step 7 (`$INGRESS_IP`, which `azure-up.sh` prints
on its first run). The IP belongs to the persistent resource group, so you set the
records once and they stay valid when the cluster is deleted and created again.
Replace the example domain and IP:

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
with the repo's config and an Alloy configuration that reads pod logs
through the Kubernetes API.

The files are committed in [`deploy/azure/loki`](../deploy/azure/loki):
`loki.yaml` (a 10Gi PersistentVolumeClaim, a Deployment and a Service) and
`kubernetes.alloy` (the Alloy configuration). They are not part of the overlay's
kustomization, because the overlay does not deploy Loki. `azure-up.sh --with-loki`
applies them for you. To do it by hand, load the repo's Loki config into a
ConfigMap and apply the Loki manifests:

```bash
kubectl -n "$NAMESPACE" create configmap loki-config \
  --from-file=config.yml=observability/loki/config.yml \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" apply -f deploy/azure/loki/loki.yaml
```

The Alloy configuration keeps only the four application pods and sets the
`service` label from the `app` label. The audit query depends on that label. It
discovers pods in the namespace Alloy runs in (`own_namespace = true`).

Install Alloy with Helm. Run it as a single Deployment. `loki.source.kubernetes`
reads logs through the API, so several replicas would send duplicates. The
Helm value names can change between chart versions. Check them with
`helm show values grafana/alloy` if the install rejects a flag.

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
helm upgrade --install alloy grafana/alloy -n "$NAMESPACE" \
  --set controller.type=deployment \
  --set-file alloy.configMap.content=deploy/azure/loki/kubernetes.alloy
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

The main costs are the three AKS nodes, the PostgreSQL server, and the Azure
public IP and load balancer.
ACR Basic and the three Strimzi PVCs also cost something. Check the current prices in
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

Remove the Vercel DNS records and the Google origin afterwards. The static IP
in `$PERSISTENT_RG` is not part of this group; delete it separately
(`az group delete -n "$PERSISTENT_RG" --yes`) when you no longer need the address.

**Up and down cycle.** With the scripts (see "Scripted showcase" at the top),
`azure-down.sh` deletes only the ephemeral group, and `azure-up.sh` builds it
again. The persistent group keeps the static IP (about $0.12 per day), so DNS and
the Google origin stay as they are. Messages, users and Kafka data are lost with
the ephemeral group unless you take a database backup (`--backup`) and restore it
in the next run (`--restore-db`). `azure-down.sh --include-persistent` also deletes
the static IP; the next `azure-up.sh` then gets a different address and the DNS
records must change.

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
- **Flyway fails with `permission denied for schema public`:** on Azure the
  `public` schema belongs to `azure_pg_admin`, not to the database owner. Run
  `ALTER SCHEMA public OWNER TO message_poc` as the admin user in the
  `message_poc` database (step 5; `azure-up.sh` does it for you), then restart
  `message-persistence`.
- **Other Flyway failures in `message-persistence`:** usually the role does not own
  the database, or the connection failed. Check the logs for the error, then
  confirm with `psql` that `message_poc` owns `message_poc`.
- **`no matches for kind "Kafka" in version "kafka.strimzi.io/v1beta2"`:** the
  manifests are older than the installed Strimzi, which serves only `v1`. Deploy
  a release whose `deploy/kubernetes/kafka` uses `kafka.strimzi.io/v1`, or use
  `azure-up.sh --manifests-from-worktree` with an up-to-date checkout.
- **`az` rejects arguments (`unrecognized arguments`):** the Azure CLI changes
  flags between versions. For example, `postgres flexible-server firewall-rule`
  now takes `--server-name` for the server and `--name` for the rule. Compare
  with `az <command> --help`.
- **`NotAvailableForSubscription` or a quota error when the cluster is created:**
  the node size is not offered in the region, or the family quota is too small.
  See "Region and VM size" above.
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
