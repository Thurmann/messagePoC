#!/usr/bin/env bash
# Tests Kafka broker failover on the AKS showcase (Strimzi cluster "message-poc").
#
#   Phase 0  all 3 brokers up: create a test topic (3 partitions, RF 3, min ISR 2), check ISR = 3.
#   Phase 1  stop 1 broker: acks=all writes must still succeed and be readable (ISR = 2).
#   Phase 2  stop a 2nd broker: acks=all writes must FAIL (only 1 replica left < min ISR 2).
#   Restore  bring both brokers back, wait until every partition has ISR = 3, delete the topic.
#
# Strimzi recreates a deleted broker pod within seconds, so the script first cordons the
# nodes (no new scheduling; running pods are not touched) and then deletes the broker pod.
# The recreated pod stays Pending, so the broker stays down until the restore uncordons
# the nodes. Cordoned nodes are labelled, so `restore` can undo it from another shell.
#
# Note: each Kafka node is both broker and KRaft controller. With two nodes down the
# controller quorum (2 of 3) is lost as well, so Phase 2 can fail with NotEnoughReplicas
# or with a timeout. Both mean the same thing here: acks=all writes are refused.

set -Eeuo pipefail

CONTEXT="aks-message-poc"
NAMESPACE="message-poc"
CLUSTER="message-poc"
POOL="dual-role"
TOPIC="failover-test"
FIRST=2
SECOND=1
PAUSE=true
ASSUME_YES=false
COMMAND=""
NODE_LABEL="message-poc/failover-test-cordoned"
KAFKA_BIN="/opt/kafka/bin"
RECORDS=9
RESTORE_ON_EXIT=false

usage() {
  cat <<'EOF'
Usage: ./scripts/kafka-failover-test.sh <command> [options]

Commands:
  run        Run the whole test: one broker down, then two, then restore (about 10-15 min).
  restore    Bring stopped brokers back and remove the test topic (after an interrupted run).
  status     Show the broker pods, node scheduling and the test topic's ISR.

Options:
  --first N        Index of the first broker to stop (default 2).
  --second N       Index of the second broker to stop (default 1).
  --no-pause       Do not wait for Enter between phases.
  --yes            Skip the confirmation question.
  --context NAME   kubectl context (default aks-message-poc).
  --namespace NS   Namespace of the Kafka cluster (default message-poc).
  -h, --help       Show this help.

While a phase waits for Enter, try the chat in the browser: with one broker down it
should work; with two down, sending a message should fail or hang.
EOF
}

log() { printf '%s\n' "$*" >&2; }
section() { printf '\n==> %s\n' "$*" >&2; }
pass() { printf 'PASS  %s\n' "$*" >&2; }
fail_check() { printf 'FAIL  %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

k() { kubectl --context "$CONTEXT" "$@"; }
kn() { kubectl --context "$CONTEXT" -n "$NAMESPACE" "$@"; }

broker_pod() { printf '%s-%s-%s' "$CLUSTER" "$POOL" "$1"; }

# Runs a Kafka CLI tool inside a running broker pod.
kafka_exec() {
  local pod="$1"
  shift
  kn exec -i "$pod" -c kafka -- "$@"
}

pod_phase() {
  kn get pod "$1" -o jsonpath='{.status.phase}' 2>/dev/null || true
}

pod_ready() {
  [[ "$(kn get pod "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)" == True ]]
}

pause() {
  if "$PAUSE"; then
    log ""
    log "$1"
    read -r -p "Press Enter to continue... " _ </dev/tty
  fi
}

# Prints the test topic's partitions with leader, replicas and ISR.
describe_topic() {
  kafka_exec "$1" timeout 30 "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 \
    --describe --topic "$TOPIC" 2>/dev/null | grep 'Partition:' || true
}

# Smallest ISR size over the test topic's partitions (0 when unknown).
min_isr_size() {
  describe_topic "$1" | awk '
    { for (i = 1; i <= NF; i++) if ($i == "Isr:") { n = split($(i + 1), a, ","); if (min == "" || n < min) min = n } }
    END { print (min == "" ? 0 : min) }'
}

wait_for_isr() {
  local pod="$1" want="$2" timeout="$3" i size
  for ((i = 0; i < timeout; i += 5)); do
    size="$(min_isr_size "$pod")"
    if [[ "$size" == "$want" ]]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# Produces $RECORDS keyed records (keys spread them over the partitions) with acks=all.
# Prints the producer's output; the caller counts the errors.
produce() {
  local pod="$1" marker="$2" i
  for ((i = 0; i < RECORDS; i++)); do
    printf 'key-%s:%s-%s\n' "$i" "$marker" "$i"
  done | kafka_exec "$pod" timeout 90 "$KAFKA_BIN/kafka-console-producer.sh" \
    --bootstrap-server localhost:9092 --topic "$TOPIC" \
    --property parse.key=true --property key.separator=: \
    --producer-property acks=all \
    --producer-property linger.ms=0 \
    --producer-property request.timeout.ms=10000 \
    --producer-property delivery.timeout.ms=30000 \
    --producer-property max.block.ms=30000 2>&1 || true
}

# Failed sends: the console producer logs "Error when sending" per record; a send that
# cannot even fetch metadata ends the producer with a TimeoutException instead.
count_errors() {
  grep -cE 'Error when sending|errors\.TimeoutException|NotEnoughReplicas' <<<"$1" || true
}

# Distinct Kafka exception classes in the producer output, with counts.
error_reasons() {
  grep -oE 'org\.apache\.kafka\.[A-Za-z.]+Exception' <<<"$1" | sort | uniq -c | sed 's/^/  /' || true
}

# Counts records with this marker that a fresh consumer can read back.
consume_count() {
  local pod="$1" marker="$2"
  kafka_exec "$pod" timeout 60 "$KAFKA_BIN/kafka-console-consumer.sh" \
    --bootstrap-server localhost:9092 --topic "$TOPIC" --from-beginning \
    --timeout-ms 20000 2>/dev/null | grep -c "^${marker}-" || true
}

# Cordons every schedulable node and labels it, so restore uncordons only these.
# (A jsonpath filter on spec.unschedulable does not work: the field is absent on
# schedulable nodes, and kubectl's filter does not match a missing field.)
cordon_nodes() {
  local node unschedulable count=0
  while read -r node unschedulable; do
    [[ -n "$node" ]] || continue
    if [[ "$unschedulable" == true ]]; then
      log "Node $node is already cordoned; leaving it as it is"
      continue
    fi
    k label node "$node" "${NODE_LABEL}=true" --overwrite >/dev/null
    k cordon "$node" >/dev/null
    log "Cordoned $node"
    count=$((count + 1))
  done < <(k get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.unschedulable}{"\n"}{end}')
  ((count > 0)) || die "no node was cordoned, so a stopped broker would restart at once"
  # Double-check: every node must now refuse new pods.
  if k get nodes -o jsonpath='{range .items[*]}{.spec.unschedulable}{"\n"}{end}' | grep -qv '^true$'; then
    die "some nodes are still schedulable after cordoning"
  fi
}

uncordon_nodes() {
  local node
  for node in $(k get nodes -l "${NODE_LABEL}=true" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'); do
    k uncordon "$node" >/dev/null
    k label node "$node" "${NODE_LABEL}-" >/dev/null
    log "Uncordoned $node"
  done
}

# Deletes a broker pod (graceful Kafka shutdown) and checks that it stays down.
stop_broker() {
  local index="$1" pod i phase
  pod="$(broker_pod "$index")"
  log "Stopping broker $index ($pod); Kafka shuts down gracefully (up to a minute)"
  kn delete pod "$pod" --wait=true --timeout=180s >/dev/null
  # Strimzi recreates the pod within seconds; on cordoned nodes it must stay Pending.
  for i in 1 2 3 4 5 6; do
    sleep 5
    phase="$(pod_phase "$pod")"
    case "$phase" in
      "" | Pending) ;;
      *) die "$pod is $phase again, so the broker restarted; the test is not valid (cordon did not hold)" ;;
    esac
  done
  log "Broker $index is down (pod status: ${phase:-not recreated yet})"
}

# Waits until a pod exists and is Ready (Strimzi may take a moment to recreate it).
wait_pod_ready() {
  local pod="$1" timeout="$2" i
  for ((i = 0; i < timeout; i += 5)); do
    if pod_ready "$pod"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

restore() {
  local i pod survivor=""
  section "Restoring"
  uncordon_nodes
  log "Waiting for all broker pods to be Ready (usually 1-3 minutes, up to 10)"
  for i in 0 1 2; do
    pod="$(broker_pod "$i")"
    if ! wait_pod_ready "$pod" 600; then
      log "Warning: $pod is not Ready yet; check: kubectl -n $NAMESPACE get pods"
    fi
  done
  kn wait --for=condition=Ready "kafka/$CLUSTER" --timeout=300s >/dev/null 2>&1 ||
    log "Warning: the Kafka resource is not Ready yet"
  for i in 0 1 2; do
    if pod_ready "$(broker_pod "$i")"; then
      survivor="$(broker_pod "$i")"
      break
    fi
  done
  if [[ -n "$survivor" ]]; then
    if [[ -n "$(describe_topic "$survivor")" ]]; then
      if wait_for_isr "$survivor" 3 300; then
        log "All partitions of $TOPIC are back to ISR 3:"
        describe_topic "$survivor" >&2
      else
        log "Warning: ISR is not back to 3 after 5 minutes:"
        describe_topic "$survivor" >&2
      fi
      kafka_exec "$survivor" "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 \
        --delete --topic "$TOPIC" >/dev/null 2>&1 && log "Deleted the test topic $TOPIC"
    fi
  fi
  kn get pods -l "strimzi.io/cluster=$CLUSTER" >&2
}

status() {
  local i pod
  section "Nodes"
  k get nodes >&2
  section "Kafka pods"
  kn get pods -l "strimzi.io/cluster=$CLUSTER" -o wide >&2
  for i in 0 1 2; do
    pod="$(broker_pod "$i")"
    if pod_ready "$pod"; then
      section "Topic $TOPIC (seen from $pod)"
      describe_topic "$pod" >&2
      return 0
    fi
  done
}

on_exit() {
  local rc=$?
  if "$RESTORE_ON_EXIT"; then
    RESTORE_ON_EXIT=false
    log ""
    log "Interrupted or failed (exit $rc); restoring the brokers."
    restore || log "Restore failed; run: $0 restore"
  fi
  exit "$rc"
}

run() {
  local survivor marker out errors read_back i answer
  survivor="$(broker_pod 0)"
  for i in 0 1 2; do
    if [[ "$i" != "$FIRST" && "$i" != "$SECOND" ]]; then
      survivor="$(broker_pod "$i")"
    fi
  done
  FAILURES=0

  section "Checking the cluster"
  k get nodes >/dev/null || die "kubectl cannot reach context $CONTEXT; run az aks get-credentials first"
  for i in 0 1 2; do
    pod_ready "$(broker_pod "$i")" || die "$(broker_pod "$i") is not Ready; start with a healthy cluster"
  done
  [[ -z "$(k get nodes -l "${NODE_LABEL}=true" -o name)" ]] ||
    die "nodes are still cordoned from an earlier run; run '$0 restore' first"
  log "Context   : $CONTEXT ($(k config view -o jsonpath="{.contexts[?(@.name==\"$CONTEXT\")].context.cluster}"))"
  log "Kafka     : $CLUSTER in $NAMESPACE, brokers 0, 1, 2"
  log "Plan      : stop broker $FIRST, then broker $SECOND; broker ${survivor##*-} stays up"
  log "Side effect: all nodes are cordoned during the test, so no new pods can start."
  log "             The app keeps running; Kafka is unavailable for writes in phase 2."
  if ! "$ASSUME_YES"; then
    read -r -p "Continue? [y/N] " answer </dev/tty
    [[ "$answer" == y || "$answer" == Y ]] || die "aborted; nothing was changed"
  fi

  section "Phase 0: all brokers up (about 1 min)"
  kafka_exec "$survivor" "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 --create --if-not-exists \
    --topic "$TOPIC" --partitions 3 --replication-factor 3 --config min.insync.replicas=2 >/dev/null
  wait_for_isr "$survivor" 3 120 || die "the test topic did not reach ISR 3"
  describe_topic "$survivor" >&2
  marker="phase0-$(date +%s)"
  out="$(produce "$survivor" "$marker")"
  errors="$(count_errors "$out")"
  read_back="$(consume_count "$survivor" "$marker")"
  if [[ "$errors" == 0 && "$read_back" == "$RECORDS" ]]; then
    pass "3 brokers: $RECORDS/$RECORDS records written with acks=all and read back"
  else
    fail_check "3 brokers: $errors send errors, $read_back/$RECORDS read back"
    error_reasons "$out" >&2
    die "the cluster is not healthy before the test; stopping"
  fi

  RESTORE_ON_EXIT=true
  section "Phase 1: one broker down (about 2-3 min)"
  cordon_nodes
  stop_broker "$FIRST"
  if wait_for_isr "$survivor" 2 120; then
    pass "ISR shrank to 2 for every partition"
  else
    fail_check "ISR did not shrink to 2 within 2 minutes"
  fi
  describe_topic "$survivor" >&2
  marker="phase1-$(date +%s)"
  out="$(produce "$survivor" "$marker")"
  errors="$(count_errors "$out")"
  read_back="$(consume_count "$survivor" "$marker")"
  if [[ "$errors" == 0 && "$read_back" == "$RECORDS" ]]; then
    pass "2 brokers: $RECORDS/$RECORDS records written with acks=all and read back (2 replicas >= min ISR 2)"
  else
    fail_check "2 brokers: expected all writes to succeed; $errors send errors, $read_back/$RECORDS read back"
    error_reasons "$out" >&2
  fi
  pause "Phase 1 done. Try the chat now: sending a message should still work."

  section "Phase 2: two brokers down (about 2-3 min)"
  stop_broker "$SECOND"
  sleep 10
  describe_topic "$survivor" >&2 || true
  marker="phase2-$(date +%s)"
  log "Producing $RECORDS records with acks=all; each should fail within about 30 seconds"
  out="$(produce "$survivor" "$marker")"
  errors="$(count_errors "$out")"
  if grep -q 'NotEnoughReplicas' <<<"$out"; then
    pass "1 broker: writes refused with NotEnoughReplicas (1 replica < min ISR 2)"
  elif [[ "$errors" -gt 0 ]]; then
    pass "1 broker: writes refused ($errors errors; see the reason below)"
    log "The controller quorum is lost too, so the ISR cannot shrink and writes time out"
    log "instead of failing with NotEnoughReplicas. Either way, acks=all writes are refused."
  else
    fail_check "1 broker: expected acks=all writes to fail, but no error was reported"
  fi
  error_reasons "$out" >&2
  pause "Phase 2 done. Try the chat now: sending a message should fail or hang."

  RESTORE_ON_EXIT=false
  restore

  section "Result"
  if ((FAILURES == 0)); then
    log "All checks passed."
  else
    log "$FAILURES check(s) failed; see the FAIL lines above."
    exit 1
  fi
}

while (($#)); do
  case "$1" in
    run | restore | status) COMMAND="$1" ;;
    --first) FIRST="${2:?--first needs a value}"; shift ;;
    --second) SECOND="${2:?--second needs a value}"; shift ;;
    --no-pause) PAUSE=false ;;
    --yes) ASSUME_YES=true ;;
    --context) CONTEXT="${2:?--context needs a value}"; shift ;;
    --namespace) NAMESPACE="${2:?--namespace needs a value}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

[[ -n "$COMMAND" ]] || { usage >&2; exit 1; }
[[ "$FIRST" =~ ^[012]$ && "$SECOND" =~ ^[012]$ && "$FIRST" != "$SECOND" ]] ||
  die "--first and --second must be two different values of 0, 1 and 2"
command -v kubectl >/dev/null || die "kubectl is required"

trap on_exit EXIT
trap 'exit 130' INT TERM

case "$COMMAND" in
  run) run ;;
  restore) restore ;;
  status) status ;;
esac
