#!/usr/bin/env bash
# Shared helpers for scripts/azure-up.sh and scripts/azure-down.sh. Source it, do not run it.
# Bash 3.2 compatible (macOS): no associative arrays, no ${x,,}, no mapfile.
# shellcheck disable=SC2034 # variables here are shared with the sourcing scripts

# Keys accepted in the config file. Secrets are listed separately and always rejected there.
CONFIG_KEYS="AZ_SUBSCRIPTION LOCATION PERSISTENT_RG INGRESS_PIP_NAME EPHEMERAL_RG ACR_NAME \
AKS_NAME AKS_NODE_COUNT AKS_NODE_VM_SIZE PG_SERVER PG_ADMIN_USER PG_TIER PG_SKU PG_STORAGE_GB \
PG_VERSION NAMESPACE HOST API_HOST ACME_EMAIL ADMIN_EMAILS GOOGLE_CLIENT_ID GHCR_OWNER \
GITHUB_DEPLOY_PRINCIPAL_ID STRIMZI_CHART_VERSION CERT_MANAGER_CHART_VERSION BACKUP_DIR \
OPERATOR_IP WITH_LOKI"
SECRET_KEYS="TYPESAFE_API_KEY DB_PASSWORD PG_ADMIN_PASSWORD GHCR_TOKEN"
REQUIRED_KEYS="LOCATION PERSISTENT_RG EPHEMERAL_RG INGRESS_PIP_NAME ACR_NAME AKS_NAME PG_SERVER \
HOST API_HOST ACME_EMAIL ADMIN_EMAILS"

TAG_PROJECT="project=message-poc"
TAG_MANAGED="managed-by=message-poc-scripts"
TLS_BACKUP_NAME="message-poc-tls-secret.yaml"

CURRENT_STEP=""
MUTATION_STARTED=false
WORK_DIR=""

log() { printf '%s\n' "$*" >&2; }
warn() { printf 'Warning: %s\n' "$*" >&2; }

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

section() {
  CURRENT_STEP="$*"
  printf '\n==> %s\n' "$*" >&2
}

# Called from each script's EXIT trap with the exit status.
on_exit() {
  local rc="$1"
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
  if ((rc != 0)) && [[ -n "$CURRENT_STEP" ]]; then
    printf '\nStopped during: %s (exit %s)\n' "$CURRENT_STEP" "$rc" >&2
    if "$MUTATION_STARTED"; then
      printf 'Azure resources may already exist and are billed until deleted.\n' >&2
      printf 'Fix the problem and rerun (the script is safe to rerun), or remove everything with ./scripts/azure-down.sh.\n' >&2
    fi
  fi
}

on_interrupt() {
  local pid
  for pid in $(jobs -p); do
    kill "$pid" 2>/dev/null || true
  done
  printf '\nInterrupted. Operations already sent to Azure keep running on the Azure side.\n' >&2
  exit 130
}

make_work_dir() {
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/azure-scripts.XXXXXX")"
}

# --- configuration --------------------------------------------------------------------

# Parses KEY=value lines without evaluating them. Variables already set in the
# environment win over the file; a warning names every key where that hides a different
# value in the file (generic names such as HOST are easy to have exported by accident).
load_config() {
  local file="$1" line key value rest lineno=0
  [[ -f "$file" ]] || fail "config file not found: $file (copy scripts/azure.env.example to scripts/azure.env and edit it)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ -z "$line" || "$line" == \#* ]]; then
      continue
    fi
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || fail "$file:$lineno: expected KEY=value"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case " $SECRET_KEYS " in
      *" $key "*) fail "$file:$lineno: $key is a secret and must not be stored in the config file; export it in the environment instead" ;;
    esac
    case " $CONFIG_KEYS " in
      *" $key "*) ;;
      *) fail "$file:$lineno: unknown key $key" ;;
    esac
    case "$value" in
      \"*)
        rest="${value#\"}"
        [[ "$rest" == *\"* ]] || fail "$file:$lineno: unterminated quote"
        value="${rest%%\"*}"
        ;;
      \'*)
        rest="${value#\'}"
        [[ "$rest" == *\'* ]] || fail "$file:$lineno: unterminated quote"
        value="${rest%%\'*}"
        ;;
      *)
        value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')"
        ;;
    esac
    if [[ -n "${!key+x}" ]]; then
      if [[ "${!key}" != "$value" ]]; then
        warn "$key is set in the environment ('${!key}') and overrides the config file ('$value'); unset it to use the file"
      fi
      continue
    fi
    printf -v "$key" '%s' "$value"
  done <"$file"
}

apply_defaults() {
  : "${LOCATION:=norwayeast}"
  : "${PERSISTENT_RG:=rg-message-poc-persistent}"
  : "${INGRESS_PIP_NAME:=pip-message-poc-ingress}"
  : "${EPHEMERAL_RG:=rg-message-poc}"
  : "${ACR_NAME:=acrmessagepoc001}"
  : "${AKS_NAME:=aks-message-poc}"
  : "${AKS_NODE_COUNT:=3}"
  : "${AKS_NODE_VM_SIZE:=Standard_D2s_v5}"
  : "${PG_SERVER:=pg-message-poc-001}"
  : "${PG_ADMIN_USER:=pgadmin}"
  : "${PG_TIER:=Burstable}"
  : "${PG_SKU:=Standard_B1ms}"
  : "${PG_STORAGE_GB:=32}"
  : "${PG_VERSION:=17}"
  : "${NAMESPACE:=message-poc}"
  : "${GOOGLE_CLIENT_ID:=}"
  : "${GHCR_OWNER:=}"
  : "${GITHUB_DEPLOY_PRINCIPAL_ID:=}"
  : "${STRIMZI_CHART_VERSION:=}"
  : "${CERT_MANAGER_CHART_VERSION:=}"
  : "${BACKUP_DIR:=$HOME/message-poc-backups}"
  : "${OPERATOR_IP:=}"
  : "${AZ_SUBSCRIPTION:=}"
  : "${HOST:=}"
  : "${API_HOST:=}"
  : "${ACME_EMAIL:=}"
  : "${ADMIN_EMAILS:=}"
  : "${WITH_LOKI:=false}"
}

# Set RENDER_ONLY=true to skip the settings only Azure needs.
validate_config() {
  local key value overlay_ns
  for key in $REQUIRED_KEYS; do
    [[ -n "${!key}" ]] || fail "$key is required in the config file (or the environment)"
  done
  if [[ "${RENDER_ONLY:-false}" != true ]]; then
    [[ -n "$AZ_SUBSCRIPTION" ]] || fail "AZ_SUBSCRIPTION is required (subscription name or id)"
  fi
  for key in $CONFIG_KEYS; do
    value="${!key}"
    if [[ "$value" == *example.com* ]]; then
      fail "$key still contains the example value '$value'; set your own in the config file"
    fi
  done
  [[ "$ACR_NAME" =~ ^[a-z0-9]{5,50}$ ]] || fail "ACR_NAME must be 5-50 lowercase letters and digits"
  [[ "$PG_SERVER" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || fail "PG_SERVER must be 3-63 lowercase letters, digits and hyphens"
  [[ "$HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "HOST must be a lowercase DNS name"
  [[ "$API_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "API_HOST must be a lowercase DNS name"
  [[ "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || fail "ACME_EMAIL must be a single email address"
  [[ "$ADMIN_EMAILS" =~ ^[A-Za-z0-9._%+@,-]+$ ]] || fail "ADMIN_EMAILS must be comma-separated email addresses without spaces"
  if [[ -n "$GOOGLE_CLIENT_ID" ]]; then
    [[ "$GOOGLE_CLIENT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail "GOOGLE_CLIENT_ID contains unexpected characters"
  fi
  for key in PERSISTENT_RG EPHEMERAL_RG; do
    [[ "${!key}" =~ ^[A-Za-z0-9._()-]{1,89}$ ]] || fail "$key is not a valid resource group name"
  done
  for key in INGRESS_PIP_NAME AKS_NAME PG_ADMIN_USER AKS_NODE_VM_SIZE PG_SKU LOCATION; do
    [[ "${!key}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "$key contains unexpected characters"
  done
  [[ "$PG_TIER" =~ ^(Burstable|GeneralPurpose|MemoryOptimized)$ ]] || fail "PG_TIER must be Burstable, GeneralPurpose or MemoryOptimized"
  [[ "$AKS_NODE_COUNT" =~ ^[0-9]+$ ]] || fail "AKS_NODE_COUNT must be a number"
  ((AKS_NODE_COUNT >= 3)) || fail "AKS_NODE_COUNT must be at least 3 (one Kafka broker per node)"
  [[ "$PG_STORAGE_GB" =~ ^[0-9]+$ ]] || fail "PG_STORAGE_GB must be a number"
  [[ "$PG_VERSION" =~ ^[0-9]+$ ]] || fail "PG_VERSION must be a number"
  [[ "$WITH_LOKI" == true || "$WITH_LOKI" == false ]] || fail "WITH_LOKI must be true or false"
  if [[ -n "$GITHUB_DEPLOY_PRINCIPAL_ID" ]]; then
    [[ "$GITHUB_DEPLOY_PRINCIPAL_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "GITHUB_DEPLOY_PRINCIPAL_ID must be a GUID"
  fi
  if [[ -n "$OPERATOR_IP" ]]; then
    [[ "$OPERATOR_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "OPERATOR_IP must be an IPv4 address"
  fi
  [[ "$NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || fail "NAMESPACE must be a valid namespace name"
  [[ "$PERSISTENT_RG" != "$EPHEMERAL_RG" ]] || fail "PERSISTENT_RG and EPHEMERAL_RG must be different groups"
  overlay_ns="$(sed -n 's/^namespace:[[:space:]]*//p' "$PROJECT_DIR/deploy/azure/kustomization.yaml" | head -n 1)"
  [[ "$NAMESPACE" == "$overlay_ns" ]] || fail "NAMESPACE ($NAMESPACE) must equal namespace: in deploy/azure/kustomization.yaml ($overlay_ns)"
}

# Escapes a value for use in the replacement part of a sed s### expression.
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'
}

require_tools() {
  local tool missing=""
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  [[ -z "$missing" ]] || fail "missing required tools:$missing"
}

# --- Azure and Kubernetes helpers -------------------------------------------------------

# Verifies the selected az subscription is the configured one without changing it.
az_preflight() {
  local out version
  out="$(az account show --query '[id,name,tenantId,user.name]' --output tsv 2>/dev/null)" ||
    fail "not logged in to Azure; run: az login"
  {
    IFS= read -r SUB_ID
    IFS= read -r SUB_NAME
    IFS= read -r TENANT_ID
    IFS= read -r AZ_USER
  } <<<"$out"
  if [[ "$AZ_SUBSCRIPTION" != "$SUB_NAME" && "$(lowercase "$AZ_SUBSCRIPTION")" != "$(lowercase "$SUB_ID")" ]]; then
    fail "the selected subscription is '$SUB_NAME' ($SUB_ID), not '$AZ_SUBSCRIPTION'; run: az account set --subscription \"$AZ_SUBSCRIPTION\""
  fi
  version="$(az version --query '"azure-cli"' --output tsv 2>/dev/null || true)"
  if [[ -n "$version" ]] && [[ "$(printf '2.61.0\n%s\n' "$version" | sort -V | head -n 1)" != "2.61.0" ]]; then
    warn "Azure CLI $version is older than 2.61; app routing options may be missing"
  fi
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# Fills PROVIDERS_TO_REGISTER with the resource providers that are not registered yet.
provider_states() {
  local ns state
  PROVIDERS_TO_REGISTER=""
  for ns in Microsoft.ContainerService Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.Network Microsoft.Compute; do
    state="$(az provider show --namespace "$ns" --query registrationState --output tsv 2>/dev/null || true)"
    if [[ "$state" != "Registered" ]]; then
      PROVIDERS_TO_REGISTER="$PROVIDERS_TO_REGISTER $ns"
    fi
  done
}

# Prints true or false; fails when the group exists with the wrong lifecycle tag, or when
# it is still being deleted and the optional third argument is "refuse-deleting".
check_group() {
  local rg="$1" lifecycle="$2" deleting_mode="${3:-}" exists tag state
  exists="$(az group exists --name "$rg" --output tsv 2>/dev/null || true)"
  if [[ "$exists" != true ]]; then
    printf 'false'
    return 0
  fi
  if [[ "$deleting_mode" == refuse-deleting ]]; then
    state="$(az group show --name "$rg" --query 'properties.provisioningState' --output tsv 2>/dev/null || true)"
    if [[ "$state" == Deleting ]]; then
      fail "a previous deletion of $rg is still running; wait until 'az group exists --name $rg' prints false, then rerun"
    fi
  fi
  tag="$(az group show --name "$rg" --query 'tags.lifecycle' --output tsv 2>/dev/null || true)"
  if [[ "$tag" != "$lifecycle" ]]; then
    fail "resource group $rg exists but its lifecycle tag is '${tag:-missing}', expected '$lifecycle'; the scripts only manage groups they created. If the group is yours, run: az group update --name $rg --set tags.lifecycle=$lifecycle tags.managed-by=message-poc-scripts tags.project=message-poc"
  fi
  printf 'true'
}

k() { kubectl --context "$AKS_NAME" "$@"; }
h() { helm --kube-context "$AKS_NAME" "$@"; }

tag_label() {
  if [[ "$1" == true ]]; then
    printf '[exists, reused]'
  else
    printf '[new]'
  fi
}

# --- confirmation ------------------------------------------------------------------------

interactive_ok() {
  [[ -t 0 || "${AZURE_SCRIPTS_ALLOW_NON_TTY:-}" == 1 ]]
}

# Fails early so nobody sits through a preflight that cannot be confirmed.
require_confirmation_possible() {
  if ! "$ASSUME_YES" && ! interactive_ok; then
    fail "confirmation requires a terminal; use --yes-i-understand for automation"
  fi
}

# Two steps: y/N, then the exact resource group name. Declining changes nothing.
confirm_double() {
  local expected="$1" answer typed
  if "$ASSUME_YES"; then
    log "Confirmation skipped by --yes-i-understand."
    return 0
  fi
  interactive_ok || fail "confirmation requires a terminal; use --yes-i-understand for automation"
  printf '\nContinue? [y/N] ' >&2
  IFS= read -r answer || answer=""
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    log "Cancelled. Nothing was changed."
    exit 0
  fi
  printf 'Type the resource group name (%s) to confirm: ' "$expected" >&2
  IFS= read -r typed || typed=""
  if [[ "$typed" != "$expected" ]]; then
    log "Name did not match. Cancelled. Nothing was changed."
    exit 1
  fi
}

# Single typed confirmation that --yes-i-understand never skips.
confirm_typed_only() {
  local expected="$1" typed
  interactive_ok || fail "this confirmation requires a terminal and cannot be skipped"
  printf 'Type %s to confirm: ' "$expected" >&2
  IFS= read -r typed || typed=""
  if [[ "$typed" != "$expected" ]]; then
    log "Name did not match. Cancelled. Nothing was changed."
    exit 1
  fi
}

# --- text ---------------------------------------------------------------------------------

print_costs_running() {
  log "COST (approximate list prices; check the Azure pricing calculator for your region)"
  log "  Running cost while this environment exists: about \$11-13 per day, about \$0.50 per hour."
  log "  A 6 hour showcase including setup: about \$3-4."
  log "  FORGETTING TO TEAR DOWN: about \$350-400 per month. Run ./scripts/azure-down.sh when done."
  log "  Billing starts as soon as the resources exist, even if this script fails midway."
}

# Argument: true when the persistent group is deleted as well.
print_costs_idle() {
  if [[ "${1:-false}" == true ]]; then
    log "  Cost afterwards: \$0. Nothing is left in Azure."
  else
    log "  Cost afterwards: about \$0.12 per day (about \$3.6 per month) for the reserved static IP."
  fi
}

# Removes the local kubeconfig entries of a deleted cluster.
kube_context_cleanup() {
  local ctx="$1" rg="$2" current
  current="$(kubectl config current-context 2>/dev/null || true)"
  if [[ "$current" == "$ctx" ]]; then
    kubectl config unset current-context >/dev/null 2>&1 || true
  fi
  kubectl config delete-context "$ctx" >/dev/null 2>&1 || true
  kubectl config delete-cluster "$ctx" >/dev/null 2>&1 || true
  kubectl config delete-user "clusterUser_${rg}_${ctx}" >/dev/null 2>&1 || true
}
