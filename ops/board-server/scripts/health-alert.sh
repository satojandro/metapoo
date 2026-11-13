#!/usr/bin/env bash
# Is the board server healthy? Run every few minutes by deploy/systemd/board-alert.timer
# (DEPLOY-HETZNER.md, "Alerts"). Prints every problem, exits 1 if there is one, and sends a
# message when the set of problems changes, when it clears, and every ALERT_REMIND_HOURS while
# it lasts: not every run. The message text is what is compared, so it holds no number that
# changes from run to run except the memory percentage; details go to the log.
#
# Checks: /api/health (status, queue), the public HTTPS URL if set, Valkey memory against
# maxmemory, AOF and snapshot status, disk space, the age of the newest backup.
#
# Where the message goes (ops.env; any or none of them):
#   ALERT_NTFY_URL            https://ntfy.sh/<a-long-random-topic>   (free, no account)
#   ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID                 (Telegram's Bot API)
#   ALERT_CMD                 any command; the message is its last argument
# With none set it only logs, which `journalctl -u board-alert` shows.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here" || exit 1
# shellcheck disable=SC1090,SC1091
[ -f "${BOARD_OPS_ENV:-$here/ops.env}" ] && . "${BOARD_OPS_ENV:-$here/ops.env}"

ALERT_HEALTH_URL="${ALERT_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
ALERT_PUBLIC_URL="${ALERT_PUBLIC_URL:-}"
ALERT_MEMORY_PCT="${ALERT_MEMORY_PCT:-70}"
ALERT_DISK_PCT="${ALERT_DISK_PCT:-80}"
ALERT_QUEUE_MAX="${ALERT_QUEUE_MAX:-500}"
ALERT_BACKUP_MAX_AGE_H="${ALERT_BACKUP_MAX_AGE_H:-36}" # 0 = do not check
ALERT_REMIND_HOURS="${ALERT_REMIND_HOURS:-6}"
ALERT_NAME="${ALERT_NAME:-board server $(hostname)}"
BACKUP_DIR="${BACKUP_DIR:-$here/backups}"
STATE_DIR="${ALERT_STATE_DIR:-$here/.alert-state}"

problems=()
problem() { problems+=("$1"); }

# --- the server -------------------------------------------------------------------------
if body="$(curl -fsS --max-time 10 "$ALERT_HEALTH_URL" 2>&1)"; then
  status="$(jq -r '.status // "missing"' <<<"$body" 2>/dev/null || echo unreadable)"
  queue="$(jq -r '.queue_length // 0' <<<"$body" 2>/dev/null || echo 0)"
  failures="$(jq -r '.consumer_failures // 0' <<<"$body" 2>/dev/null || echo 0)"
  # ok / degraded (an apply is failing and being retried) / stalled (the consumer is gone).
  [ "$status" = "ok" ] || { echo "detail: consumer_failures $failures" >&2; problem "health status is \"$status\""; }
  # A long queue with status ok means events arrive faster than they apply, or do not apply.
  [ "$queue" -le "$ALERT_QUEUE_MAX" ] 2>/dev/null || { echo "detail: queue_length $queue" >&2; problem "queue_length is over $ALERT_QUEUE_MAX"; }
else
  echo "detail: $body" >&2
  problem "the server does not answer at $ALERT_HEALTH_URL"
fi

if [ -n "$ALERT_PUBLIC_URL" ]; then
  out="$(curl -fsS --max-time 15 -o /dev/null "$ALERT_PUBLIC_URL" 2>&1)" || {
    echo "detail: $out" >&2
    problem "the public URL $ALERT_PUBLIC_URL fails (Caddy, DNS, certificate or firewall)"
  }
fi

# --- Valkey -----------------------------------------------------------------------------
if info="$(docker compose exec -T valkey valkey-cli INFO 2>&1 | tr -d '\r')" && grep -q '^used_memory:' <<<"$info"; then
  field() { awk -F: -v k="$1" '$1 == k { print $2 }' <<<"$info"; }
  used="$(field used_memory)"
  max="$(field maxmemory)"
  if [ "${max:-0}" -gt 0 ]; then
    pct=$((used * 100 / max))
    [ "$pct" -lt "$ALERT_MEMORY_PCT" ] ||
      problem "Valkey memory is at ${pct}% of maxmemory ($(field used_memory_human) of $(field maxmemory_human)): at 100% writes are refused and the mirror stops. Raise maxmemory or move to a bigger box"
  else
    problem "Valkey has no maxmemory: it is not running valkey.prod.conf (COMPOSE_FILE in .env?)"
  fi
  [ "$(field aof_enabled)" = "1" ] || problem "AOF is off: a crash can lose up to a minute (valkey.prod.conf not loaded?)"
  [ "$(field aof_last_write_status)" = "ok" ] || problem "Valkey cannot write the AOF (disk?)"
  [ "$(field aof_last_bgrewrite_status)" = "ok" ] || problem "the last AOF rewrite failed"
  [ "$(field rdb_last_bgsave_status)" = "ok" ] || problem "the last RDB snapshot failed (disk full, or no memory to fork?)"
else
  problem "Valkey does not answer"
fi

# --- disk and backups -------------------------------------------------------------------
disk="$(df --output=pcent "$here" 2>/dev/null | tail -1 | tr -dc '0-9')"
[ "${disk:-0}" -lt "$ALERT_DISK_PCT" ] || problem "disk is ${disk}% full"

if [ "$ALERT_BACKUP_MAX_AGE_H" -gt 0 ]; then
  newest="$(find "$BACKUP_DIR" -name 'board-valkey-*.rdb.gz' -mmin -"$((ALERT_BACKUP_MAX_AGE_H * 60))" 2>/dev/null | head -1)"
  [ -n "$newest" ] || problem "no backup newer than ${ALERT_BACKUP_MAX_AGE_H} h in $BACKUP_DIR"
fi

# --- tell someone, once per change --------------------------------------------------------
notify() {
  local text="$1" sent=0
  if [ -n "${ALERT_NTFY_URL:-}" ]; then
    curl -fsS --max-time 15 -H "Title: $ALERT_NAME" -d "$text" "$ALERT_NTFY_URL" >/dev/null && sent=1
  fi
  if [ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]; then
    curl -fsS --max-time 15 "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${ALERT_NAME}: ${text}" >/dev/null && sent=1
  fi
  if [ -n "${ALERT_CMD:-}" ]; then
    # shellcheck disable=SC2086
    $ALERT_CMD "$ALERT_NAME: $text" && sent=1
  fi
  [ "$sent" = 1 ]
}

mkdir -p "$STATE_DIR"
last_file="$STATE_DIR/last"
now="$(date +%s)"
current="$(printf '%s\n' "${problems[@]:-}")"
previous=""
previous_at=0
if [ -f "$last_file" ]; then
  previous_at="$(head -1 "$last_file")"
  previous="$(tail -n +2 "$last_file")"
fi

if [ "${#problems[@]}" -eq 0 ]; then
  if [ -n "$previous" ]; then
    notify "recovered. Was: $previous" || echo "alert: could not send the recovery message" >&2
  fi
  printf '%s\n' "$now" >"$last_file"
  # A dead box sends nothing, so optionally tell an outside watcher that this run was fine
  # (for example a free healthchecks.io check, which alerts when the pings stop).
  if [ -n "${ALERT_HEARTBEAT_URL:-}" ]; then
    curl -fsS --max-time 10 -o /dev/null "$ALERT_HEARTBEAT_URL" || true
  fi
  echo "ok"
  exit 0
fi

printf 'PROBLEM: %s\n' "${problems[@]}" >&2
if [ "$current" != "$previous" ] || [ $((now - previous_at)) -ge $((ALERT_REMIND_HOURS * 3600)) ]; then
  if notify "$current"; then
    printf '%s\n%s\n' "$now" "$current" >"$last_file"
  else
    # Not recorded, so the next run tries again.
    echo "alert: no notification path is set, or sending failed" >&2
  fi
fi
exit 1
