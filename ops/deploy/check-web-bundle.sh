#!/bin/zsh
# Deploy guard: refuse to ship a web bundle whose reads are not keyed.
#
# Why this exists: on 2026-11-06 the production deploy shipped with reads hitting
# FastNEAR's anonymous pool; rapid painting tripped -429 rate limits and testers saw
# "Paint not painted". The mechanism (VITE_NEAR_RPC_API_KEY -> Authorization header)
# existed since PR #74 — the deploy just didn't carry the variable, and nothing
# checked. This script is that check. Run it AFTER `vercel build --prod` and BEFORE
# `vercel deploy --prebuilt --prod`.
#
# Usage: ops/deploy/check-web-bundle.sh [web-dir]
# Exits 0 when the key is in the bundle, 1 when not (and the deploy must not run).

set -u
WEB="${1:-$HOME/Projects/metapoo-main/web}"
OUT="$WEB/.vercel/output/static"

# Key from Bitwarden; never echoed, never written to disk.
KEY="$(bws secret get 44086ddf-7754-429e-ba85-b4f9005130ac --output json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])')"
if [ -z "$KEY" ]; then
  echo "FAIL: could not load FASTNEAR_API_KEY from Bitwarden (bws). Not deploying unkeyed." >&2
  exit 1
fi

if [ ! -d "$OUT/assets" ]; then
  echo "FAIL: no build output at $OUT — run \`vercel build --prod\` first." >&2
  exit 1
fi

if grep -qrF -- "$KEY" "$OUT/assets/" 2>/dev/null; then
  echo "OK: VITE key present in bundle assets. Deploy may proceed."
  exit 0
fi

echo "FAIL: FastNEAR key NOT in the bundle. The deploy would ship anonymous reads" >&2
echo "      (the 2026-11-06 rate-limit incident). Fix: \`vercel env add\` the" >&2
echo "      VITE_NEAR_RPC_API_KEY variable, \`vercel pull\`, rebuild, re-check." >&2
exit 1
