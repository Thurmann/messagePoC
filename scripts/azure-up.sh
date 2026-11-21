#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/azure-common.sh
source "${SCRIPT_DIR}/lib/azure-common.sh"

CONFIG_FILE="${SCRIPT_DIR}/azure.env"
ASSUME_YES=false
DRY_RUN=false
RENDER_ONLY=false
STAGING_CERT=false
SKIP_DEPLOY=false
FROM_WORKTREE=false
NO_RESTORE_TLS=false
RESTORE_DB=""
VERSION=""
SERVICES="message-api validation-service message-persistence message-audit"
START_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --with-loki is a flag; keep a copy so the config file cannot override it.
WITH_LOKI_FLAG=""

usage() {
  cat <<'EOF2'
Usage: ./scripts/azure-up.sh [options]

Creates the Azure showcase environment: a persistent resource group with the
static ingress IP, and an ephemeral resource group with ACR, AKS and PostgreSQL,
then installs Strimzi and cert-manager and deploys a released version.

Before anything is created, the script prints exactly what it will create and
what it costs, then asks twice: "Continue? [y/N]" and the ephemeral resource
group name. Settings come from scripts/azure.env (see scripts/azure.env.example).

Options:
  --config FILE            Use FILE instead of scripts/azure.env.
  --version X.Y.Z          Release to deploy (default: latest GitHub release or v* tag).
  --staging-cert           Use the Let's Encrypt staging issuer (browsers will warn).
  --with-loki              Also deploy Loki and Alloy for the audit panel.
  --restore-db FILE        Restore a pg_dump file into the new database before deploying.
  --no-restore-tls         Do not reuse a certificate saved by azure-down.sh.
  --manifests-from-worktree
                           Render deploy/azure from the working tree, not the release tag.
  --skip-deploy            Create the infrastructure only; do not deploy the application.
  --render-manifests       Print the rendered manifests and exit (needs only kubectl).
  --dry-run                Run the read-only checks, print the plan and exit.
  --yes-i-understand       Skip both confirmations (automation only).
  -h, --help               Show this help.

Examples:
  ./scripts/azure-up.sh --dry-run
  ./scripts/azure-up.sh --version 0.2.0 --with-loki
  ./scripts/azure-up.sh --render-manifests --version 0.2.0
EOF2
}

while (($# > 0)); do
  case "$1" in
    --config)
      shift
      (($# > 0)) || fail "--config requires a file"
      CONFIG_FILE="$1"
      ;;
    --version)
      shift
      (($# > 0)) || fail "--version requires a number"
      VERSION="${1#v}"
      ;;
    --staging-cert) STAGING_CERT=true ;;
    --with-loki) WITH_LOKI_FLAG=true ;;
    --restore-db)
      shift
      (($# > 0)) || fail "--restore-db requires a file"
      RESTORE_DB="$1"
      ;;
    --no-restore-tls) NO_RESTORE_TLS=true ;;
    --manifests-from-worktree) FROM_WORKTREE=true ;;
    --skip-deploy) SKIP_DEPLOY=true ;;
    --render-manifests) RENDER_ONLY=true ;;
    --dry-run) DRY_RUN=true ;;
    --yes-i-understand) ASSUME_YES=true ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
  shift
done

trap 'on_exit $?' EXIT
trap on_interrupt INT TERM
make_work_dir

# --- helpers ----------------------------------------------------------------------------

resolve_version() {
  local tag
  if [[ -n "$VERSION" ]]; then
    :
  else
    if command -v gh >/dev/null 2>&1; then
      tag="$(cd "$PROJECT_DIR" && gh release view --json tagName -q .tagName 2>/dev/null || true)"
      VERSION="${tag#v}"
    fi
    if [[ -z "$VERSION" ]]; then
      tag="$(git -C "$PROJECT_DIR" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
      VERSION="${tag#v}"
    fi
  fi
  [[ -n "$VERSION" ]] || fail "could not determine the version to deploy; pass --version X.Y.Z"
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "version '$VERSION' is not a semantic version such as 1.2.3"
}

# Sets MANIFEST_DIR to a tree that contains deploy/azure for the chosen version.
prepare_manifests() {
  if "$FROM_WORKTREE"; then
    MANIFEST_DIR="$PROJECT_DIR"
    return 0
  fi
  git -C "$PROJECT_DIR" fetch --tags --quiet 2>/dev/null || warn "could not fetch tags; using the local ones"
  git -C "$PROJECT_DIR" rev-parse -q --verify "refs/tags/v${VERSION}^{commit}" >/dev/null ||
    fail "tag v${VERSION} not found; check the version or use --manifests-from-worktree"
  MANIFEST_DIR="$WORK_DIR/manifests"
  mkdir -p "$MANIFEST_DIR"
  git -C "$PROJECT_DIR" archive "v${VERSION}" deploy | tar -x -C "$MANIFEST_DIR"
}

# Prints the overlay with this deployment's values; fails if a placeholder is left.
render_manifests() {
  local login="${ACR_NAME}.azurecr.io" out="$WORK_DIR/rendered.yaml" svc want count
  local e_pg e_host e_api e_admin e_google
  e_pg="$(sed_escape "$PG_SERVER")"
  e_host="$(sed_escape "$HOST")"
  e_api="$(sed_escape "$API_HOST")"
  e_admin="$(sed_escape "$ADMIN_EMAILS")"
  kubectl kustomize "$MANIFEST_DIR/deploy/azure" |
    sed -E \
      -e "s#^([[:space:]]*image:[[:space:]]*).*/message-poc/(message-api|validation-service|message-persistence|message-audit):.*#\1${login}/message-poc/\2:${VERSION}#" \
      -e "s#<pg-server>#${e_pg}#g" \
      -e "s#api\.messages\.example\.com#${e_api}#g" \
      -e "s#messages\.example\.com#${e_host}#g" \
      -e "s#you@example\.com#${e_admin}#g" >"$out" || fail "kubectl kustomize failed for deploy/azure"
  if [[ -n "$GOOGLE_CLIENT_ID" ]]; then
    e_google="$(sed_escape "$GOOGLE_CLIENT_ID")"
    sed -E -i.bak "s#^([[:space:]]*GOOGLE_CLIENT_ID:[[:space:]]*).*#\1\"${e_google}\"#" "$out"
    rm -f "$out.bak"
  fi
  if "$STAGING_CERT"; then
    sed -E -i.bak 's#(cert-manager\.io/cluster-issuer:[[:space:]]*)letsencrypt-prod#\1letsencrypt-staging#' "$out"
    rm -f "$out.bak"
  fi
  for svc in $SERVICES; do
    want="${login}/message-poc/${svc}:${VERSION}"
    count="$(awk -v want="$want" '$1 == "image:" && $2 == want { n++ } END { print n + 0 }' "$out")"
    [[ "$count" == 1 ]] || fail "expected exactly one image $want in the rendered manifests, found $count"
  done
  grep -qE "host:[[:space:]]*\"?${HOST}\"?\$" "$out" || fail "host $HOST missing from the rendered Ingress"
  grep -qE "host:[[:space:]]*\"?${API_HOST}\"?\$" "$out" || fail "host $API_HOST missing from the rendered Ingress"
  grep -qF "${PG_SERVER}.postgres.database.azure.com:5432" "$out" || fail "JDBC_URL does not point at ${PG_SERVER}"
  if grep -nE '<[a-z][a-z0-9-]*>|example\.com' "$out" >&2; then
    fail "rendered manifests still contain placeholder values (lines above)"
  fi
  if "$STAGING_CERT"; then
    grep -q 'cluster-issuer: letsencrypt-staging' "$out" || fail "the Ingress does not use letsencrypt-staging"
  else
    grep -q 'cluster-issuer: letsencrypt-prod' "$out" || fail "the Ingress does not use letsencrypt-prod"
  fi
  RENDERED_FILE="$out"
}

# Prints both ClusterIssuers (production and staging) with the ACME contact email.
render_issuers() {
  local e_acme src="$MANIFEST_DIR/deploy/azure/cluster-issuer.yaml"
  e_acme="$(sed_escape "$ACME_EMAIL")"
  sed -e "s#you@example\.com#${e_acme}#" "$src"
  printf -- '---\n'
  sed -e "s#you@example\.com#${e_acme}#" \
    -e 's#letsencrypt-prod#letsencrypt-staging#' \
    -e 's#https://acme-v02\.api\.letsencrypt\.org/directory#https://acme-staging-v02.api.letsencrypt.org/directory#' "$src"
}

# --- read-only preflight ------------------------------------------------------------------

preflight() {
  local out usage free want

  section "Checking the Azure account and existing resources (read-only)"
  az_preflight
  provider_states

  PERSISTENT_EXISTS="$(check_group "$PERSISTENT_RG" persistent)"
  EPHEMERAL_EXISTS="$(check_group "$EPHEMERAL_RG" ephemeral)"

  PIP_EXISTS=false
  PIP_IP=""
  if [[ "$PERSISTENT_EXISTS" == true ]] &&
    out="$(az network public-ip show --resource-group "$PERSISTENT_RG" --name "$INGRESS_PIP_NAME" --query ipAddress --output tsv 2>/dev/null)"; then
    PIP_EXISTS=true
    PIP_IP="$out"
  fi

  ACR_EXISTS=false
  AKS_PROV=""
  AKS_POWER=""
  PG_EXISTS=false
  PG_STATE=""
  if [[ "$EPHEMERAL_EXISTS" == true ]]; then
    if az acr show --resource-group "$EPHEMERAL_RG" --name "$ACR_NAME" --query id --output tsv >/dev/null 2>&1; then
      ACR_EXISTS=true
    fi
    if out="$(az aks show --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --query '[provisioningState,powerState.code]' --output tsv 2>/dev/null)"; then
      {
        IFS= read -r AKS_PROV
        IFS= read -r AKS_POWER
      } <<<"$out"
    fi
    if out="$(az postgres flexible-server show --resource-group "$EPHEMERAL_RG" --name "$PG_SERVER" --query state --output tsv 2>/dev/null)"; then
      PG_EXISTS=true
      PG_STATE="$out"
    fi
  fi
  if [[ "$AKS_PROV" == Failed ]]; then
    fail "AKS cluster $AKS_NAME is in a Failed state; run ./scripts/azure-down.sh and start again"
  fi

  if [[ "$ACR_EXISTS" != true ]]; then
    out="$(az acr check-name --name "$ACR_NAME" --query nameAvailable --output tsv 2>/dev/null || true)"
    [[ "$out" == true ]] || fail "the ACR name '$ACR_NAME' is not available (taken or invalid); choose another ACR_NAME"
  fi
  if [[ "$PG_EXISTS" != true ]]; then
    out="$(az rest --method post \
      --uri "https://management.azure.com/subscriptions/${SUB_ID}/providers/Microsoft.DBforPostgreSQL/checkNameAvailability?api-version=2023-06-01-preview" \
      --body "{\"name\":\"${PG_SERVER}\",\"type\":\"Microsoft.DBforPostgreSQL/flexibleServers\"}" \
      --query nameAvailable --output tsv 2>/dev/null || true)"
    case "$out" in
      true) ;;
      false) fail "the PostgreSQL server name '$PG_SERVER' is not available; choose another PG_SERVER" ;;
      *) warn "could not verify that the PostgreSQL name '$PG_SERVER' is free" ;;
    esac
  fi

  if [[ "$AKS_PROV" == "" && "$AKS_NODE_VM_SIZE" == Standard_D2s_v5 ]]; then
    usage="$(az vm list-usage --location "$LOCATION" --query "[?name.value=='standardDSv5Family'].[currentValue,limit]" --output tsv 2>/dev/null || true)"
    want=$((AKS_NODE_COUNT * 2))
    free="$(awk 'NR == 1 { print $2 - $1 }' <<<"$usage")"
    if [[ "$free" =~ ^-?[0-9]+$ ]] && ((free < want)); then
      warn "only $free free vCPU in the standardDSv5Family quota in $LOCATION; $want are needed for $AKS_NODE_COUNT nodes"
    fi
  fi

  if [[ -z "$OPERATOR_IP" ]]; then
    OPERATOR_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  fi
  [[ "$OPERATOR_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] ||
    fail "could not detect your public IP for the PostgreSQL firewall; set OPERATOR_IP"

  if command -v gh >/dev/null 2>&1; then
    if [[ "$(cd "$PROJECT_DIR" && gh variable get DEPLOY_TO_AKS 2>/dev/null || true)" == true ]]; then
      warn "GitHub variable DEPLOY_TO_AKS is true; deploy jobs fail while this environment is down. Set it to false between showcases."
    fi
  fi

  if "$WITH_LOKI"; then
    for out in deploy/azure/loki/loki.yaml deploy/azure/loki/kubernetes.alloy observability/loki/config.yml; do
      [[ -f "$PROJECT_DIR/$out" ]] || fail "--with-loki needs $out, which is missing from the working tree"
    done
  fi
}

print_up_summary() {
  local pip_note
  if [[ "$PIP_EXISTS" == true ]]; then
    pip_note="$PIP_IP"
  else
    pip_note="address assigned on creation"
  fi
  log ""
  log "================================================================================"
  log "WHAT THIS WILL CREATE"
  log "================================================================================"
  log "Subscription : $SUB_NAME ($SUB_ID)"
  log "Tenant       : $TENANT_ID"
  log "Signed in as : $AZ_USER"
  log "Region       : $LOCATION"
  log "Version      : $VERSION$("$SKIP_DEPLOY" && printf ' (application deployment skipped)')"
  log ""
  log "PERSISTENT resource group: $PERSISTENT_RG  $(tag_label "$PERSISTENT_EXISTS")"
  log "  - Public IP $INGRESS_PIP_NAME  $(tag_label "$PIP_EXISTS")"
  log "      Standard SKU, Static, IPv4, $pip_note"
  log "      about \$0.12 per day (\$3.6 per month); it is KEPT when you run azure-down.sh,"
  log "      so your DNS records stay valid"
  log "  - Role: Network Contributor for the AKS identity on this group (lets the ingress use the IP)"
  log ""
  log "EPHEMERAL resource group: $EPHEMERAL_RG  $(tag_label "$EPHEMERAL_EXISTS")"
  log "  - Container Registry $ACR_NAME  $(tag_label "$ACR_EXISTS")"
  log "      Basic SKU; the four release images are imported from GHCR"
  log "  - AKS cluster $AKS_NAME  $(tag_label "$([[ -n "$AKS_PROV" ]] && echo true || echo false)")${AKS_POWER:+ (power state: $AKS_POWER)}"
  log "      Free tier, $AKS_NODE_COUNT x $AKS_NODE_VM_SIZE nodes, application routing (managed NGINX) add-on,"
  log "      ACR attached; Azure also creates the node group MC_${EPHEMERAL_RG}_${AKS_NAME}_${LOCATION}"
  log "      with the VMs, OS disks, load balancer and outbound IP"
  log "  - PostgreSQL Flexible Server $PG_SERVER  $(tag_label "$PG_EXISTS")${PG_STATE:+ (state: $PG_STATE)}"
  log "      $PG_TIER $PG_SKU, ${PG_STORAGE_GB} GB, version $PG_VERSION, public access with firewall rules for"
  log "      your IP ($OPERATOR_IP) and the AKS outbound IP(s); database and role message_poc"
  log "  - Inside the cluster: Strimzi operator and a 3-broker Kafka (3 x 10Gi disks), cert-manager"
  log "    with Let's Encrypt issuers ($(if "$STAGING_CERT"; then echo "STAGING certificate, browsers will warn"; else echo "production certificate"; fi)),"
  log "    namespace $NAMESPACE with the Secret message-poc-secrets, and the application $VERSION"
  if "$WITH_LOKI"; then
    log "    Loki (10Gi disk) and Alloy for the audit panel"
  fi
  if [[ -n "$GITHUB_DEPLOY_PRINCIPAL_ID" ]]; then
    log "  - Roles for GitHub identity $GITHUB_DEPLOY_PRINCIPAL_ID: Contributor on the ACR,"
    log "    Cluster User on the AKS cluster"
  fi
  if [[ -n "$PROVIDERS_TO_REGISTER" ]]; then
    log "  - Resource provider registration (free):$PROVIDERS_TO_REGISTER"
  fi
  log ""
  print_costs_running
  log ""
  log "TIME: about 20-30 minutes."
  log "DNS: $HOST and $API_HOST must have A records pointing to the static IP."
  log "================================================================================"
}

# --- mutating steps -----------------------------------------------------------------------

tags_for() {
  printf '%s %s lifecycle=%s' "$TAG_PROJECT" "$TAG_MANAGED" "$1"
}

read_secrets() {
  if [[ -z "${TYPESAFE_API_KEY:-}" ]]; then
    [[ -t 0 ]] || fail "TYPESAFE_API_KEY is not set and there is no terminal to ask for it; export it"
    printf 'TypeSafe API key (input hidden): ' >&2
    IFS= read -r -s TYPESAFE_API_KEY
    printf '\n' >&2
  fi
  [[ -n "$TYPESAFE_API_KEY" ]] || fail "TYPESAFE_API_KEY must not be empty"
  [[ "$TYPESAFE_API_KEY" != *$'\n'* ]] || fail "TYPESAFE_API_KEY must be a single line"
  PG_ADMIN_PASSWORD="$(openssl rand -hex 24)"
}

register_providers() {
  local ns
  [[ -n "$PROVIDERS_TO_REGISTER" ]] || return 0
  for ns in $PROVIDERS_TO_REGISTER; do
    log "Registering $ns (can take a few minutes)"
    az provider register --namespace "$ns" --wait
  done
}

ensure_persistent() {
  if [[ "$PERSISTENT_EXISTS" != true ]]; then
    # shellcheck disable=SC2046
    az group create --name "$PERSISTENT_RG" --location "$LOCATION" --tags $(tags_for persistent) --output none
  fi
  if [[ "$PIP_EXISTS" != true ]]; then
    # shellcheck disable=SC2046
    az network public-ip create --resource-group "$PERSISTENT_RG" --name "$INGRESS_PIP_NAME" \
      --location "$LOCATION" --sku Standard --allocation-method Static --version IPv4 \
      --tags $(tags_for persistent) --output none
    PIP_IP="$(az network public-ip show --resource-group "$PERSISTENT_RG" --name "$INGRESS_PIP_NAME" --query ipAddress --output tsv)"
    log ""
    log "New static IP reserved: $PIP_IP"
    log "Create these DNS records at your DNS provider (for example Vercel) now:"
    log "  A  $HOST      $PIP_IP"
    log "  A  $API_HOST  $PIP_IP"
  else
    log "Static IP $PIP_IP is reused; the DNS records already point at it."
  fi
}

ensure_ephemeral_rg() {
  if [[ "$EPHEMERAL_EXISTS" != true ]]; then
    # shellcheck disable=SC2046
    az group create --name "$EPHEMERAL_RG" --location "$LOCATION" --tags $(tags_for ephemeral) --output none
  fi
}

ensure_acr() {
  if [[ "$ACR_EXISTS" != true ]]; then
    # shellcheck disable=SC2046
    az acr create --resource-group "$EPHEMERAL_RG" --name "$ACR_NAME" --location "$LOCATION" \
      --sku Basic --tags $(tags_for ephemeral) --output none
  fi
}

create_aks() {
  case "$AKS_PROV" in
    "")
      # shellcheck disable=SC2046
      az aks create --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --location "$LOCATION" \
        --tier free --node-count "$AKS_NODE_COUNT" --node-vm-size "$AKS_NODE_VM_SIZE" \
        --no-ssh-key --attach-acr "$ACR_NAME" --enable-app-routing \
        --tags $(tags_for ephemeral) --only-show-errors --output none
      ;;
    Succeeded)
      if [[ "$AKS_POWER" == Stopped ]]; then
        az aks start --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --output none
      fi
      ;;
    *)
      az aks wait --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --created --interval 30 --timeout 3600
      ;;
  esac
}

create_postgres() {
  if [[ "$PG_EXISTS" == true ]]; then
    if [[ "$PG_STATE" == Stopped ]]; then
      az postgres flexible-server start --resource-group "$EPHEMERAL_RG" --name "$PG_SERVER" --output none
    fi
    # The admin password is generated per run, so reset it on a reused server.
    az postgres flexible-server update --resource-group "$EPHEMERAL_RG" --name "$PG_SERVER" \
      --admin-password "$PG_ADMIN_PASSWORD" --output none
  else
    # shellcheck disable=SC2046
    az postgres flexible-server create --resource-group "$EPHEMERAL_RG" --name "$PG_SERVER" \
      --location "$LOCATION" --tier "$PG_TIER" --sku-name "$PG_SKU" --storage-size "$PG_STORAGE_GB" \
      --version "$PG_VERSION" --admin-user "$PG_ADMIN_USER" --admin-password "$PG_ADMIN_PASSWORD" \
      --public-access "$OPERATOR_IP" --high-availability Disabled \
      --tags $(tags_for ephemeral) --yes --only-show-errors --output none
  fi
}

# AKS and PostgreSQL take the longest, so create them side by side.
ensure_aks_and_pg() {
  local logdir="$WORK_DIR/logs" aks_rc=0 pg_rc=0
  mkdir -p "$logdir"
  log "Creating AKS and PostgreSQL in parallel (typically 5-15 minutes)."
  (trap - EXIT INT TERM; create_aks) >"$logdir/aks.log" 2>&1 &
  AKS_PID=$!
  (trap - EXIT INT TERM; create_postgres) >"$logdir/postgres.log" 2>&1 &
  PG_PID=$!
  wait "$AKS_PID" || aks_rc=$?
  wait "$PG_PID" || pg_rc=$?
  if ((aks_rc != 0)); then
    log "--- AKS log (last 50 lines) ---"
    tail -n 50 "$logdir/aks.log" >&2 || true
  fi
  if ((pg_rc != 0)); then
    log "--- PostgreSQL log (last 50 lines) ---"
    tail -n 50 "$logdir/postgres.log" >&2 || true
  fi
  ((aks_rc == 0 && pg_rc == 0)) || fail "creating the cluster or database failed (see the logs above)"
}

connect_cluster() {
  az aks get-credentials --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --context "$AKS_NAME" --overwrite-existing >/dev/null
  if az aks approuting update --help 2>&1 | grep -q -- '--nginx'; then
    az aks approuting update --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --nginx AnnotationControlled --output none ||
      warn "could not switch the default ingress controller to annotation control; continuing"
  fi
}

resolve_db_password() {
  local existing=""
  existing="$(k -n "$NAMESPACE" get secret message-poc-secrets -o jsonpath='{.data.DB_PASSWORD}' 2>/dev/null | base64 --decode 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    DB_PASSWORD="$existing"
  elif [[ -z "${DB_PASSWORD:-}" ]]; then
    DB_PASSWORD="$(openssl rand -hex 24)"
  fi
  [[ "$DB_PASSWORD" =~ ^[A-Za-z0-9]+$ ]] || fail "DB_PASSWORD must be alphanumeric"
}

# Idempotent: lists before creating, so a rerun does nothing.
ensure_role() {
  local assignee="$1" role="$2" scope="$3" ptype="${4:-ServicePrincipal}" count
  count="$(az role assignment list --assignee "$assignee" --scope "$scope" --role "$role" --query 'length(@)' --output tsv 2>/dev/null || echo 0)"
  if [[ "$count" != 0 ]]; then
    return 0
  fi
  az role assignment create --assignee-object-id "$assignee" --assignee-principal-type "$ptype" \
    --role "$role" --scope "$scope" --output none ||
    fail "could not assign '$role' on $scope; you need Owner or User Access Administrator on it"
}

grant_network_contributor() {
  local pid scope
  pid="$(az aks show --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --query identity.principalId --output tsv)"
  [[ -n "$pid" ]] || fail "could not read the AKS identity"
  scope="$(az group show --name "$PERSISTENT_RG" --query id --output tsv)"
  ensure_role "$pid" "Network Contributor" "$scope"
}

# Points the add-on's default controller at the static IP, keeping its ingress class.
configure_ingress_static_ip() {
  local i ip patch
  for i in $(seq 1 30); do
    if k get nginxingresscontroller default >/dev/null 2>&1; then
      break
    fi
    ((i < 30)) || fail "the NginxIngressController 'default' did not appear within 5 minutes"
    sleep 10
  done
  patch="$(printf '{"spec":{"loadBalancerAnnotations":{"service.beta.kubernetes.io/azure-pip-name":"%s","service.beta.kubernetes.io/azure-load-balancer-resource-group":"%s"}}}' "$INGRESS_PIP_NAME" "$PERSISTENT_RG")"
  k patch nginxingresscontroller default --type merge -p "$patch"
  log "Waiting for the ingress service to take the static IP $PIP_IP (up to 10 minutes)"
  for i in $(seq 1 60); do
    ip="$(k -n app-routing-system get svc nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
    if [[ "$ip" == "$PIP_IP" ]]; then
      return 0
    fi
    sleep 10
  done
  log "The ingress service still has IP '${ip:-none}', not $PIP_IP."
  log "Inspect: kubectl --context $AKS_NAME -n app-routing-system describe svc nginx"
  log "AuthorizationFailed for publicIPAddresses/join/action means the role is still propagating; rerun in a few minutes."
  fail "ingress did not take the static IP"
}

psql_admin() {
  local dbname="$1"
  shift
  PGPASSWORD="$PG_ADMIN_PASSWORD" psql \
    "host=${PG_SERVER}.postgres.database.azure.com port=5432 dbname=${dbname} user=${PG_ADMIN_USER} sslmode=require" \
    --set ON_ERROR_STOP=1 --set "admin_user=${PG_ADMIN_USER}" "$@"
}

configure_postgres() {
  local ids id ip n=0
  ids="$(az aks show --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --query 'networkProfile.loadBalancerProfile.effectiveOutboundIPs[].id' --output tsv 2>/dev/null || true)"
  if [[ -z "$ids" ]]; then
    ids="$(az aks show --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --query 'networkProfile.loadBalancerProfile.effectiveOutboundIps[].id' --output tsv 2>/dev/null || true)"
  fi
  [[ -n "$ids" ]] || fail "could not read the AKS outbound IPs"
  for id in $ids; do
    ip="$(az network public-ip show --ids "$id" --query ipAddress --output tsv)"
    n=$((n + 1))
    az postgres flexible-server firewall-rule create --resource-group "$EPHEMERAL_RG" --name "$PG_SERVER" \
      --rule-name "aks-egress-${n}" --start-ip-address "$ip" --end-ip-address "$ip" --output none
  done
  az postgres flexible-server firewall-rule create --resource-group "$EPHEMERAL_RG" --name "$PG_SERVER" \
    --rule-name operator --start-ip-address "$OPERATOR_IP" --end-ip-address "$OPERATOR_IP" --output none

  # The server accepts connections a moment after it reports Ready.
  for n in 1 2 3 4 5 6; do
    if psql_admin postgres --command 'SELECT 1' >/dev/null 2>&1; then
      break
    fi
    ((n < 6)) || fail "could not connect to ${PG_SERVER}.postgres.database.azure.com (firewall or password); check your IP $OPERATOR_IP"
    sleep 10
  done
  {
    printf "\\set db_password '%s'\n" "$DB_PASSWORD"
    cat <<'SQL'
SELECT format('CREATE ROLE message_poc LOGIN PASSWORD %L', :'db_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'message_poc') \gexec
SELECT format('ALTER ROLE message_poc LOGIN PASSWORD %L', :'db_password') \gexec
GRANT message_poc TO :"admin_user";
SELECT 'CREATE DATABASE message_poc OWNER message_poc'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'message_poc') \gexec
SQL
  } | psql_admin postgres >/dev/null
}

restore_database() {
  local tables
  [[ -n "$RESTORE_DB" ]] || return 0
  tables="$(psql_admin message_poc --tuples-only --no-align --command "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
  if [[ "${tables//[[:space:]]/}" != 0 ]]; then
    warn "database message_poc already has tables; skipping the restore of $RESTORE_DB"
    return 0
  fi
  log "Restoring $RESTORE_DB"
  PGPASSWORD="$PG_ADMIN_PASSWORD" pg_restore --no-owner --no-privileges --role=message_poc \
    --dbname "host=${PG_SERVER}.postgres.database.azure.com port=5432 dbname=message_poc user=${PG_ADMIN_USER} sslmode=require" \
    "$RESTORE_DB"
}

install_operators() {
  local strimzi_version=() cm_version=()
  if [[ -n "$STRIMZI_CHART_VERSION" ]]; then
    strimzi_version=(--version "$STRIMZI_CHART_VERSION")
  fi
  if [[ -n "$CERT_MANAGER_CHART_VERSION" ]]; then
    cm_version=(--version "$CERT_MANAGER_CHART_VERSION")
  fi
  h upgrade --install strimzi-cluster-operator oci://quay.io/strimzi-helm/strimzi-kafka-operator \
    --namespace strimzi --create-namespace --set watchAnyNamespace=true \
    ${strimzi_version[@]+"${strimzi_version[@]}"} --wait --timeout 10m
  h repo add jetstack https://charts.jetstack.io --force-update >/dev/null
  h repo update jetstack >/dev/null
  h upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager --create-namespace --set crds.enabled=true \
    ${cm_version[@]+"${cm_version[@]}"} --wait --timeout 10m
}

apply_cluster_issuers() {
  local i
  render_issuers >"$WORK_DIR/issuers.yaml"
  # The cert-manager webhook can need a moment after the install.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if k apply -f "$WORK_DIR/issuers.yaml"; then
      return 0
    fi
    sleep 6
  done
  fail "could not apply the ClusterIssuers"
}

create_namespace_and_secret() {
  local envfile="$WORK_DIR/secrets.env"
  k create namespace "$NAMESPACE" --dry-run=client -o yaml | k apply -f -
  (
    umask 077
    printf 'DB_PASSWORD=%s\nTYPESAFE_API_KEY=%s\n' "$DB_PASSWORD" "$TYPESAFE_API_KEY" >"$envfile"
  )
  k -n "$NAMESPACE" create secret generic message-poc-secrets --from-env-file="$envfile" --dry-run=client -o yaml |
    k apply -f -
  rm -f "$envfile"
}

# Reuses the certificate saved by azure-down.sh to stay clear of Let's Encrypt rate limits.
restore_tls() {
  local file="${BACKUP_DIR}/${TLS_BACKUP_NAME}" crt
  "$NO_RESTORE_TLS" && return 0
  "$STAGING_CERT" && return 0
  [[ -f "$file" ]] || return 0
  crt="$(awk '$1 == "tls.crt:" { print $2 }' "$file" | base64 --decode 2>/dev/null || true)"
  if [[ -n "$crt" ]] &&
    printf '%s\n' "$crt" | openssl x509 -noout -checkend 604800 >/dev/null 2>&1 &&
    printf '%s\n' "$crt" | openssl x509 -noout -text 2>/dev/null | grep -q "DNS:${HOST}"; then
    log "Restoring the saved certificate from $file"
    k -n "$NAMESPACE" apply -f "$file"
  else
    log "The saved certificate in $file is expired, expires within a week or is for another host; cert-manager will request a new one."
  fi
}

grant_github_identity() {
  local acr_id aks_id
  [[ -n "$GITHUB_DEPLOY_PRINCIPAL_ID" ]] || return 0
  acr_id="$(az acr show --resource-group "$EPHEMERAL_RG" --name "$ACR_NAME" --query id --output tsv)"
  aks_id="$(az aks show --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --query id --output tsv)"
  ensure_role "$GITHUB_DEPLOY_PRINCIPAL_ID" Contributor "$acr_id"
  ensure_role "$GITHUB_DEPLOY_PRINCIPAL_ID" "Azure Kubernetes Service Cluster User Role" "$aks_id"
}

import_images() {
  local owner="${GHCR_OWNER}" user="${GHCR_USERNAME:-}" token="${GHCR_TOKEN:-}" svc auth=()
  if [[ -z "$owner" ]] && command -v gh >/dev/null 2>&1; then
    owner="$(cd "$PROJECT_DIR" && gh repo view --json owner -q .owner.login 2>/dev/null || true)"
  fi
  [[ -n "$owner" ]] || fail "could not determine the GHCR owner; set GHCR_OWNER"
  owner="$(lowercase "$owner")"
  if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
    token="$(gh auth token 2>/dev/null || true)"
    user="$(gh api user -q .login 2>/dev/null || true)"
  fi
  if [[ -n "$token" && -n "$user" ]]; then
    auth=(--username "$user" --password "$token")
  else
    log "No GitHub credentials found; importing anonymously (works for public packages)."
  fi
  for svc in $SERVICES; do
    az acr import --name "$ACR_NAME" --force \
      --source "ghcr.io/${owner}/message-poc/${svc}:${VERSION}" \
      --image "message-poc/${svc}:${VERSION}" \
      ${auth[@]+"${auth[@]}"} ||
      fail "importing $svc:$VERSION failed; for private packages run: gh auth refresh -s read:packages (or set GHCR_TOKEN and GHCR_USERNAME)"
  done
}

deploy_loki() {
  k -n "$NAMESPACE" create configmap loki-config \
    --from-file=config.yml="$PROJECT_DIR/observability/loki/config.yml" --dry-run=client -o yaml | k apply -f -
  k -n "$NAMESPACE" apply -f "$PROJECT_DIR/deploy/azure/loki/loki.yaml"
  h repo add grafana https://grafana.github.io/helm-charts --force-update >/dev/null
  h repo update grafana >/dev/null
  h upgrade --install alloy grafana/alloy -n "$NAMESPACE" \
    --set controller.type=deployment \
    --set-file alloy.configMap.content="$PROJECT_DIR/deploy/azure/loki/kubernetes.alloy" \
    --wait --timeout 10m
}

wait_ready() {
  local svc resolved certcurl=() reachable=true
  k -n "$NAMESPACE" wait kafka/message-poc --for=condition=Ready --timeout=15m
  for svc in message-persistence message-api validation-service message-audit; do
    k -n "$NAMESPACE" rollout status "deploy/${svc}" --timeout=10m
  done
  if command -v dig >/dev/null 2>&1; then
    for svc in "$HOST" "$API_HOST"; do
      resolved="$(dig +short "$svc" 2>/dev/null | tail -n 1 || true)"
      if [[ "$resolved" != "$PIP_IP" ]]; then
        warn "$svc resolves to '${resolved:-nothing}', not $PIP_IP; set the A record (certificates cannot be issued until it resolves)"
        reachable=false
      fi
    done
  fi
  "$reachable" || return 0
  k -n "$NAMESPACE" wait certificate/message-poc-tls --for=condition=Ready --timeout=10m ||
    warn "the certificate is not Ready yet; check: kubectl --context $AKS_NAME -n $NAMESPACE get challenges"
  if "$STAGING_CERT"; then
    certcurl=(-k)
  fi
  curl -fsS ${certcurl[@]+"${certcurl[@]}"} --max-time 15 "https://${API_HOST}/actuator/health" >/dev/null ||
    warn "https://${API_HOST}/actuator/health did not answer yet"
}

print_result() {
  log ""
  log "================================================================================"
  log "DONE. Started $START_TIME, finished $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  log "  Frontend : https://$HOST"
  log "  API      : https://$API_HOST"
  log "  Static IP: $PIP_IP"
  log "  Version  : $VERSION"
  log "  kubectl  : kubectl --context $AKS_NAME -n $NAMESPACE get pods"
  if "$STAGING_CERT"; then
    log "  Certificate: STAGING (browsers will warn)"
  fi
  log "  This now costs about \$0.50 per hour. When you are done, run ./scripts/azure-down.sh"
  log "================================================================================"
}

# --- main ---------------------------------------------------------------------------------

section "Reading configuration"
load_config "$CONFIG_FILE"
if [[ -n "$WITH_LOKI_FLAG" ]]; then
  WITH_LOKI=true
fi
apply_defaults
validate_config

if [[ -n "$RESTORE_DB" ]]; then
  [[ -f "$RESTORE_DB" && -r "$RESTORE_DB" ]] || fail "--restore-db file not found: $RESTORE_DB"
fi

if "$RENDER_ONLY"; then
  require_tools kubectl git sed awk
  resolve_version
  prepare_manifests
  render_manifests
  cat "$RENDERED_FILE"
  printf -- '---\n'
  render_issuers
  exit 0
fi

require_tools az kubectl helm psql openssl curl git sed awk base64 tar
if [[ -n "$RESTORE_DB" ]]; then
  require_tools pg_restore
fi
if ! "$DRY_RUN"; then
  require_confirmation_possible
fi

section "Resolving the version to deploy"
resolve_version
log "Version: $VERSION"
if ! "$SKIP_DEPLOY"; then
  # Render now so placeholder or tag problems stop the run before anything is created.
  prepare_manifests
  render_manifests
else
  FROM_WORKTREE=true
  prepare_manifests
fi

preflight
print_up_summary

if "$DRY_RUN"; then
  log ""
  log "Dry run: nothing was changed."
  exit 0
fi

section "Confirmation"
confirm_double "$EPHEMERAL_RG"
MUTATION_STARTED=true

section "Reading secrets"
read_secrets
section "Registering resource providers"
register_providers
section "Creating the persistent resource group and static IP"
ensure_persistent
section "Creating the ephemeral resource group"
ensure_ephemeral_rg
section "Creating the container registry"
ensure_acr
section "Creating the AKS cluster and PostgreSQL server"
ensure_aks_and_pg
section "Connecting to the cluster"
connect_cluster
resolve_db_password
section "Granting the cluster access to the static IP"
grant_network_contributor
section "Pointing the ingress at the static IP"
configure_ingress_static_ip
section "Configuring PostgreSQL"
configure_postgres
restore_database
section "Installing Strimzi and cert-manager"
install_operators
section "Applying the Let's Encrypt issuers"
apply_cluster_issuers
section "Creating the namespace and secrets"
create_namespace_and_secret
section "Restoring the saved certificate"
restore_tls
section "Granting the GitHub deploy identity"
grant_github_identity
if ! "$SKIP_DEPLOY"; then
  section "Importing images from GHCR"
  import_images
  section "Applying the application"
  k apply -f "$RENDERED_FILE"
fi
if "$WITH_LOKI"; then
  section "Deploying Loki and Alloy"
  deploy_loki
fi
if ! "$SKIP_DEPLOY"; then
  section "Waiting for the application"
  wait_ready
fi
CURRENT_STEP=""
print_result
