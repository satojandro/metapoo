#!/usr/bin/env bash
# Nightly copy of the Valkey data (DEPLOY-HETZNER.md, "Backups").
#
# One RDB snapshot is the whole dataset at a single instant: the board, draw_history, the
# owner-id map, the counters, last_processed_block and last_applied_position together. That is
# what makes a restore consistent: the indexer resumes from the watermark that is in the same
# file. The AOF directory is not copied: its files change under a running server.
#
# Steps: BGSAVE, wait for it to finish, check the file, stream it out of the container
# (Valkey writes it 0600 as its own user), gzip it into BACKUP_DIR, prune, then send it off
# the box if a destination is set in ops.env. Exit 0 only if every step that was asked for
# worked.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
# shellcheck disable=SC1090,SC1091
[ -f "${BOARD_OPS_ENV:-$here/ops.env}" ] && . "${BOARD_OPS_ENV:-$here/ops.env}"

BACKUP_DIR="${BACKUP_DIR:-$here/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
BACKUP_UPLOAD_CMD="${BACKUP_UPLOAD_CMD:-}"
BGSAVE_TIMEOUT_S="${BGSAVE_TIMEOUT_S:-300}"

cli() { docker compose exec -T valkey valkey-cli "$@" | tr -d '\r'; }
info() { cli INFO persistence | awk -F: -v k="$1" '$1 == k { print $2 }'; }

umask 077
mkdir -p "$BACKUP_DIR"

before="$(cli LASTSAVE)"
# A snapshot may already be running (the `save 60 1` schedule): then wait for that one.
cli BGSAVE >/dev/null || true
waited=0
while :; do
  if [ "$(info rdb_bgsave_in_progress)" = "0" ] && [ "$(cli LASTSAVE)" != "$before" ]; then
    break
  fi
  if [ "$waited" -ge "$BGSAVE_TIMEOUT_S" ]; then
    echo "backup: BGSAVE did not finish in ${BGSAVE_TIMEOUT_S}s" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
  # LASTSAVE has one-second resolution: a snapshot in the same second as `before` needs asking again.
  [ "$waited" = 2 ] && { cli BGSAVE >/dev/null || true; }
done
if [ "$(info rdb_last_bgsave_status)" != "ok" ]; then
  echo "backup: the last BGSAVE failed (rdb_last_bgsave_status)" >&2
  exit 1
fi
docker compose exec -T valkey valkey-check-rdb /data/dump.rdb >/dev/null

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/board-valkey-$stamp.rdb.gz"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT
docker compose exec -T valkey cat /data/dump.rdb | gzip -c >"$tmp"
gzip -t "$tmp"
# Every RDB file starts with "REDIS" (Valkey 8 keeps the magic).
magic="$(gzip -dc "$tmp" 2>/dev/null | head -c 5 || true)"
if [ "$magic" != "REDIS" ]; then
  echo "backup: the copy is not an RDB file" >&2
  exit 1
fi
mv "$tmp" "$out"
trap - EXIT
keys="$(cli DBSIZE)"
echo "backup: $out ($(du -h "$out" | cut -f1), $keys keys, draw_history $(cli XLEN draw_history) entries)"

# Keep the newest BACKUP_KEEP.
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/board-valkey-*.rdb.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
  rm -f "$old"
done

if [ -n "$BACKUP_RCLONE_REMOTE" ]; then
  rclone copy "$out" "$BACKUP_RCLONE_REMOTE"
  echo "backup: copied to $BACKUP_RCLONE_REMOTE"
elif [ -n "$BACKUP_UPLOAD_CMD" ]; then
  # The command gets the file path as its last argument.
  # shellcheck disable=SC2086
  $BACKUP_UPLOAD_CMD "$out"
  echo "backup: handed to BACKUP_UPLOAD_CMD"
else
  echo "backup: kept on this box only (set BACKUP_RCLONE_REMOTE or BACKUP_UPLOAD_CMD in ops.env, or pull $BACKUP_DIR from another machine)" >&2
fi
