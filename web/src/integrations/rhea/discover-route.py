"""Public read-only route observations. Never loads wallet keys or sends transactions."""
import base64
import datetime
import json
import pathlib
import urllib.request

RPC = "https://rpc.mainnet.near.org"
MPOO = "mpoo.nearlytrade.near"
DCL = "dclv2.ref-labs.near"
readings = []


def query(account, method=None, args=None):
    params = {"request_type": "call_function" if method else "view_account",
              "account_id": account, "finality": "final"}
    if method:
        params.update(method_name=method, args_base64=base64.b64encode(
            json.dumps(args or {}).encode()).decode())
    request = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": "rhea-read",
        "method": "query", "params": params}).encode(), headers={"Content-Type": "application/json"})
    entry = {"account": account, "method": method or "view_account", "args": args or {}}
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
        if "error" in result:
            entry["error"] = result["error"]
        else:
            result = result["result"]
            entry.update(block_height=result["block_height"], block_hash=result["block_hash"])
            entry["value"] = json.loads(bytes(result["result"])) if method else {"code_hash": result["code_hash"]}
    except Exception as error:
        entry["error"] = str(error)
    readings.append(entry)
    return entry.get("value")


for token in ["wrap.near", "token.v2.ref-finance.near", "diarhea.nearlytrade.near", MPOO]:
    query(token, "ft_metadata")
    query(token)
query(MPOO, "get_tax")
launch = query("nearlytrade.near", "get_launch_by_token", {"token": MPOO})
if isinstance(launch, dict) and "id" in launch:
    query("nearlytrade.near", "get_tax", {"launch_id": str(launch["id"])})
query(DCL)
query("v2.ref-finance.near")
pool = "diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000"
query(DCL, "get_pool", {"pool_id": pool})
query(DCL, "quote", {"pool_ids": [pool], "input_token": "diarhea.nearlytrade.near",
    "output_token": MPOO, "input_amount": "1000000000000000000"})
for first, second in [("wrap.near", "token.v2.ref-finance.near"),
                      ("token.v2.ref-finance.near", "diarhea.nearlytrade.near"),
                      ("wrap.near", "diarhea.nearlytrade.near")]:
    for fee in [100, 400, 2000, 10000]:
        query(DCL, "get_pool", {"pool_id": "|".join(sorted([first, second])) + "|" + str(fee)})

evidence = {"version": 1, "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "rpc_url": RPC, "scope": "read-only public RPC; no signatures, swaps or storage deposits",
    "observations": readings, "execution_enabled": False,
    "unverified": ["complete executable input route", "deployed multi-pool all-or-refund semantics",
                   "post-tax net minimum enforcement and stability during execution", "live swap/refund behaviour"]}
destination = pathlib.Path(__file__).resolve().parents[4] / "docs/research/2026-11-03-rhea-route-evidence.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps({"saved": str(destination), "reads": len(readings),
    "successful": sum("value" in item for item in readings), "execution_enabled": False}))
