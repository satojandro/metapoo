# The board server's public host

`https://claudios-mac-mini.taila56fc2.ts.net` is the durable public address of the launch board
server (`board.meta-poo-stall.near`). The wall reads it through `VITE_BOARD_SERVER_URL`.

It is a **Tailscale Funnel**: a public HTTPS front door on the Mac Mini that terminates TLS with a
Tailscale-issued certificate and proxies to `http://127.0.0.1:3002`, the host port of the launch
stack's `server` container (`ops/board-server/docker-compose.launch.yml`).

## Why not the Cloudflare quick tunnel

The 7 Nov deploy published the testing stack through `cloudflared` quick tunnels
(`trycloudflare.com`). Those URLs are ephemeral: every restart of `board-tunnel` mints a new one, and
the wall keeps calling the dead host until someone rebuilds and redeploys the site. That is one
container restart away from production silently falling back to chain polling
(`docs/backlog.md`, BOARD-SERVER-DEPLOY item (b)). Funnel is a fixed name with a real certificate and
no process to keep alive — it is pushed down by the Tailscale daemon.

## What it is wired to

```
browser ──https──► claudios-mac-mini.taila56fc2.ts.net  (Tailscale Funnel, :443)
                        │  proxy
                        ▼
                 127.0.0.1:3002  ──► metapoo-launch-server-1 :3000  ──► Valkey ──► indexer ──► FastNEAR tx index
```

The testing stack is untouched and still behind its own tunnel on `127.0.0.1:3300`.

## Verify

```bash
tailscale funnel status                     # expect: / proxy http://127.0.0.1:3002
curl -s https://claudios-mac-mini.taila56fc2.ts.net/api/health
```

`/api/health` reports `status: ok`, `last_applied_block` close to the chain tip, and the
`painted_tiles` count the wall renders. A `502` from the funnel means the container is down, not
that Funnel broke. `curl -i` should show `access-control-allow-origin: *` (the server uses a
permissive CORS layer) and, on the WebSocket, `wss://…/ws` must open and push a snapshot — that is
the path the wall uses for live paint.

## Set up, from scratch

```bash
tailscale funnel --bg 3002        # https://<machine>.<tailnet>.ts.net → 127.0.0.1:3002
tailscale funnel status
```

Funnel needs three things, all already true on the Mini: the Tailscale app installed with its system
extension (so the daemon starts at boot, before login), HTTPS certificates enabled for the tailnet,
and Funnel allowed by the tailnet policy file. Funnel only listens on **443, 8443 and 10000**; that
is why the proxy targets a host port rather than the container's own port.

`--bg` writes the config into the daemon's state, so it survives reboots and Tailscale updates. If
the config is ever lost, re-running the command above restores it; nothing in the web deploy changes.

## What the web deploy needs

Two things on the Vercel side, both outside this repo's build:

1. **`VITE_BOARD_SERVER_URL=https://claudios-mac-mini.taila56fc2.ts.net`** in the Production environment.
   Vite inlines it at build time, so it only takes effect on the next build — and a build without it ships a
   site that renders the wall from chain polling and shows `/timelapse`'s "not connected to a board server"
   state. Check the served bundle rather than the dashboard:
   `curl -s https://metapoo-testnet.vercel.app/ | grep -oE '/assets/app-[^"]+\.js'` then grep that file for
   `ts.net`.
2. **The host in `web/vercel.json`'s CSP `connect-src`** (it is there since 14 Nov, both `https://` and
   `wss://`). The policy is `Content-Security-Policy-Report-Only` today, so a missing host breaks nothing —
   it fills the report stream and then breaks `/timelapse` and the wall's WebSocket the day the policy is
   promoted to enforcing. Any new board host needs this line edited, not just the env var.

## Operational facts

- **The hostname is the machine's Tailscale name.** Renaming the Mini in the admin console changes
  the URL, and the deployed bundle would need a rebuild. Keep the name.
- **One machine, no failover.** If the Mini is off or asleep the wall falls back to chain polling,
  which is slow but correct. Sleep is disabled (`pmset -g custom`: `sleep 0`) and, since 13 Nov,
  `autorestart 1` is set too, so the Mini comes back by itself after a power cut. `sudo pmset -a
  autorestart 1` is the command; `pmset -g custom` is the proof (`autorestart 1` under AC Power).
- **Bandwidth is Funnel's**, i.e. Tailscale's ingress, not the home uplink's port forwarding. Nothing
  is exposed on the router and no ports are open.
- **Only this path is public.** The Valkey instance, the indexer and the testing stack stay on
  loopback or the tailnet.
- **TLS is automatic** and renews without a cron job, unlike the quick tunnel's rotating hostnames.
