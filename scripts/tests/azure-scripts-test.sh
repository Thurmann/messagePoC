#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2015  # check() evaluates single-quoted expressions on purpose
# Offline tests for scripts/azure-up.sh, scripts/azure-down.sh and scripts/lib/azure-common.sh.
# Every external CLI (az, kubectl, helm, psql, gh, ...) is replaced by a stub on PATH, so nothing
# touches Azure, GitHub or the network. Needs a real kubectl only for the manifest render checks;
# without one those checks are skipped.
#
# Usage: bash scripts/tests/azure-scripts-test.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

UP="$PROJECT_DIR/scripts/azure-up.sh"
DOWN="$PROJECT_DIR/scripts/azure-down.sh"

T="$(mktemp -d "${TMPDIR:-/tmp}/azure-scripts-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT

PASS=0
FAILN=0
SKIPPED=0

ok() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
bad() { FAILN=$((FAILN + 1)); printf 'FAIL %s\n' "$1"; }
# check NAME EXPRESSION: EXPRESSION is evaluated in this shell; the check passes when it succeeds.
check() {
  if eval "$2"; then ok "$1"; else bad "$1"; fi
}

REAL_KUBECTL="$(command -v kubectl || true)"
HAVE_KUBECTL=false
if [[ -n "$REAL_KUBECTL" ]] && "$REAL_KUBECTL" version --client >/dev/null 2>&1; then
  HAVE_KUBECTL=true
else
  printf 'NOTICE kubectl not available: skipping the manifest render checks and the full deploy flows\n'
fi
export REAL_KUBECTL

mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

export STUB_LOG="$T/stub.log" STUB_DIR="$T"
mkdir -p "$T/home"

sed -e 's/^AZ_SUBSCRIPTION=.*/AZ_SUBSCRIPTION=Test Sub/' -e 's/^HOST=.*/HOST=chat.mydomain.dev/' \
  -e 's/^API_HOST=.*/API_HOST=api.chat.mydomain.dev/' -e 's/^ACME_EMAIL=.*/ACME_EMAIL=ops@mydomain.dev/' \
  -e 's/^ADMIN_EMAILS=.*/ADMIN_EMAILS=ops@mydomain.dev,b@mydomain.dev/' \
  scripts/azure.env.example >"$T/test.env"

# --- stubs for azure-up.sh -----------------------------------------------------------
# The scripts call "base64 --decode"; BusyBox (the bash:3.2 image) only knows -d. Translate there.
REAL_BASE64="$(command -v base64)"
export REAL_BASE64
if ! "$REAL_BASE64" --decode </dev/null >/dev/null 2>&1; then B64_FLAG=-d; else B64_FLAG=--decode; fi
export B64_FLAG
cat >"$T/base64-shim" <<'SHIM'
#!/usr/bin/env bash
args=()
for a in "$@"; do if [[ "$a" == --decode ]]; then args+=("$B64_FLAG"); else args+=("$a"); fi; done
exec "$REAL_BASE64" ${args[@]+"${args[@]}"}
SHIM
chmod +x "$T/base64-shim"

mkdir -p "$T/bin-up"
cat >"$T/bin-up/stub" <<'STUB'
#!/usr/bin/env bash
name="$(basename "$0")"
echo "$name $*" >>"$STUB_LOG"
args=" $* "
case "$name" in
  az)
    case "$args" in
      *" account show "*) printf 'sub-id-1\nTest Sub\ntenant-1\nme@example.org\n' ;;
      *" version "*) echo 2.70.0 ;;
      *" provider show "*) echo Registered ;;
      *" group exists "*)
        if [[ -n "${STUB_RG_DELETING:-}" && "$args" == *" rg-message-poc "* ]]; then echo true; else echo false; fi ;;
      *" group show "*provisioningState*) echo "${STUB_RG_DELETING:-Succeeded}" ;;
      *" acr check-name "*) echo true ;;
      *" acr repository show "*) exit 3 ;;
      *" rest "*) echo true ;;
      *" network public-ip show "*)
        if [[ -f "$STUB_DIR/pip-created" ]]; then echo 20.0.0.1; else exit 3; fi ;;
      *" network public-ip create "*) touch "$STUB_DIR/pip-created" ;;
      *" vm list-skus "*) printf '%b\n' "${STUB_SKU:-standardDSv5Family\t0\t2}" ;;
      *" vm list-usage "*) printf '%b\n' "${STUB_USAGE:-standardDSv5Family\t0\t10}" ;;
      *" approuting update --help"*) echo "  --nginx" ;;
      *" aks show "*identity*) echo principal-1 ;;
      *" aks show "*) printf 'ouroutbound\n' ;;
      *" group show "*) echo /subscriptions/x/resourceGroups/rg ;;
      *" role assignment list "*) echo 0 ;;
    esac ;;
  kubectl)
    case "$args" in
      *" kustomize "*) exec "$REAL_KUBECTL" "$@" ;;
      *" get svc nginx "*) echo 20.0.0.1 ;;
    esac ;;
  psql) cat >/dev/null ;;
  gh)
    case "$args" in
      *" release view "*) echo v0.1.0 ;;
      *" variable get "*) echo false ;;
      *" repo view "*) echo SomeOwner ;;
      *" auth token "*) echo tok ;;
      *" api user "*) echo someone ;;
    esac ;;
  dig) echo 20.0.0.1 ;;
  curl) echo 203.0.113.9 ;;
  openssl)
    if [[ "$1 $2" == "rand -hex" ]]; then echo 00112233445566778899aabbccddeeff0011223344556677; fi ;;
esac
exit 0
STUB
chmod +x "$T/bin-up/stub"
for n in az kubectl helm psql pg_restore gh git dig curl openssl; do ln -s stub "$T/bin-up/$n"; done
ln -s ../base64-shim "$T/bin-up/base64"

# Calls that change state anywhere.
MUT='^(az (group create|network public-ip create|acr create|acr import|aks (create|start|get-credentials|wait)|aks approuting update [^-]|postgres flexible-server (create|update|start|firewall-rule)|role assignment create|provider register)|kubectl .* (apply|create|patch|wait|rollout)|helm|psql|pg_restore)'
mutations() { grep -E "$MUT" "$STUB_LOG" | grep -v -- '--help' || true; }
nomut() { [[ -z "$(mutations)" ]]; }

# --- config loader ---------------------------------------------------------------------
# loadcfg FILE [VAR=value ...]: load FILE through the library in a clean child shell.
loadcfg() {
  local f="$1"
  shift
  env ${1+"$@"} bash -c 'set -Eeuo pipefail; PROJECT_DIR="$1"; source "$1/scripts/lib/azure-common.sh"; load_config "$2"; apply_defaults; validate_config; echo "HOST=$HOST LOCATION=$LOCATION"' _ "$PROJECT_DIR" "$f"
}

check "config: example values rejected" '! loadcfg "$PROJECT_DIR/scripts/azure.env.example" >/dev/null 2>&1'
check "config: filled file loads" 'loadcfg "$T/test.env" >/dev/null 2>&1'
check "config: env overrides file" '[[ "$(loadcfg "$T/test.env" HOST=other.mydomain.dev 2>/dev/null)" == *HOST=other.mydomain.dev* ]]'
cp "$T/test.env" "$T/secret.env"
echo 'TYPESAFE_API_KEY=x' >>"$T/secret.env"
rc=0
out="$(loadcfg "$T/secret.env" 2>&1)" || rc=$?
check "config: env override of a different file value warns" '[[ "$(loadcfg "$T/test.env" HOST=other.mydomain.dev 2>&1)" == *"Warning: HOST is set in the environment"*chat.mydomain.dev* ]]'
check "config: env equal to file value does not warn" '[[ "$(loadcfg "$T/test.env" HOST=chat.mydomain.dev 2>&1)" != *Warning* ]]'
check "config: secret key rejected" '[[ $rc -ne 0 && $out == *"is a secret"* ]]'
cp "$T/test.env" "$T/pwn.env"
echo 'LOCATION=$(touch '"$T"'/pwn-test)' >>"$T/pwn.env"
loadcfg "$T/pwn.env" >/dev/null 2>&1 || true
check "config: command substitution not executed" '[[ ! -e "$T/pwn-test" ]]'
check "config: scripts/azure.env is gitignored" 'grep -qx "scripts/azure.env" .gitignore'

# --- CLI -------------------------------------------------------------------------------
check "up --help exits 0" '"$UP" --help >/dev/null 2>&1'
check "up -y rejected" '! "$UP" -y >/dev/null 2>&1'
rc=0
out="$("$UP" --yes 2>&1)" || rc=$?
check "up --yes rejected" '[[ $rc -ne 0 && $out == *"unknown option"* ]]'

# --- render ----------------------------------------------------------------------------
render() {
  PATH="$T/bin-up:$PATH" "$UP" --config "$T/test.env" --render-manifests --version 0.1.0 --manifests-from-worktree "$@" 2>"$T/render.err"
}
if "$HAVE_KUBECTL"; then
  render >"$T/render.out"
  check "render: no placeholders" '! grep -E "<[a-z][a-z0-9-]*>|example\.com" "$T/render.out"'
  check "render: 4 ACR images" '[[ $(grep -c "image: acrmessagepoc001.azurecr.io/message-poc/.*:0.1.0" "$T/render.out") -eq 4 ]]'
  check "render: both hosts" 'grep -q "host: chat.mydomain.dev" "$T/render.out" && grep -q "host: api.chat.mydomain.dev" "$T/render.out"'
  check "render: JDBC host" 'grep -q "jdbc:postgresql://pg-message-poc-001.postgres.database.azure.com:5432" "$T/render.out"'
  check "render: prod issuer by default" 'grep -q "cluster-issuer: letsencrypt-prod" "$T/render.out"'
  render --staging-cert >"$T/render-staging.out"
  check "render: staging issuer with --staging-cert" 'grep -q "cluster-issuer: letsencrypt-staging" "$T/render-staging.out" && ! grep -q "cluster-issuer: letsencrypt-prod" "$T/render-staging.out"'
  check "render: both ClusterIssuers present" '[[ $(grep -c "kind: ClusterIssuer" "$T/render.out") -eq 2 ]] && grep -q acme-staging-v02 "$T/render.out" && grep -q "email: ops@mydomain.dev" "$T/render.out"'
else
  SKIPPED=$((SKIPPED + 7))
fi

# --- azure-up.sh against stubs -----------------------------------------------------------
# run_up [options]: stdin comes from the caller, output goes to $T/out.txt.
run_up() {
  : >"$STUB_LOG"
  rm -f "$T/pip-created"
  PATH="$T/bin-up:$PATH" TYPESAFE_API_KEY=k HOME="$T/home" \
    "$UP" --config "$T/test.env" --version 0.1.0 --manifests-from-worktree "$@" >"$T/out.txt" 2>&1
}

if "$HAVE_KUBECTL"; then
  rc=0
  (export AZURE_SCRIPTS_ALLOW_NON_TTY=1; run_up <<<"n") || rc=$?
  check "up (a) n: exit 0" '[[ $rc -eq 0 ]]'
  check "up (a) n: says nothing changed" 'grep -q "Cancelled. Nothing was changed." "$T/out.txt"'
  check "up (a) n: no mutating call" 'nomut'
  check "up (a) summary printed" 'grep -q "WHAT THIS WILL CREATE" "$T/out.txt" && grep -q "FORGETTING TO TEAR DOWN" "$T/out.txt" && grep -q "\[new\]" "$T/out.txt"'

  rc=0
  (export AZURE_SCRIPTS_ALLOW_NON_TTY=1; run_up <<<$'y\nwrong-name') || rc=$?
  check "up (b) wrong name: exit 1" '[[ $rc -eq 1 ]]'
  check "up (b) wrong name: no mutating call" 'nomut'

  rc=0
  run_up </dev/null || rc=$?
  check "up (c) no tty: fails" '[[ $rc -ne 0 ]]'
  check "up (c) no tty: message" 'grep -q "requires a terminal" "$T/out.txt"'
  check "up (c) no tty: no mutating call" 'nomut'

  rc=0
  (export AZURE_SCRIPTS_ALLOW_NON_TTY=1; run_up --dry-run </dev/null) || rc=$?
  check "up (f) dry-run: exit 0" '[[ $rc -eq 0 ]]'
  check "up (f) dry-run: no mutating call" 'nomut'

  rc=0
  run_up --yes-i-understand </dev/null || rc=$?
  check "up (e) --yes-i-understand no tty: exit 0" '[[ $rc -eq 0 ]]'
  check "up (e) skip notice" 'grep -q "Confirmation skipped by --yes-i-understand" "$T/out.txt"'
  check "up (e) first mutation is persistent RG create" '[[ "$(mutations | head -n 1)" == "az group create --name rg-message-poc-persistent"* ]]'

  rc=0
  (export AZURE_SCRIPTS_ALLOW_NON_TTY=1; run_up <<<$'y\nrg-message-poc') || rc=$?
  check "up (d) happy path: exit 0" '[[ $rc -eq 0 ]]'
  mutations | awk '{print $1, $2, $3}' >"$T/order.txt"
  check "up (d) order: pip create second, ephemeral rg third" 'sed -n 2p "$T/order.txt" | grep -q "network public-ip" && sed -n 3p "$T/order.txt" | grep -q "group create"'
  check "up (d) order: helm installs before applying the manifests" 'h=$(grep -n "^helm .* upgrade" "$STUB_LOG" | head -1 | cut -d: -f1); a=$(grep -n "kubectl.* apply -f .*rendered.yaml" "$STUB_LOG" | head -1 | cut -d: -f1); [[ -n $h && -n $a && $h -lt $a ]]'
  check "up (d) four images imported" '[[ $(grep -c "^az acr import" "$STUB_LOG") -eq 4 ]]'
else
  SKIPPED=$((SKIPPED + 18))
fi

# Ephemeral group still being deleted: up must refuse before any mutation.
rc=0
(export AZURE_SCRIPTS_ALLOW_NON_TTY=1 STUB_RG_DELETING=Deleting; run_up --skip-deploy --dry-run </dev/null) || rc=$?
check "up deleting group: refuses" '[[ $rc -ne 0 ]] && grep -q "previous deletion of rg-message-poc is still running" "$T/out.txt"'
check "up deleting group: no mutating call" 'nomut'

rc=0
(export AZURE_SCRIPTS_ALLOW_NON_TTY=1 STUB_SKU='standardDSv5Family\t1\t2'; run_up --dry-run </dev/null) || rc=$?
check "up size not offered in region: refuses" '[[ $rc -ne 0 ]] && grep -q "NotAvailableForSubscription" "$T/out.txt"'
check "up size not offered in region: no mutating call" 'nomut'

rc=0
(export AZURE_SCRIPTS_ALLOW_NON_TTY=1 STUB_USAGE='standardDSv5Family\t0\t4'; run_up --dry-run </dev/null) || rc=$?
check "up quota too small: refuses" '[[ $rc -ne 0 ]] && grep -q "only 4 free vCPU in the standardDSv5Family quota" "$T/out.txt"'
rc=0
(unset TYPESAFE_API_KEY; : >"$STUB_LOG"; PATH="$T/bin-up:$PATH" HOME="$T/home" "$UP" --config "$T/test.env" --version 0.1.0 --skip-deploy --yes-i-understand </dev/null >"$T/out.txt" 2>&1) || rc=$?
check "up no tty without TYPESAFE_API_KEY: fails before preflight" '[[ $rc -ne 0 ]] && grep -q "TYPESAFE_API_KEY is not set" "$T/out.txt" && ! grep -q "^az " "$STUB_LOG"'

# --- stubs for azure-down.sh -------------------------------------------------------------
mkdir -p "$T/bin-down"
cat >"$T/bin-down/stub" <<'STUB'
#!/usr/bin/env bash
name="$(basename "$0")"
echo "$name $*" >>"$STUB_LOG"
args=" $* "
case "$name" in
  az)
    case "$args" in
      *" account show "*) printf 'sub-id-1\nTest Sub\ntenant-1\nme@example.org\n' ;;
      *" version "*) echo 2.70.0 ;;
      *" group exists "*)
        if [[ "$args" == *" rg-message-poc-persistent "* ]]; then echo true; elif [[ -n "${STUB_ONLY_PERSISTENT:-}" ]]; then echo false; elif [[ -f "$STUB_DIR/deleted-eph" ]]; then echo false; else echo true; fi ;;
      *" group delete --name rg-message-poc --yes"*) touch "$STUB_DIR/deleted-eph" ;;
      *" group show "*"tags.lifecycle"*)
        if [[ "$args" == *" rg-message-poc-persistent "* ]]; then echo "${STUB_PERS_TAG:-persistent}"; else echo "${STUB_EPH_TAG-ephemeral}"; fi ;;
      *" group show "*) echo /subscriptions/x/resourceGroups/rg-message-poc-persistent ;;
      *" resource list "*)
        if [[ "$args" == *" MC_"* ]]; then printf 'Microsoft.Compute/virtualMachineScaleSets\taks-nodepool1\tNone\n'
        elif [[ "$args" == *" rg-message-poc-persistent "* ]]; then printf 'Microsoft.Network/publicIPAddresses\tpip-message-poc-ingress\tmessage-poc-scripts\n'
        else printf 'Microsoft.ContainerRegistry/registries\tacrmessagepoc001\tmessage-poc-scripts\nMicrosoft.Storage/storageAccounts\tmanualstorage\tNone\n'; fi ;;
      *" aks show "*) printf 'Succeeded\nMC_rg-message-poc_aks-message-poc_norwayeast\nprincipal-1\n' ;;
      *" postgres flexible-server show "*) echo Ready ;;
      *" network public-ip show "*) printf '20.0.0.1\nNone\n' ;;
    esac ;;
  kubectl)
    case "$args" in
      *" get secret message-poc-secrets "*) printf '%s' "$(printf 'dbpass123' | base64)" ;;
      *'tls\.crt'*) printf 'Y3J0' ;;
      *'tls\.key'*) printf 'a2V5' ;;
      *" config current-context"*) echo aks-message-poc ;;
    esac ;;
  pg_dump)
    if [[ -n "${STUB_PGDUMP_FAIL:-}" ]]; then echo "pg_dump: boom" >&2; exit 1; fi
    if [[ "$args" == *" --version "* ]]; then echo "pg_dump (PostgreSQL) 17.2"; exit 0; fi
    prev=""; for a in "$@"; do if [[ "$prev" == --file ]]; then echo PGDMP >"$a"; fi; prev="$a"; done ;;
  curl) echo 203.0.113.9 ;;
esac
exit 0
STUB
chmod +x "$T/bin-down/stub"
for n in az kubectl pg_dump pg_restore curl; do ln -s stub "$T/bin-down/$n"; done
ln -s ../base64-shim "$T/bin-down/base64"

MUT='^(az (group delete|role assignment delete|aks get-credentials|postgres flexible-server firewall-rule)|pg_dump -Fc|kubectl config (delete|unset))'

# run_down [options]: stdin comes from the caller, output goes to $T/out.txt.
run_down() {
  rm -f "$T/deleted-eph"
  : >"$STUB_LOG"
  rm -rf "$T/home/message-poc-backups"
  PATH="$T/bin-down:$PATH" HOME="$T/home" "$DOWN" --config "$T/test.env" "$@" >"$T/out.txt" 2>&1
}
# The test hook lets the confirmation read from a pipe instead of a terminal.
export_hook() { export AZURE_SCRIPTS_ALLOW_NON_TTY=1; }

check "down --help exits 0" '"$DOWN" --help >/dev/null 2>&1'
check "down -y rejected" '! "$DOWN" -y >/dev/null 2>&1'
rc=0
out="$("$DOWN" --yes 2>&1)" || rc=$?
check "down --yes rejected" '[[ $rc -ne 0 && $out == *"unknown option"* ]]'

rc=0
(export_hook; run_down --no-backup <<<n) || rc=$?
check "down decline: exit 0" '[[ $rc -eq 0 ]]'
check "down decline: says nothing changed" 'grep -q "Cancelled. Nothing was changed." "$T/out.txt"'
check "down decline: no mutating call" 'nomut'
check "down summary: subscription, resources, untagged flag" 'grep -q "Test Sub (sub-id-1)" "$T/out.txt" && grep -q "acrmessagepoc001" "$T/out.txt" && grep -q "manualstorage.*NOT created by azure-up.sh" "$T/out.txt" && grep -q "MC_rg-message-poc_aks-message-poc_norwayeast" "$T/out.txt"'
check "down summary: data lost, survives, cost" 'for s in "users and handles" "Kafka" "Loki" "Container Registry" "TLS certificate" "WHAT SURVIVES" "20.0.0.1" "0.12 per day" "DATABASE BACKUP"; do grep -q "$s" "$T/out.txt" || exit 1; done'
check "down summary printed before prompt" 'grep -q "WHAT THIS WILL DELETE" "$T/out.txt" && grep -q "Continue?" "$T/out.txt"'

rc=0
(export_hook; run_down --no-backup <<<$'y\nwrong') || rc=$?
check "down wrong name: exit 1" '[[ $rc -eq 1 ]]'
check "down wrong name: no mutating call" 'nomut'

rc=0
(export_hook; export STUB_EPH_TAG=; run_down --no-backup <<<$'y\nrg-message-poc') || rc=$?
check "down missing lifecycle tag: refuses" '[[ $rc -ne 0 ]] && grep -q "lifecycle tag" "$T/out.txt"'
check "down missing lifecycle tag: no mutating call" 'nomut'

rc=0
(export_hook; export STUB_ONLY_PERSISTENT=1; run_down --no-backup <<<'') || rc=$?
check "down only persistent exists, no --include-persistent: nothing to delete" '[[ $rc -eq 0 ]] && grep -q "Nothing to delete" "$T/out.txt" && ! grep -q "Type the resource group name" "$T/out.txt"'
check "down only persistent exists, no --include-persistent: no group delete or role change" '! grep -qE "group delete|role assignment delete" "$STUB_LOG"'

rc=0
run_down --include-persistent --yes-i-understand --no-backup </dev/null || rc=$?
check "down include-persistent + yes, no tty: refuses" '[[ $rc -ne 0 ]] && grep -q "extra confirmation" "$T/out.txt"'
check "down include-persistent + yes, no tty: no mutating call" 'nomut'
rc=0
(export_hook; run_down --include-persistent --yes-i-understand --no-backup <<<'n') || rc=$?
check "down include-persistent + yes still asks: n cancels" '[[ $rc -ne 0 ]]'
check "down include-persistent + yes still asks: no mutating call" 'nomut'
rc=0
(export_hook; run_down --include-persistent --yes-i-understand --no-backup <<<'wrong') || rc=$?
check "down include-persistent typed wrong: exit 1" '[[ $rc -eq 1 ]]'
check "down include-persistent typed wrong: no mutating call" 'nomut'
check "down include-persistent: loud warning text" 'for s in "RELEASED FOREVER" "NEW, different address" "Vercel" "propagated" "Google"; do grep -q "$s" "$T/out.txt" || exit 1; done'

rc=0
run_down --yes-i-understand </dev/null || rc=$?
check "down non-interactive without backup choice: fails" '[[ $rc -ne 0 ]] && grep -q "explicitly" "$T/out.txt"'
check "down non-interactive without backup choice: no mutating call" 'nomut'

rc=0
run_down --no-wait --include-persistent --no-backup </dev/null || rc=$?
check "down --no-wait --include-persistent fails" '[[ $rc -ne 0 ]] && grep -q "cannot be combined" "$T/out.txt"'
check "down --no-wait --include-persistent: no mutating call" 'nomut'

rc=0
run_down --dry-run </dev/null || rc=$?
check "down dry-run: exit 0" '[[ $rc -eq 0 ]]'
check "down dry-run: no mutating call" 'nomut'
check "down dry-run: says nothing changed" 'grep -q "Dry run: nothing was changed" "$T/out.txt"'

rc=0
(export_hook; run_down --no-backup <<<$'y\nrg-message-poc') || rc=$?
check "down happy no-backup: exit 0" '[[ $rc -eq 0 ]]'
a="$(grep -n '^az role assignment delete' "$STUB_LOG" | head -1 | cut -d: -f1)"
b="$(grep -n '^az group delete --name rg-message-poc --yes' "$STUB_LOG" | head -1 | cut -d: -f1)"
c="$(grep -n '^kubectl config delete-context' "$STUB_LOG" | head -1 | cut -d: -f1)"
check "down happy no-backup: order role delete, group delete, delete-context" '[[ -n $a && -n $b && -n $c && $a -lt $b && $b -lt $c ]]'
check "down happy no-backup: no pg_dump" '! grep -q "^pg_dump -Fc" "$STUB_LOG"'
check "down happy no-backup: persistent group not deleted" '! grep -q "group delete --name rg-message-poc-persistent" "$STUB_LOG"'
check "down happy no-backup: verifies group gone and IP detached" 'grep -q "group exists --name rg-message-poc " "$STUB_LOG" && grep -q "public-ip show" "$STUB_LOG" && grep -q "is gone" "$T/out.txt" && grep -q "detached" "$T/out.txt"'
f="$T/home/message-poc-backups/message-poc-tls-secret.yaml"
check "down happy no-backup: TLS saved with mode 600, no cluster metadata" '[[ -f $f && $(mode "$f") == 600 ]] && grep -q "tls.crt: Y3J0" "$f" && ! grep -qE "resourceVersion|uid|managedFields" "$f"'
check "down happy no-backup: role scope is the persistent group" 'grep -q "role assignment delete --assignee principal-1 --role Network Contributor --scope /subscriptions/x/resourceGroups/rg-message-poc-persistent" "$STUB_LOG"'

rc=0
(export_hook; run_down --backup <<<$'y\nrg-message-poc') || rc=$?
check "down happy backup: exit 0" '[[ $rc -eq 0 ]]'
d="$(grep -n '^pg_dump -Fc' "$STUB_LOG" | head -1 | cut -d: -f1)"
b="$(grep -n '^az group delete --name rg-message-poc --yes' "$STUB_LOG" | head -1 | cut -d: -f1)"
check "down happy backup: pg_dump before group delete" '[[ -n $d && -n $b && $d -lt $b ]]'
check "down happy backup: dump file mode 600" 'for f in "$T"/home/message-poc-backups/message_poc-*.dump; do [[ $(mode "$f") == 600 ]]; done'

rc=0
(export_hook; export STUB_PGDUMP_FAIL=1; run_down --backup <<<$'y\nrg-message-poc') || rc=$?
check "down failing pg_dump: exit non-zero" '[[ $rc -ne 0 ]]'
check "down failing pg_dump: no group delete" '! grep -q "group delete" "$STUB_LOG"'
check "down failing pg_dump: says nothing was deleted" 'grep -q "nothing was deleted" "$T/out.txt"'

rc=0
(export_hook; run_down --no-backup --no-wait <<<$'y\nrg-message-poc') || rc=$?
check "down --no-wait: delete with --no-wait, exit 0" '[[ $rc -eq 0 ]] && grep -q "group delete --name rg-message-poc --yes --no-wait" "$STUB_LOG"'

rc=0
(export_hook; run_down --no-backup --include-persistent <<<$'y\nrg-message-poc\nrg-message-poc-persistent') || rc=$?
e="$(grep -n 'group delete --name rg-message-poc --yes' "$STUB_LOG" | head -1 | cut -d: -f1)"
p="$(grep -n 'group delete --name rg-message-poc-persistent' "$STUB_LOG" | head -1 | cut -d: -f1)"
check "down include-persistent happy: persistent deleted after ephemeral" '[[ $rc -eq 0 && -n $e && -n $p && $e -lt $p ]]'

printf '\npassed=%d failed=%d skipped=%d\n' "$PASS" "$FAILN" "$SKIPPED"
[[ $FAILN -eq 0 ]]
