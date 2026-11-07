#!/usr/bin/env python3
"""Spec §7.1: the server's blob equals the chain's `get_pixels`, tile for tile, at one block.

Reads every painted cell from the board with `get_pixels` pinned to BLOCK (an archival RPC,
because the replay ends in the past), reads the server's blob and written-at blob, and compares
colour, artist and written_at_ns per tile, plus each holder's tile count against
`get_cells_owned` (and `get_earning_cells` when the board has it).

Usage: replay-check.py SERVER_URL BOARD_ACCOUNT BLOCK [RPC_URL]
Stdlib only. Exit 0 = identical.
"""
import base64
import json
import struct
import sys
import urllib.request

SERVER, BOARD, BLOCK = sys.argv[1].rstrip("/"), sys.argv[2], int(sys.argv[3])
RPC = sys.argv[4] if len(sys.argv) > 4 else "https://archival-rpc.mainnet.fastnear.com"
PALETTE = [p["hex"].lstrip("#").lower() for p in json.load(open(__file__.rsplit("/", 4)[0] + "/shared/board.json"))["palette"]]


def http(url, body=None):
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.headers


def view(method, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
        "request_type": "call_function", "block_id": BLOCK, "account_id": BOARD,
        "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode()}}).encode()
    reply = json.loads(http(RPC, body)[0])
    if "error" in reply or "error" in reply.get("result", {}):
        raise RuntimeError(f"{method}: {reply}")
    return json.loads(bytes(reply["result"]["result"]))


chain, start = {}, 0
while start is not None:
    page = view("get_pixels", {"from_index": start, "limit": 256})
    for p in page["pixels"]:
        chain[(p["x"], p["y"])] = p
    start = page.get("next_from_index")

blob, headers = http(f"{SERVER}/api/region/0/0")
written, _ = http(f"{SERVER}/api/region/0/0/written-at")
# The comparison only means something at one block. A mirror *ahead* of BLOCK holds tiles the
# chain did not have yet — this script would report them as differences — and one behind is
# missing paint, which is a real failure but of the queue, not of the replay.
mirrored_block = int(headers.get("x-last-block") or 0)
if mirrored_block != BLOCK:
    print(f"mirror last applied block is {mirrored_block}, not {BLOCK}: "
          f"let the queue drain to BLOCK, or replay at {mirrored_block}")
    sys.exit(2)
names = {}


def name(owner):
    if owner not in names:
        names[owner] = http(f"{SERVER}/api/account/{owner}")[0].decode()
    return names[owner]


errors, mirrored = [], 0
for y in range(128):
    for x in range(128):
        i = y * 128 + x
        r, g, b = blob[i * 6:i * 6 + 3]
        owner = int.from_bytes(blob[i * 6 + 3:i * 6 + 6], "little")
        at = struct.unpack_from("<Q", written, i * 8)[0]
        c = chain.get((x, y))
        if c is None:
            if owner:
                errors.append(f"({x},{y}) painted by the server, empty on chain")
            continue
        mirrored += 1
        want = (PALETTE[c["color"]], c["artist"], c["written_at_ns"])
        got = (f"{r:02x}{g:02x}{b:02x}", name(owner) if owner else None, at)
        if want != got:
            errors.append(f"({x},{y}) chain {want} server {got}")

stats = {row["account_id"]: row for row in json.loads(http(f"{SERVER}/api/stats/accounts")[0])}
for account in sorted({c["artist"] for c in chain.values()} | set(stats)):
    owned = view("get_cells_owned", {"account_id": account})
    got = stats.get(account, {}).get("pixel_count", 0)
    if owned != got:
        errors.append(f"{account}: get_cells_owned {owned}, server {got}")
    try:
        earning = view("get_earning_cells", {"account_id": account})
    except RuntimeError:
        earning = None  # board without the view (not deployed as of 7 Nov)
    if earning is not None and earning != stats.get(account, {}).get("earning_count", 0):
        errors.append(f"{account}: get_earning_cells {earning}, server {stats[account]['earning_count']}")

print(f"block {BLOCK}: chain {len(chain)} painted tiles, server last block {headers.get('x-last-block')}, "
      f"{mirrored} compared, {len(stats)} holders, {len(errors)} differences")
for e in errors[:50]:
    print("  " + e)
sys.exit(1 if errors else 0)
