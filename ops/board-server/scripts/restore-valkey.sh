#!/usr/bin/env bash
# Restore the Valkey data from a backup made by backup-valkey.sh (DEPLOY-HETZNER.md,
# "Restore"). Also the way to bring a dump.rdb over from another machine.
#
#   scripts/restore-valkey.sh backups/board-valkey-<stamp>.rdb.gz --yes
#
# Why it is more than "copy the file back": with `appendonly yes`, Valkey loads the AOF and
# ignores dump.rdb. Started on a data dir that holds only dump.rdb it comes up EMPTY, writes
# an empty AOF, and the next snapshot overwrites the RDB (checked on Valkey 8.1). So this
# script loads the RDB with AOF off, turns AOF on at runtime (Valkey then writes the AOF from
# what is in memory), waits for that rewrite, and only then starts the normal stack.
#
# The current data dir is moved aside, never deleted.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

src="${1:-}"
if [ -z "$src" ] || [ ! -f "$src" ] || [ "${2:-}" != "--yes" ]; then
  echo "usage: $0 <backup.rdb.gz | dump.rdb> --yes" >&2
  echo "Stops every service except caddy, replaces valkey-data (the old one is kept beside it), starts again." >&2
  exit 2
fi
src="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"

cli() { docker compose exec -T valkey valkey-cli "$@" | tr -d '\r'; }
info() { cli INFO persistence | awk -F: -v k="$1" '$1 == k { print $2 }'; }
wait_for_valkey() {
  for _ in $(seq 1 60); do
    if [ "$(cli PING 2>/dev/null || true)" = "PONG" ] && [ "$(info loading)" = "0" ]; then return 0; fi
    sleep 1
  done
  echo "restore: Valkey did not come up" >&2
  return 1
}

new="$here/valkey-data.restoring"
rm -rf "$new"
mkdir "$new"
case "$src" in
  *.gz) gzip -dc "$src" >"$new/dump.rdb" ;;
  *) cp "$src" "$new/dump.rdb" ;;
esac
if [ "$(head -c 5 "$new/dump.rdb")" != "REDIS" ]; then
  echo "restore: $src is not an RDB file; nothing changed" >&2
  rm -rf "$new"
  exit 1
fi

# Everything that talks to Valkey stops (the bot too); caddy stays and answers 502 meanwhile,
# which the wall treats as "no server" and reads the chain.
mapfile -t services < <(docker compose config --services | grep -v '^caddy$')
docker compose stop "${services[@]}"
docker compose rm -f valkey >/dev/null

if [ -d "$here/valkey-data" ]; then
  aside="$here/valkey-data.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$here/valkey-data" "$aside"
  echo "restore: the previous data is in $aside"
fi
mv "$new" "$here/valkey-data"

# 1. Load the RDB with AOF off. `--appendonly no` after the config file overrides it.
conf="$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["valkey"]["command"][-1])')"
docker compose run -d --rm --name board-valkey-restore valkey valkey-server "$conf" --appendonly no >/dev/null
rcli() { docker exec board-valkey-restore valkey-cli "$@" | tr -d '\r'; }
rinfo() { rcli INFO persistence | awk -F: -v k="$1" '$1 == k { print $2 }'; }
for _ in $(seq 1 120); do
  if [ "$(rcli PING 2>/dev/null || true)" = "PONG" ] && [ "$(rinfo loading)" = "0" ]; then break; fi
  sleep 1
done
keys="$(rcli DBSIZE)"
if [ "${keys:-0}" = "0" ]; then
  docker stop board-valkey-restore >/dev/null || true
  echo "restore: the RDB loaded no keys; stack left stopped, previous data is beside valkey-data" >&2
  exit 1
fi

# 2. If production uses AOF, build it from memory now.
if grep -qs '^appendonly yes' "$here/$(basename "$conf")"; then
  rcli CONFIG SET appendonly yes >/dev/null
  for _ in $(seq 1 600); do
    if [ "$(rinfo aof_enabled)" = "1" ] && [ "$(rinfo aof_rewrite_in_progress)" = "0" ]; then break; fi
    sleep 1
  done
  if [ "$(rinfo aof_enabled)" != "1" ] || [ "$(rinfo aof_last_bgrewrite_status)" != "ok" ]; then
    docker stop board-valkey-restore >/dev/null || true
    echo "restore: the AOF rewrite did not finish; stack left stopped" >&2
    exit 1
  fi
fi
# SIGTERM: Valkey saves and exits; --rm removes the container.
docker stop -t 120 board-valkey-restore >/dev/null

# 3. The normal stack. The indexer resumes from the last_processed_block in the backup and
#    re-reads everything after it from the transaction index.
docker compose up -d
wait_for_valkey
after="$(cli DBSIZE)"
echo "restore: $after keys (the backup held $keys), draw_history $(cli XLEN draw_history) entries, last_processed_block $(cli GET last_processed_block)"
if [ "$after" -lt "$keys" ]; then
  echo "restore: fewer keys than the backup held. Stop and look before trusting it." >&2
  exit 1
fi
echo "restore: now run   docker compose run --rm indexer board-history check"
