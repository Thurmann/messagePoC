#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/azure-common.sh
source "${SCRIPT_DIR}/lib/azure-common.sh"

CONFIG_FILE="${SCRIPT_DIR}/azure.env"
ASSUME_YES=false
DRY_RUN=false
BACKUP=""
BACKUP_DIR_FLAG=""
SAVE_TLS=true
INCLUDE_PERSISTENT=false
NO_WAIT=false

usage() {
  cat <<'EOF2'
Usage: ./scripts/azure-down.sh [options]

Deletes the ephemeral Azure showcase environment (resource group with ACR, AKS,
PostgreSQL and the AKS node group). The persistent resource group with the static
ingress IP is kept unless you pass --include-persistent.

Before anything is deleted, the script prints exactly what will be deleted, what
data is lost, what survives and what it costs afterwards, then asks twice:
"Continue? [y/N]" and the ephemeral resource group name.

Options:
  --config FILE            Use FILE instead of scripts/azure.env.
  --backup                 Dump the database to the backup directory before deleting.
  --no-backup              Delete without a database dump (all messages are lost).
  --backup-dir DIR         Where backups go (default: BACKUP_DIR or ~/message-poc-backups).
  --no-save-tls            Do not save the TLS certificate for the next azure-up.sh run.
  --include-persistent     ALSO delete the persistent group: the static IP is released
                           forever and the next azure-up.sh gets a different address.
                           Always asks for an extra typed confirmation.
  --no-wait                Do not wait for the deletion to finish.
  --dry-run                Run the read-only checks, print the plan and exit.
  --yes-i-understand       Skip the two standard confirmations (automation only; needs
                           --backup or --no-backup).
  -h, --help               Show this help.

Examples:
  ./scripts/azure-down.sh --dry-run
  ./scripts/azure-down.sh --backup
  ./scripts/azure-down.sh --no-backup --no-wait
EOF2
}

while (($# > 0)); do
  case "$1" in
    --config)
      shift
      (($# > 0)) || fail "--config requires a file"
      CONFIG_FILE="$1"
      ;;
    --backup) BACKUP=true ;;
    --no-backup) BACKUP=false ;;
    --backup-dir)
      shift
      (($# > 0)) || fail "--backup-dir requires a directory"
      BACKUP_DIR_FLAG="$1"
      ;;
    --no-save-tls) SAVE_TLS=false ;;
    --include-persistent) INCLUDE_PERSISTENT=true ;;
    --no-wait) NO_WAIT=true ;;
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

if "$INCLUDE_PERSISTENT" && "$NO_WAIT"; then
  fail "--no-wait cannot be combined with --include-persistent (the static IP can only be deleted after the ephemeral group is gone)"
fi
if ! "$DRY_RUN"; then
  require_confirmation_possible
  if "$INCLUDE_PERSISTENT"; then
    interactive_ok || fail "--include-persistent needs a terminal for its extra confirmation, which --yes-i-understand never skips"
  fi
  if [[ -z "$BACKUP" ]] && { "$ASSUME_YES" || ! interactive_ok; }; then
    fail "non-interactive runs must pass --backup or --no-backup explicitly"
  fi
fi

trap 'on_exit $?' EXIT
trap on_interrupt INT TERM
make_work_dir

# --- read-only preflight ------------------------------------------------------------------

# Prints "type name managed" lines for a group, one resource per line.
list_resources() {
  az resource list --resource-group "$1" --query '[].[type,name,tags."managed-by"]' --output tsv 2>/dev/null || true
}

preflight() {
  local out

  section "Checking the Azure account and existing resources (read-only)"
  az_preflight

  EPHEMERAL_EXISTS="$(check_group "$EPHEMERAL_RG" ephemeral)"
  PERSISTENT_EXISTS=false
  if "$INCLUDE_PERSISTENT"; then
    PERSISTENT_EXISTS="$(check_group "$PERSISTENT_RG" persistent)"
  else
    PERSISTENT_EXISTS="$(az group exists --name "$PERSISTENT_RG" --output tsv 2>/dev/null || echo false)"
  fi

  PIP_EXISTS=false
  PIP_IP=""
  PIP_ATTACHED=""
  if [[ "$PERSISTENT_EXISTS" == true ]] &&
    out="$(az network public-ip show --resource-group "$PERSISTENT_RG" --name "$INGRESS_PIP_NAME" --query '[ipAddress,ipConfiguration.id]' --output tsv 2>/dev/null)"; then
    PIP_EXISTS=true
    {
      IFS= read -r PIP_IP
      IFS= read -r PIP_ATTACHED || true
    } <<<"$out"
    [[ "$PIP_ATTACHED" != None ]] || PIP_ATTACHED=""
  fi

  EPH_RESOURCES=""
  NODE_RG=""
  NODE_RESOURCES=""
  AKS_PROV=""
  AKS_PRINCIPAL=""
  PG_EXISTS=false
  PG_STATE=""
  if [[ "$EPHEMERAL_EXISTS" == true ]]; then
    EPH_RESOURCES="$(list_resources "$EPHEMERAL_RG")"
    if out="$(az aks show --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --query '[provisioningState,nodeResourceGroup,identity.principalId]' --output tsv 2>/dev/null)"; then
      {
        IFS= read -r AKS_PROV
        IFS= read -r NODE_RG
        IFS= read -r AKS_PRINCIPAL || true
      } <<<"$out"
      [[ "$AKS_PRINCIPAL" != None ]] || AKS_PRINCIPAL=""
    fi
    if [[ -n "$NODE_RG" ]]; then
      NODE_RESOURCES="$(list_resources "$NODE_RG")"
    fi
    if out="$(az postgres flexible-server show --resource-group "$EPHEMERAL_RG" --name "$PG_SERVER" --query state --output tsv 2>/dev/null)"; then
      PG_EXISTS=true
      PG_STATE="$out"
    fi
  fi

  PERSISTENT_RESOURCES=""
  if "$INCLUDE_PERSISTENT" && [[ "$PERSISTENT_EXISTS" == true ]]; then
    PERSISTENT_RESOURCES="$(list_resources "$PERSISTENT_RG")"
  fi

  DO_BACKUP=false
  if [[ "$BACKUP" == true && "$EPHEMERAL_EXISTS" == true ]]; then
    if [[ "$PG_EXISTS" == true ]]; then
      DO_BACKUP=true
    else
      warn "no PostgreSQL server $PG_SERVER exists, so there is nothing to back up"
    fi
  fi
  if "$DO_BACKUP"; then
    require_tools pg_dump pg_restore
    check_pg_dump_version
  fi
}

check_pg_dump_version() {
  local major
  major="$(pg_dump --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/' || true)"
  if [[ "$major" =~ ^[0-9]+$ ]]; then
    ((major >= PG_VERSION)) || fail "pg_dump is version $major but the server is $PG_VERSION; install a newer PostgreSQL client"
  else
    warn "could not read the pg_dump version; it must be at least $PG_VERSION"
  fi
}

# Lists "type name" lines; with flag=true marks resources without our managed-by tag.
print_list() {
  local data="$1" flag="$2" rtype rname managed
  if [[ -z "$data" ]]; then
    log "      (no resources found)"
    return 0
  fi
  while IFS=$'\t' read -r rtype rname managed; do
    [[ -n "$rname" ]] || continue
    if [[ "$flag" == true && "$managed" != message-poc-scripts ]]; then
      log "      $rtype  $rname   <-- NOT created by azure-up.sh (no managed-by tag), will ALSO be deleted"
    else
      log "      $rtype  $rname"
    fi
  done <<<"$data"
}

print_down_summary() {
  local backup_text
  if "$DO_BACKUP"; then
    backup_text="YES: pg_dump to ${BACKUP_DIR}/message_poc-<UTC timestamp>.dump (mode 600); the deletion is aborted if the dump fails"
  elif [[ "$BACKUP" == false ]]; then
    backup_text="NO (--no-backup): the database is not saved anywhere"
  elif [[ "$PG_EXISTS" != true ]]; then
    backup_text="not applicable: no PostgreSQL server exists"
  else
    backup_text="will be asked (use --backup or --no-backup)"
  fi
  log ""
  log "================================================================================"
  log "WHAT THIS WILL DELETE"
  log "================================================================================"
  log "Subscription : $SUB_NAME ($SUB_ID)"
  log "Tenant       : $TENANT_ID"
  log "Signed in as : $AZ_USER"
  log ""
  if [[ "$EPHEMERAL_EXISTS" == true ]]; then
    log "EPHEMERAL resource group: $EPHEMERAL_RG  (deleted with EVERYTHING inside it)"
    print_list "$EPH_RESOURCES" true
    if [[ -n "$NODE_RG" ]]; then
      log "  AKS node resource group: $NODE_RG  (managed by AKS, deleted together with the cluster)"
      print_list "$NODE_RESOURCES" false
    else
      log "  AKS node resource group: none found (no AKS cluster $AKS_NAME)"
    fi
    log "  Anything else that someone added to these groups is deleted too."
  else
    log "EPHEMERAL resource group: $EPHEMERAL_RG  does not exist; nothing to delete there."
  fi
  log ""
  log "DATA THAT WILL BE LOST"
  log "  - PostgreSQL: all messages, users and handles, strikes and bans"
  log "  - Kafka: all topics, messages and consumer offsets (the 3 broker disks)"
  log "  - Loki: all collected logs (if Loki was deployed)"
  log "  - Container Registry: the imported images (re-importable from GHCR by azure-up.sh)"
  if "$SAVE_TLS"; then
    log "  - TLS certificate: saved to ${BACKUP_DIR}/${TLS_BACKUP_NAME} if it exists (reused by azure-up.sh)"
  else
    log "  - TLS certificate: NOT saved (--no-save-tls); a new one is requested next time (Let's Encrypt rate limits apply)"
  fi
  log ""
  log "DATABASE BACKUP: $backup_text"
  if [[ "$PG_EXISTS" == true ]]; then
    log "  (PostgreSQL server $PG_SERVER, state: $PG_STATE)"
  fi
  log ""
  log "WHAT SURVIVES"
  if "$INCLUDE_PERSISTENT"; then
    log "  - GHCR images, GitHub configuration, DNS records and local backups"
    log "  - NOT the persistent group: see the warning below"
  else
    if [[ "$PIP_EXISTS" == true ]]; then
      log "  - Persistent resource group $PERSISTENT_RG with the static IP $INGRESS_PIP_NAME ($PIP_IP), so DNS stays valid"
    else
      log "  - Persistent resource group $PERSISTENT_RG with the static IP $INGRESS_PIP_NAME (not found right now)"
    fi
    log "  - DNS records, GHCR images, GitHub configuration and local backups ($BACKUP_DIR)"
  fi
  log "  - The Network Contributor role of the cluster identity on the persistent group is removed first"
  if "$INCLUDE_PERSISTENT"; then
    log ""
    log "!!! ALSO DELETING THE PERSISTENT RESOURCE GROUP: $PERSISTENT_RG !!!"
    print_list "$PERSISTENT_RESOURCES" true
    log "  - The static IP ${PIP_IP:-$INGRESS_PIP_NAME} is RELEASED FOREVER; you cannot get this address back."
    log "  - The next azure-up.sh reserves a NEW, different address."
    log "  - You must then change the A records for $HOST and $API_HOST (for example in Vercel)."
    log "  - Certificates cannot be issued until the new DNS records have propagated."
    log "  - A Google OAuth origin is unaffected only if the host names stay the same."
  fi
  log ""
  log "COST"
  print_costs_idle "$INCLUDE_PERSISTENT"
  log "  Ephemeral group: \$0 once deleted."
  log "================================================================================"
}

# --- mutating steps -----------------------------------------------------------------------

connect_cluster() {
  az aks get-credentials --resource-group "$EPHEMERAL_RG" --name "$AKS_NAME" --context "$AKS_NAME" --overwrite-existing >/dev/null
}

backup_db() {
  local pw ts out tmp ip
  [[ -n "$AKS_PROV" ]] || fail "cannot read the database password: AKS cluster $AKS_NAME does not exist; use --no-backup to delete without a dump"
  connect_cluster || fail "could not get cluster credentials for the backup"
  pw="$(k -n "$NAMESPACE" get secret message-poc-secrets -o jsonpath='{.data.DB_PASSWORD}' 2>/dev/null | base64 --decode 2>/dev/null || true)"
  [[ -n "$pw" ]] || fail "could not read DB_PASSWORD from the Secret message-poc-secrets; nothing was deleted (use --no-backup to skip the dump)"
  ip="${OPERATOR_IP:-}"
  if [[ -z "$ip" ]]; then
    ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  fi
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "could not detect your public IP for the PostgreSQL firewall; set OPERATOR_IP"
  az postgres flexible-server firewall-rule create --resource-group "$EPHEMERAL_RG" --name "$PG_SERVER" \
    --rule-name operator --start-ip-address "$ip" --end-ip-address "$ip" --output none ||
    fail "could not open the PostgreSQL firewall for $ip; nothing was deleted"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  out="${BACKUP_DIR}/message_poc-${ts}.dump"
  tmp="${out}.partial"
  (umask 077 && mkdir -p "$BACKUP_DIR") || fail "cannot create $BACKUP_DIR"
  log "Dumping database message_poc to $out"
  if ! (umask 077 && PGPASSWORD="$pw" pg_dump -Fc --no-owner --no-privileges --file "$tmp" \
    "host=${PG_SERVER}.postgres.database.azure.com port=5432 dbname=message_poc user=message_poc sslmode=require"); then
    rm -f "$tmp"
    fail "pg_dump failed; nothing was deleted"
  fi
  if [[ ! -s "$tmp" ]] || ! pg_restore --list "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    fail "the dump is empty or unreadable; nothing was deleted"
  fi
  mv "$tmp" "$out"
  chmod 600 "$out"
  log "Backup written: $out ($(wc -c <"$out" | tr -d '[:space:]') bytes)"
  log "Restore it into the next environment with: ./scripts/azure-up.sh --restore-db $out"
}

# Writes the certificate Secret without server-managed metadata, in the form azure-up.sh restores.
save_tls() {
  local crt key file="${BACKUP_DIR}/${TLS_BACKUP_NAME}"
  [[ -n "$AKS_PROV" ]] || return 0
  crt="$(k -n "$NAMESPACE" get secret message-poc-tls -o jsonpath='{.data.tls\.crt}' 2>/dev/null || true)"
  key="$(k -n "$NAMESPACE" get secret message-poc-tls -o jsonpath='{.data.tls\.key}' 2>/dev/null || true)"
  if [[ -z "$crt" || -z "$key" ]]; then
    log "No TLS secret message-poc-tls found in the cluster; nothing to save."
    return 0
  fi
  (umask 077 && mkdir -p "$BACKUP_DIR") || return 1
  (
    umask 077
    cat >"$file" <<EOF2
apiVersion: v1
kind: Secret
metadata:
  name: message-poc-tls
  namespace: ${NAMESPACE}
type: kubernetes.io/tls
data:
  tls.crt: ${crt}
  tls.key: ${key}
EOF2
  ) || return 1
  chmod 600 "$file"
  log "TLS certificate saved to $file"
}

revoke_network_contributor() {
  local scope
  [[ -n "$AKS_PRINCIPAL" && "$PERSISTENT_EXISTS" == true ]] || return 0
  scope="$(az group show --name "$PERSISTENT_RG" --query id --output tsv 2>/dev/null || true)"
  [[ -n "$scope" ]] || return 0
  az role assignment delete --assignee "$AKS_PRINCIPAL" --role "Network Contributor" --scope "$scope" ||
    warn "could not remove the Network Contributor assignment of $AKS_PRINCIPAL on $PERSISTENT_RG; remove it manually if it shows as Unknown"
}

delete_group() {
  local rg="$1"
  shift
  log "Deleting resource group $rg"
  az group delete --name "$rg" --yes "$@"
}

verify_ephemeral_gone() {
  local exists
  exists="$(az group exists --name "$EPHEMERAL_RG" --output tsv 2>/dev/null || true)"
  [[ "$exists" == false ]] || fail "resource group $EPHEMERAL_RG still exists after the deletion"
  log "Resource group $EPHEMERAL_RG is gone."
}

verify_pip_detached() {
  local out ip attached=""
  [[ "$PIP_EXISTS" == true ]] || return 0
  if ! out="$(az network public-ip show --resource-group "$PERSISTENT_RG" --name "$INGRESS_PIP_NAME" --query '[ipAddress,ipConfiguration.id]' --output tsv 2>/dev/null)"; then
    fail "the static IP $INGRESS_PIP_NAME no longer exists in $PERSISTENT_RG; check the Azure portal"
  fi
  {
    IFS= read -r ip
    IFS= read -r attached || true
  } <<<"$out"
  [[ "$attached" != None ]] || attached=""
  if [[ -n "$attached" ]]; then
    warn "the static IP $ip still shows an attachment ($attached); it may take a moment to detach"
  else
    log "Static IP $ip still exists in $PERSISTENT_RG and is detached."
  fi
}

print_result() {
  log ""
  log "================================================================================"
  if [[ "$EPHEMERAL_EXISTS" == true ]]; then
    if "$NO_WAIT"; then
      log "Deletion of $EPHEMERAL_RG was requested and continues in Azure."
      log "Check with: az group exists --name $EPHEMERAL_RG   (false means it is gone and billing stopped)"
    else
      log "The ephemeral environment is deleted."
    fi
  fi
  if "$INCLUDE_PERSISTENT"; then
    log "The persistent group $PERSISTENT_RG is deleted; nothing is left in Azure."
    log "The next azure-up.sh gets a NEW static IP: change the A records for $HOST and $API_HOST."
  else
    log "Still in Azure: $PERSISTENT_RG with the static IP ${PIP_IP:-$INGRESS_PIP_NAME}."
  fi
  print_costs_idle "$INCLUDE_PERSISTENT"
  if "$DO_BACKUP"; then
    log "The database backup is in $BACKUP_DIR"
  fi
  log "Set the GitHub variable DEPLOY_TO_AKS to false until the next showcase."
  log "================================================================================"
}

# --- main ---------------------------------------------------------------------------------

[[ -f "$CONFIG_FILE" ]] || fail "config file not found: $CONFIG_FILE (copy scripts/azure.env.example to scripts/azure.env and edit it)"
load_config "$CONFIG_FILE"
apply_defaults
[[ -z "$BACKUP_DIR_FLAG" ]] || BACKUP_DIR="$BACKUP_DIR_FLAG"
validate_config
require_tools az kubectl

if [[ -z "$BACKUP" ]] && ! "$DRY_RUN" && ! "$ASSUME_YES" && interactive_ok; then
  printf 'Back up the database first? [Y/n] ' >&2
  IFS= read -r answer || answer=""
  if [[ "$answer" =~ ^[Nn]$ ]]; then
    BACKUP=false
  else
    BACKUP=true
  fi
fi

preflight
print_down_summary

if "$DRY_RUN"; then
  log ""
  log "Dry run: nothing was changed."
  exit 0
fi

if [[ "$EPHEMERAL_EXISTS" != true && ! ( "$INCLUDE_PERSISTENT" && "$PERSISTENT_EXISTS" == true ) ]]; then
  log ""
  log "Nothing to delete."
  kube_context_cleanup "$AKS_NAME" "$EPHEMERAL_RG"
  exit 0
fi

section "Confirmation"
if [[ "$EPHEMERAL_EXISTS" == true ]]; then
  confirm_double "$EPHEMERAL_RG"
else
  confirm_double "$PERSISTENT_RG"
fi
if "$INCLUDE_PERSISTENT"; then
  log ""
  log "The static IP ${PIP_IP:-$INGRESS_PIP_NAME} will be released forever and $HOST / $API_HOST will need new A records."
  confirm_typed_only "$PERSISTENT_RG"
fi

if [[ "$EPHEMERAL_EXISTS" == true ]]; then
  if "$DO_BACKUP"; then
    section "Backing up the database"
    backup_db
  fi
  if "$SAVE_TLS" && [[ -n "$AKS_PROV" ]]; then
    section "Saving the TLS certificate"
    if ! { [[ "$DO_BACKUP" == true ]] || connect_cluster; } || ! save_tls; then
      warn "could not save the TLS certificate; continuing"
    fi
  fi
  section "Removing the cluster's access to the static IP"
  revoke_network_contributor
  section "Deleting the ephemeral resource group"
  if "$NO_WAIT"; then
    delete_group "$EPHEMERAL_RG" --no-wait
  else
    delete_group "$EPHEMERAL_RG"
    verify_ephemeral_gone
    if "$INCLUDE_PERSISTENT"; then
      log "The static IP is about to be deleted as requested."
    else
      verify_pip_detached
    fi
  fi
fi
if "$INCLUDE_PERSISTENT" && [[ "$PERSISTENT_EXISTS" == true ]]; then
  section "Deleting the persistent resource group"
  delete_group "$PERSISTENT_RG"
fi
section "Cleaning up the local kubeconfig"
kube_context_cleanup "$AKS_NAME" "$EPHEMERAL_RG"
CURRENT_STEP=""
print_result
