# Board server on its own Hetzner box — runbook

BOARD-HOST, return-and-growth spec §1.5 (owner decision, 13 Nov): the board server moves off
the Mac mini and its ephemeral tunnel onto a **new, separate, small Hetzner VPS**. Not Vercel
(the server is stateful and long-lived) and not the validator box.

Everything is copy-pasteable once two things exist. Replace the placeholders throughout:

| placeholder | what | who |
|---|---|---|
| `<SERVER_IP>` | the new VPS's IPv4 address | owner creates the VPS |
| `<board.example.com>` | a subdomain for the board server | owner picks it, adds DNS |
| `<repo-url>` | this repository's clone URL | — |

The order matters in two places, both marked **ORDER**: Valkey's AOF setting before the first
start, and the Vercel variable only after the new box has proved itself.

Contents: [1 Create the box](#1-create-the-box) · [2 Users and SSH](#2-users-and-ssh) ·
[3 Docker](#3-docker) · [4 Firewall](#4-firewall) · [5 DNS](#5-dns) ·
[6 Code and .env](#6-code-and-env) · [7 Valkey, before the first start](#7-valkey-before-the-first-start) ·
[8 Start and catch up](#8-start-and-catch-up) · [9 Backfill and check](#9-backfill-and-check) ·
[10 Check it from outside](#10-check-it-from-outside) · [11 Alerts and backups](#11-alerts-and-backups) ·
[12 Cut over](#12-cut-over) · [13 Healthy, or not](#13-healthy-or-not) ·
[14 Update and roll back](#14-update-and-roll-back) · [15 Backups and restore](#15-backups-and-restore) ·
[16 How big it gets](#16-how-big-it-gets) · [17 Why a fresh rebuild, not the Mini's data](#17-why-a-fresh-rebuild-not-the-minis-data) ·
[18 What was tested](#18-what-was-tested)

## What is in the stack

```
internet ── 80/443 ──► caddy ──► server:3000 ──► valkey ◄── indexer ──► FastNEAR tx index
                       (TLS)     (HTTP + /ws)     (AOF)
```

| file | what |
|---|---|
| `docker-compose.yml` | Valkey, indexer, server. Its services are unchanged; local and Mini use it alone |
| `docker-compose.prod.yml` | overlay for this box: adds Caddy, switches Valkey to `valkey.prod.conf` |
| `Caddyfile` | HTTPS for `BOARD_HOSTNAME`, everything proxied to the server, blobs compressed |
| `valkey.prod.conf` | `appendonly yes`, `maxmemory 1gb`, `noeviction` (includes `valkey.conf`) |
| `scripts/backup-valkey.sh`, `scripts/restore-valkey.sh` | nightly copy, and the way back |
| `scripts/health-alert.sh` | health, memory, disk and backup-age check that sends a message |
| `deploy/systemd/` | timers for the two scripts |
| `ops.env.example` | settings for the scripts (alert destination, backup destination) |

An overlay rather than one compose file: a Caddy service in `docker-compose.yml` would try to
bind 80/443 and fetch a certificate on every laptop and on the Mini, and production Valkey
limits do not belong on a dev machine. With `COMPOSE_FILE` set in `.env` (step 6) every
`docker compose …` command on the box uses both files with no `-f` flags.

## 1 Create the box

Hetzner Cloud console → new project → **Add server**:

- Location: any EU one. Image: **Ubuntu 24.04**.
- Type: the smallest shared-CPU type with **4 GB RAM** (CX22 or its current successor, about
  €4–6/month; the ARM CAX11 works too, the images and the Rust build are native on both).
  `valkey.prod.conf` assumes 4 GB; on a 2 GB type set `maxmemory 512mb` in it and add swap
  before the first image build.
- SSH key: add your public key. No password login.
- Backups: tick it if you choose option A in [section 15](#15-backups-and-restore).

**Cloud firewall** (console → Firewalls → Create, then apply it to the server). Inbound rules,
source "any IPv4 + any IPv6":

| protocol | port | for |
|---|---|---|
| TCP | 22 | SSH (narrow the source to your own IP if it is fixed) |
| TCP | 80 | ACME challenge, redirect to HTTPS |
| TCP | 443 | the API and the WebSocket |

Nothing else. Outbound stays open. This firewall sits outside the box, so it holds even when
Docker rewrites the box's own rules (see step 4).

With the `hcloud` CLI instead:

```bash
hcloud firewall create --name board-server
for port in 22 80 443; do
  hcloud firewall add-rule board-server --direction in --protocol tcp --port "$port" \
    --source-ips 0.0.0.0/0 --source-ips ::/0
done
hcloud firewall apply-to-resource board-server --type server --server <server-name>
```

## 2 Users and SSH

As root, once (`ssh root@<SERVER_IP>`):

```bash
apt-get update && apt-get -y upgrade
apt-get -y install ufw jq curl git unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades     # security updates by themselves

adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-deploy && chmod 440 /etc/sudoers.d/90-deploy

# Keys only, no root. The 00- prefix matters: sshd takes the first value it reads.
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sshd -t && systemctl reload ssh
```

**Keep the root session open** and prove the new login in a second terminal before closing it:

```bash
ssh deploy@<SERVER_IP> 'sudo -n true && echo sudo-ok'
ssh root@<SERVER_IP>            # must now be refused
```

The systemd units in `deploy/systemd/` assume the user `deploy` and the checkout at
`/home/deploy/metapoo`. Use other names and you edit two lines in each `.service` file.

Everything from here is as `deploy`.

## 3 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh          # Docker Engine + the compose plugin
sudo usermod -aG docker deploy                       # then log out and in again
# Bound the container logs (the indexer logs every poll):
echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
docker compose version && docker run --rm hello-world
```

Membership of the `docker` group is root on this box. That is acceptable here because the box
does one job and `deploy` already has sudo; it is one more reason the validator is elsewhere.

## 4 Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

**ufw does not protect ports that Docker publishes.** Docker writes its own iptables rules
ahead of ufw's, so a container port published as `"3000:3000"` is reachable from the internet
whatever `ufw status` says. What keeps this stack private is the compose files, checked
against them and on a running stack:

| service | published as | reachable from |
|---|---|---|
| caddy | `80:80`, `443:443` | the internet (intended) |
| server | `127.0.0.1:3000:3000` | this box only |
| valkey | not published | the compose network only |
| indexer | not published | nothing connects to it |

So: never change the server's mapping to `3000:3000`, never add `ports:` to valkey (it has no
password), and treat the **Hetzner cloud firewall from step 1 as the real guard**. Step 8 has
the command that proves what is listening.

## 5 DNS

At the DNS provider for the domain: an **A record** `<board.example.com>` → `<SERVER_IP>`
(and an AAAA record for the box's IPv6 if you want it). If the DNS is on Cloudflare, set the
record to **DNS only** (grey cloud): Caddy gets its own certificate, and a second proxy in
front would need its own WebSocket and caching decisions.

```bash
dig +short <board.example.com>      # must print <SERVER_IP> before step 8
```

## 6 Code and .env

```bash
git clone <repo-url> ~/metapoo        # a private repo needs a read-only deploy key on the box
cd ~/metapoo/ops/board-server
cp .env.example .env && chmod 600 .env
nano .env
```

In `.env`:

```bash
BOARD_HOSTNAME=<board.example.com>
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
FASTNEAR_API_KEY=<key>          # see below
INDEX_MODE=txindex              # confirm: `stream` reads every block, ~6,200 requests an hour for ever
```

and confirm, do not assume:

- `CONTRACT_ID` is the board the production wall paints on (the same id as the wall's
  contract variable in Vercel). `.env.example` carries the mainnet testing board.
- `START_BLOCK_HEIGHT` is that board's deploy block and `INITIAL_SIDE` its side at deploy.
  A fresh box rebuilds the whole wall from these two; a wrong one gives a wrong wall.
- `FASTNEAR_API_KEY` is set. The anonymous transaction index answered HTTP 429 after a day
  of testing (backlog, BOARD-SERVER-DEPLOY (c)). Copy the value the Mini uses.

`.env` is gitignored and never leaves the box. Keep a copy of it in your password manager:
it is not in the Valkey backups.

```bash
docker compose config --services      # must list: valkey indexer server caddy
```

## 7 Valkey, before the first start

**ORDER: AOF must be on before Valkey first starts on this data dir.** It is, as long as the
overlay is in effect, so check that and that the data dir is new:

```bash
docker compose config | grep valkey.prod.conf     # two lines: the mount and the command
ls valkey-data 2>/dev/null                        # must print nothing
```

Why the order matters (checked on Valkey 8.1): with `appendonly yes` Valkey loads the AOF and
**ignores `dump.rdb`**. Started with AOF on over a data dir that holds only an RDB, it comes up
**empty**, writes an empty AOF, and the next snapshot overwrites the RDB. A fresh dir has
neither file, so starting with AOF on is simply correct. Bringing an RDB in from elsewhere
(a backup, the Mini) is what `scripts/restore-valkey.sh` is for: it loads the RDB with AOF off
and turns AOF on at runtime. Never copy a `dump.rdb` into `valkey-data/` by hand.

What `valkey.prod.conf` sets, and why:

- `appendonly yes`, `appendfsync everysec`: a crash loses at most about a second of board,
  draw log and `last_processed_block` **together** (they are written in one transaction), and
  the indexer re-reads that second from the chain. RDB snapshots stay on as well; `dump.rdb`
  is what the backup copies.
- `maxmemory 1gb`: a quarter of a 4 GB box. The rest is for the fork that snapshots and AOF
  rewrites make, the two Rust services, Caddy, and an image build during an update.
- `maxmemory-policy noeviction`: every key is the board, the durable log, a counter the
  board depends on, or a watermark. Any evicting policy would silently delete one of them
  (`allkeys-*` could drop the board itself; `volatile-*` would drop the `covers:*` sets, the
  only keys with a TTL). With `noeviction` a full store **refuses writes**: the consumer
  retries, `/api/health` turns `degraded`, the wall falls back to reading the chain, nothing
  is lost, and raising the limit resumes it. The alert in step 11 fires at 70 %, long before.

## 8 Start and catch up

```bash
docker compose up -d --build          # the first build compiles Rust: 10–20 minutes on 2 vCPUs
docker compose ps                     # four services, all "Up"
sudo ss -ltnp | grep -E ':(80|443|3000|6379)\s'
```

The last command must show `0.0.0.0:80`, `0.0.0.0:443`, **`127.0.0.1:3000`**, and no line for
6379.

```bash
docker compose exec valkey valkey-cli CONFIG GET appendonly          # yes
docker compose exec valkey valkey-cli CONFIG GET maxmemory           # 1073741824
docker compose exec valkey valkey-cli CONFIG GET maxmemory-policy    # noeviction
docker compose logs caddy | grep -i 'certificate obtained'           # within a minute of DNS being right
```

**The indexer does not read the chain until someone watches or a paint hint arrives.** A new
box has neither, so its mirror stays empty until you ask:

```bash
curl -s -X POST http://127.0.0.1:3000/api/hint -o /dev/null -w '%{http_code}\n'    # 202
docker compose logs -f indexer        # "queued N board events through block …", then Ctrl-C
curl -s http://127.0.0.1:3000/api/health | jq
```

Healthy and caught up is: `status` `ok`, `queue_length` `0`, `painted_tiles` equal to the
Mini's (`curl -s <the Mini's URL>/api/health | jq .painted_tiles`), and `last_processed_block`
within a few hundred blocks of the chain at the moment of the hint:

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"status","params":[]}' | jq .result.sync_info.latest_block_height
```

`last_processed_block` then stands still while nobody watches. That is the design (0 requests
with no viewer), not a fault; another hint moves it.

## 9 Backfill and check

The commands, exactly as the binary takes them (`board-history` has two subcommands and no
flags; settings come from `.env`):

```bash
docker compose run --rm indexer board-history backfill
docker compose run --rm indexer board-history check; echo "exit $?"
```

On a box built fresh by this runbook the consumer has already written the whole log from the
first paint, so the backfill replays the history (about 20 index requests), finds the log
equal, rewrites nothing, and writes the genesis marker. That marker is what the timelapse
needs. Expected, with your own numbers:

```
replayed … events into … entries and … board expansions; log already equal, not rewritten; …
log: … entries and … board expansions, blocks Some(…)..Some(…); mirror tip position Some(…)
start: certified from the deploy block <START_BLOCK_HEIGHT> (side <INITIAL_SIDE>) by the backfill
tip check: the log's tile state equals the stored board
```

Pass means all three of:

1. both commands exit 0;
2. `check` prints `start: certified …` and an entry count above 0. **Exit 0 alone is not
   enough: `check` also exits 0 on an empty mirror**, where an empty log equals an empty
   board;
3. `curl -s http://127.0.0.1:3000/api/history/head | jq .complete` prints `true`.

If the backfill says `the mirror has applied nothing yet`, step 8 has not caught up: send the
hint again. If it says the replay disagrees with the live log, it has written nothing; stop
and read [section 13](#13-healthy-or-not).

Then the strongest check there is, the mirror against the chain tile for tile (README,
"Check"; needs `python3`, which Ubuntu has):

```bash
docker compose stop indexer
BLOCK=$(curl -s http://127.0.0.1:3000/api/health | jq .last_processed_block)
scripts/replay-check.py http://127.0.0.1:3000 "$(grep '^CONTRACT_ID=' .env | cut -d= -f2)" "$BLOCK"; echo "exit $?"
docker compose start indexer
```

Exit 0 is identical. Exit 2 means the mirror moved past `$BLOCK` while it ran; repeat.

## 10 Check it from outside

From your own machine, not the box:

```bash
curl -s https://<board.example.com>/api/health | jq .status                  # "ok"
curl -sI http://<board.example.com>/api/health | head -1                     # 308 to https
curl -s -o /dev/null -w '%{size_download} bytes, %{http_code}\n' -H 'Accept-Encoding: gzip' \
  https://<board.example.com>/api/region/0/0                                 # far below 98304, 200
# The WebSocket through Caddy: the first line must be "HTTP/1.1 101 Switching Protocols".
curl -s --http1.1 --max-time 3 -o /dev/null -D - https://<board.example.com>/ws \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1
nc -zv -w 3 <SERVER_IP> 3000; nc -zv -w 3 <SERVER_IP> 6379                   # both must fail
```

Then the real client, before production sees it. In a checkout on your machine:

```bash
cd web && VITE_BOARD_SERVER_URL=https://<board.example.com> npm run dev
```

Open the wall: the tiles load, the network tab shows `/api/region/0/0` and a `/ws` socket on
the new host, and `/timelapse` plays from the first paint. The server answers any origin
(`CorsLayer::permissive`, `Access-Control-Allow-Origin: *`), so localhost, Vercel previews and
production all work with no allow-list to maintain. The data is public and the one write,
`POST /api/hint`, carries no data and is accepted at most once per 2 s.

## 11 Alerts and backups

```bash
cd ~/metapoo/ops/board-server
cp ops.env.example ops.env && chmod 600 ops.env && nano ops.env
```

Set **one alert destination** and the public URL:

```bash
ALERT_NTFY_URL=https://ntfy.sh/<a-long-random-topic>     # free, no account; subscribe in the ntfy app
ALERT_PUBLIC_URL=https://<board.example.com>/api/health
```

ntfy needs no new paid service and no account: the topic name is the secret, so make it long
and random. To use Telegram instead (or as well), set `ALERT_TELEGRAM_BOT_TOKEN` and
`ALERT_TELEGRAM_CHAT_ID`; once the AWAY-B bot exists its token works here, with your own chat
id. Anything else goes through `ALERT_CMD`.

```bash
scripts/backup-valkey.sh                       # the first backup (it says "kept on this box only" until section 15)
scripts/health-alert.sh; echo "exit $?"        # "ok", exit 0
sudo cp deploy/systemd/board-*.service deploy/systemd/board-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now board-alert.timer board-backup.timer
systemctl list-timers 'board-*'
```

Prove the alert reaches you, once: `docker compose stop server`, wait for the next run (or run
`sudo systemctl start board-alert`), get the message, `docker compose start server`, get
"recovered".

What it checks every 5 minutes, and sends once per change (then every 6 h while it lasts):

| check | fires when |
|---|---|
| `/api/health` | `status` is not `ok`, or the server does not answer |
| queue | `queue_length` over 500 |
| public URL | HTTPS fails from the box (Caddy, certificate, DNS) |
| **Valkey memory** | `used_memory` ≥ **70 %** of `maxmemory`; also if no `maxmemory` is set |
| persistence | AOF off, AOF write or rewrite failed, last snapshot failed |
| disk | ≥ 80 % full |
| backup age | no backup newer than 36 h |

A box that is down sends nothing. For that, either add a free external check on
`https://<board.example.com>/api/health` (UptimeRobot or similar), or set `ALERT_HEARTBEAT_URL`
to a free healthchecks.io check, which alerts when the script's pings stop.

Choose where backups go off the box in [section 15](#15-backups-and-restore).

## 12 Cut over

**ORDER: the wall stays live because the new box is proven first and the old one is retired
last.** Do not touch Vercel until every line here is true:

- [ ] step 8: `status ok`, `queue_length 0`, `painted_tiles` equals the Mini's
- [ ] step 9: backfill and check exit 0, start certified, `complete: true`, `replay-check.py` exit 0
- [ ] step 10: HTTPS, the 101 on `/ws`, and a local wall running against the new host
- [ ] step 11: an alert has reached your phone and one backup exists

Then:

1. **CSP.** `web/vercel.json` sends `Content-Security-Policy-Report-Only`, and its
   `connect-src` does not list the board server (it does not list today's tunnel either). It is
   report-only, so **nothing is blocked today**; the browser only logs a violation for each
   request to the board server. Add the two origins now anyway, in a normal web PR, so the
   reports are clean and the day the header becomes enforcing does not cut the wall off:
   `https://<board.example.com> wss://<board.example.com>` appended to `connect-src`. Both are
   needed: the existing entries list `wss://` hosts separately too. This runbook does not edit
   that file, because the hostname is not chosen yet.
2. **Vercel.** Project → Settings → Environment Variables → `VITE_BOARD_SERVER_URL` =
   `https://<board.example.com>` for Production (no path; a trailing slash is stripped).
   Vite bakes the value in at build time, so **redeploy** production: the variable does
   nothing until a new build.
3. **Verify production.** Open the live wall in a private window: `/api/region/0/0` and
   `/ws` go to `<board.example.com>`. Paint one tile from one browser and watch it appear in a
   second (this is also the still-open §7.2 check). On the box, `docker compose logs indexer`
   shows the hint poll and `queued 1 board events`.
4. **Leave the Mini running for a day.** Browsers holding the old bundle still talk to the
   tunnel until they reload; when the tunnel goes they fall back to reading the chain, which
   is the same thing that happens whenever a board server is unreachable.
5. **Retire the Mini's side.** Stop the three things the backlog names there: `board-tunnel`
   (the Cloudflare quick tunnel), `board-indexer` and `board-server`, and its Valkey, however
   they are run on that machine, and remove whatever starts them at login. Keep the Mini's
   Valkey data dir for a week, then delete it. Remove the Mini's copy of `FASTNEAR_API_KEY`
   if it is not used for anything else there.

**Rolling the cut-over back** is one variable: set `VITE_BOARD_SERVER_URL` back to the tunnel
URL while the tunnel is still up, or **clear it**, and redeploy. With it empty the wall reads
the chain directly, as it did before 7 Nov. That works with no server at all, so it is always
available.

## 13 Healthy, or not

Healthy is all of:

```bash
curl -s http://127.0.0.1:3000/api/health | jq        # status ok, queue_length 0, consumer_failures 0
docker compose ps                                    # four services Up, no "Restarting"
scripts/health-alert.sh                              # ok
docker compose exec valkey valkey-cli INFO memory | grep -E '^(used_memory_human|maxmemory_human)'
```

`last_processed_block` being old is **not** a fault when nobody has had the wall open: the
indexer only polls for a viewer or a hint.

| symptom | likely cause | do |
|---|---|---|
| `status: degraded`, `consumer_failures` climbing | Valkey refuses writes or is unreachable | `docker compose logs --tail 50 server valkey`. `OOM command not allowed` → memory row below. Otherwise `docker compose restart valkey`; the consumer reconnects by itself |
| `status: stalled` | the consumer task has not ticked for a minute | `docker compose restart server`. Nothing is lost: a half-applied event goes back to the queue on start |
| server does not answer on :3000 | container down or restarting | `docker compose ps`, `docker compose logs --tail 100 server`, `docker compose up -d` |
| public URL fails, local health is fine | Caddy, certificate, DNS, or a firewall | `docker compose logs --tail 100 caddy`; `dig +short <board.example.com>`; cloud firewall still has 80 and 443; port 80 must stay open for renewals |
| memory alert (≥ 70 %) | `draw_history` grew ([section 16](#16-how-big-it-gets)) | raise `maxmemory` in `valkey.prod.conf` up to about half the box's RAM, then `docker compose exec valkey valkey-cli CONFIG SET maxmemory <bytes>` (no restart); past that, rescale the server in the Hetzner console (the IP stays) |
| writes refused, `OOM command not allowed` | memory at 100 % | the same, now. Nothing was lost: the consumer has been retrying the same event, and the indexer resumes from its watermark |
| `queue_length` large and growing | consumer stuck behind a failing apply | `docker compose logs server` names the event and error |
| indexer logs `tx index poll failed` | FastNEAR unreachable, or 429 without a key | check `FASTNEAR_API_KEY` in `.env`; it retries at the next interval by itself |
| indexer exits at start: `set START_BLOCK_HEIGHT` | empty Valkey and no start block | fix `.env`, `docker compose up -d` |
| wall shows old tiles while health is ok | browsers fell back to the chain, or nobody triggered a poll | open the wall (a viewer triggers a poll) and compare `painted_tiles` after a paint |
| `board-history check` exits 1 | log and board disagree | do not guess: the output lists the tiles. If the mirror itself is right (`replay-check.py` exit 0), run `board-history backfill` again; if it is not, rebuild (below) |
| snapshot or AOF rewrite failed | disk full, or no memory to fork | `df -h`, `docker system prune`, prune `backups/`; then `docker compose exec valkey valkey-cli BGREWRITEAOF` |
| disk alert | Docker build cache, old images, backups | `docker system prune -af` (keeps running containers' images), lower `BACKUP_KEEP` |

**The repair that always works: rebuild from the chain.** Everything Valkey holds today can be
re-derived (section 17), so when the data is in doubt:

```bash
docker compose stop indexer server
scripts/backup-valkey.sh                        # keep what is there, whatever its state
docker compose down                             # caddy too: a minute of 502s, the wall reads the chain meanwhile
mv valkey-data "valkey-data.suspect-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose up -d
curl -s -X POST http://127.0.0.1:3000/api/hint -o /dev/null
# wait for queue_length 0, then section 9: backfill, check, replay-check
```

**Once the Telegram bot (AWAY-B) stores its account ↔ chat bindings in this Valkey, do not
rebuild: restore.** Those bindings are not on the chain and a rebuild deletes them. Use
`scripts/restore-valkey.sh` with the newest backup instead; the indexer then re-reads
everything after the backup's watermark from the chain.

## 14 Update and roll back

```bash
cd ~/metapoo/ops/board-server
git rev-parse HEAD                    # write this down: it is the rollback target
scripts/backup-valkey.sh
git pull --ff-only
docker compose up -d --build          # rebuilds the image, restarts only what changed
curl -s http://127.0.0.1:3000/api/health | jq
docker compose run --rm indexer board-history check; echo "exit $?"
```

The restart drops open WebSockets for a few seconds; each wall reconnects and catches up, and
reads the chain in between. If a release note says to re-run the backfill, do it here. Config
only (`Caddyfile`, `valkey.prod.conf`, `.env`): `docker compose up -d` recreates the affected
service; for the Caddyfile alone,
`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` has no downtime.

Roll back the code:

```bash
git checkout <the commit written down above>
docker compose up -d --build
```

That is enough when the new version only misbehaved. If it also **wrote** something wrong (a
bad apply rule, a changed log format the old code cannot read), go back to the data from
before the update as well: `scripts/restore-valkey.sh backups/<the file from this update> --yes`.
The indexer re-reads everything since that backup from the chain, with the old code.

OS updates arrive through `unattended-upgrades`; reboot when `/var/run/reboot-required`
exists. All four services are `restart: unless-stopped`, so they come back with Docker.

## 15 Backups and restore

**What is worth backing up.** Today, strictly, nothing that cannot be rebuilt from the chain
in a few minutes (section 17); a backup still turns a rebuild into a faster and more certain
restore. **From the day AWAY-B lands, backups are the only copy of the Telegram bindings**, so
have the off-box copy working before then. Also keep `.env` and `ops.env` in a password
manager. Caddy's certificates need no backup; it gets new ones.

**How the copy is made consistent.** `scripts/backup-valkey.sh` asks Valkey for a snapshot
(`BGSAVE`), waits until it has finished and succeeded, verifies it with `valkey-check-rdb`,
and streams `dump.rdb` out through the container (Valkey writes it mode 0600 as its own
user). An RDB is the whole dataset at one instant: the board, the log, the id map, the
counters and both watermarks agree with each other, which is what lets the indexer resume
from exactly where the backup ends. The AOF directory is deliberately not copied: its files
change under a running server, and a file-level copy of them can be torn mid-write.

The timer from step 11 runs it nightly at about 03:17 UTC into `backups/`
(`board-valkey-<UTC stamp>.rdb.gz`, newest 14 kept). **Off the box**, the two options from the
spec. Pick one; they also combine:

| | A. Hetzner Backups / snapshots | B. Object storage (or a pull) |
|---|---|---|
| what | the whole disk, daily, 7 kept, by Hetzner | the nightly `.rdb.gz`, by the script |
| setup | one tick on the server (Backups: +20 % of its price). Snapshots are the manual version, billed per GB | `sudo apt-get -y install rclone && rclone config`, then `BACKUP_RCLONE_REMOTE=<remote>:<bucket>/valkey` in `ops.env`. Any S3-compatible store works (Hetzner Object Storage, Backblaze B2, …). Or, with no storage service at all, pull from a machine you own: `rsync -a deploy@<SERVER_IP>:metapoo/ops/board-server/backups/ ~/board-backups/` |
| consistency | a disk image of a running box: Valkey recovers from its AOF as after a power cut, losing at most about a second | exact: one snapshot instant |
| restores | the whole box, `.env` and certificates included, as one unit | the data, onto any box, in a minute |
| does not cover | deleting the server or the project also deletes its backups; a restore is all-or-nothing | `.env`, the OS (this runbook rebuilds those) |

Recommendation: **turn on A now** (no work, covers the whole box) and keep the script's local
nightly copies for update rollbacks; **add B before AWAY-B ships**, because then there is data
that exists nowhere else and it should not live only inside one Hetzner project.

**Restore** (ran end to end on Valkey 8.1 with the real server, see section 18):

```bash
cd ~/metapoo/ops/board-server
scripts/restore-valkey.sh backups/board-valkey-<stamp>.rdb.gz --yes
docker compose run --rm indexer board-history check; echo "exit $?"
curl -s -X POST http://127.0.0.1:3000/api/hint -o /dev/null      # read the chain since the backup
curl -s http://127.0.0.1:3000/api/health | jq
```

The script stops every service except Caddy, moves the current `valkey-data` aside (never
deletes it), loads the RDB with AOF off, turns AOF on so Valkey writes it from memory, waits
for that, and starts the stack. It refuses a file that is not an RDB and stops with the stack
down if the load comes up empty. Paints made after the backup are not lost: they are on the
chain, the indexer resumes from the backup's own `last_processed_block`, and replaying them
writes the same log entries with the same ids.

Onto a **new box**: sections 1–6, `docker compose build`, copy the backup file over, run the
restore command above, then sections 9–11. If the IP changed, update the DNS record.

Do a restore once on purpose (on the box before cut-over is the cheap moment) so the first
real one is not the first one.

## 16 How big it gets

Everything Valkey holds is in RAM. Only one key grows without bound: `draw_history`, one
stream entry per painted tile, never trimmed. Its entry is the fields
`block, at_ms, x, y, color, by, free` under an id of `<block × 10⁶ + place>-<index>`; the
account name in `by` is most of it. Measured on Valkey 8.1 with 100,000 entries, 25 tiles per
paint transaction (`MEMORY USAGE draw_history SAMPLES 0`):

| painter's account | RAM per painted tile | on disk (RDB) |
|---|---|---|
| short named account (`player12.near`) | **53 bytes** | about 20 bytes for a mix of both |
| 64-character implicit account | **107 bytes** | |

Count on **about 100 bytes per painted tile**. A `board_expanded` entry is one more of about
the same size, and there are a handful of those ever. The rest is small and bounded: the board
blobs and per-tile times (under 1 MB for 128 × 128), the 2-hour catch-up buffer, and
`covers:*`, which keep 30 days at roughly 150 bytes per covered tile.

| `draw_history` | tiles painted, worst case (107 B) | in whole-wall repaints (16,384 tiles) |
|---|---|---|
| 100 MB | 0.9 million | 57 |
| 700 MB: **the alert**, 70 % of 1 GB | 6.5 million | 400 |
| 1 GB: `maxmemory`, writes refused | 9.4 million | 570 |

So the smallest box is too small when the wall has been repainted some 400 times over. Before
that the alert fires, and the steps are, in order: raise `maxmemory` towards half the RAM
(2 GB on a 4 GB box; a snapshot forks the process and a busy moment can briefly need the
difference); then rescale to the next server size and raise it again. Two things to know:

- `board-history backfill` builds the replayed log beside the live one when it has to rewrite
  it, so it needs the log's size again for a moment. On a fresh box it rewrites nothing.
- To see where it stands: `docker compose exec valkey valkey-cli MEMORY USAGE draw_history
  SAMPLES 0` and `XLEN draw_history`.

Disk is not the constraint: the RDB and the AOF base are about 20 bytes a tile each, and 14
gzipped backups less than that.

## 17 Why a fresh rebuild, not the Mini's data

The new box builds its own mirror from the chain (step 8). The Mini's Valkey data is not
moved. The reasoning, from the code:

**Everything in Valkey today is derived from the board's events**, which the indexer re-reads
from `START_BLOCK_HEIGHT` on an empty store:

| key | rebuilt by a replay? |
|---|---|
| the board blob, `written_at`, `free_bits`, `board_side`, `painted_tiles` | yes, by the consumer |
| `account_to_id` / `id_to_account` / `next_owner_id` | yes: ids are handed out in order of first appearance, which the chain fixes |
| `account_pixel_count`, `account_earning_count` | yes, same bookkeeping as the contract |
| `draw_history` | yes, **and better**: on a fresh box the consumer writes it from the first paint, expansions included, so the backfill has nothing to merge and only certifies the start |
| `covers:<account>` | the last 30 days, which is all they ever keep (older covers are not written, by design) |
| `draw_events`, `pixel_ts` | catch-up buffers of 2 h and 1 h; they refill |
| `draw_history:epoch`, `:genesis` | new values; the hostname is new too, so no browser holds a cached page under the old ones |

It costs about 20 transaction-index requests and a few minutes. Against that, moving the data
has real hazards and no gain: an RDB dropped into an AOF-enabled Valkey is ignored and then
overwritten (section 7); the Mini's log starts where its consumer began writing it and predates
logged expansions, so it needs the merging backfill anyway; and a mirror that was ever fed by
the `stream` indexer numbers events differently, which the backfill refuses to merge. A fresh
rebuild is also a full rehearsal of disaster recovery before anything depends on it.

**What is not replayable**, now or soon:

- Covers older than 30 days: gone on both paths, by design.
- **AWAY-B's account ↔ Telegram chat bindings**, once that bot runs here. They exist only in
  this Valkey. That, not the board, is what the backups in section 15 are really for.

The one case for moving data instead: the bot has already collected bindings somewhere. Then
use `scripts/restore-valkey.sh <that dump.rdb> --yes` on the new box; it exists for exactly
that and handles the AOF trap.

## 18 What was tested

On 13 Nov, in a Linux sandbox with Docker, Valkey 8.1.11, Caddy 2.10.2 and the release
binaries built from this branch (TIMELAPSE merged):

- `docker compose config` with the overlay (four services, Valkey on `valkey.prod.conf`) and
  without it (three services, unchanged); it refuses to start without `BOARD_HOSTNAME`.
- The base stack alone, after the overlay had run: three services, `appendonly no`, no
  `maxmemory`, as before this change.
- The overlay stack running: the server published on `127.0.0.1:3000` only, Valkey not
  published; `appendonly yes`, `maxmemory 1073741824`, `noeviction` in effect.
- Caddy (with `BOARD_HOSTNAME=localhost` and its internal CA): `/api/health` over HTTPS, the
  308 from HTTP, `/ws` answering `101 Switching Protocols`, the 98,304-byte region blob served
  gzip-encoded with the server's CORS and `x-last-*` headers intact. `caddy fmt` and
  `caddy validate` clean.
- The AOF trap of section 7, and the safe path around it.
- `backup-valkey.sh`, then `restore-valkey.sh` over a changed store: 20 keys back, the later
  write gone, AOF on, `board-history check` exit 0, the previous data dir kept.
- `health-alert.sh`: one message when the server stops, none on the next run, one when the
  problems change, one on recovery. `shellcheck` clean on all three scripts.
- The per-tile memory figures of section 16.
- `Dockerfile.dockerignore`: the build context fell to 384 kB.

**Not tested, because it needs the real box or the owner's accounts:** a public certificate
from Let's Encrypt; ufw and the Hetzner firewall; the `hcloud` commands; `get.docker.com` on
Ubuntu 24.04; the image build inside Docker (the sandbox's proxy blocks cargo there; the same
sources build with `cargo build --release --locked` outside it); `board-history backfill` and
`replay-check.py` against the live index and chain from the new box; the indexer reaching
FastNEAR; the systemd units under a real systemd (`systemd-analyze verify` only complained
that the paths do not exist here); ntfy, Telegram and rclone delivery; the Vercel change.
Section 12's checklist is where each of those gets proved.
