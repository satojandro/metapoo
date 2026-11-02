# RHEA route investigation — 3 November 2026

Scope: public read-only NEAR mainnet queries. No key was loaded, no approval was requested, and no
swap, storage registration, transfer, wrapping or deployment occurred.

The complete [JSON observations](2026-11-03-rhea-route-evidence.json) retain each request, decoded
response, block height/hash and capture time. Reproduce with:

```sh
python3 web/src/integrations/rhea/discover-route.py
```

The script reads public contract state and writes this JSON evidence file only. The observations
are a dated snapshot, not a route manifest or authorization to trade.

## Observed

- All 27 public reads returned valid RPC responses; some candidate pool responses were `null`.
- MPOO is `mpoo.nearlytrade.near`, with 18 decimals.
- Token `get_tax` reports 200 bps buy tax, 300 bps sell tax, and the DCL exchange
  `dclv2.ref-labs.near` as a taxed venue. The response names `nearlytrade.near` as admin; no
  immutability guarantee is inferred.
- Nearly's launch record still maps MPOO to
  `diarhea.nearlytrade.near|mpoo.nearlytrade.near|10000`.
- That DCL pool was Running with nonzero current liquidity. A read-only quote for
  `1000000000000000000` DIARHEA atomic units returned `8421118233644244640` MPOO atomic units.
  This is a pool quote, **not proof of post-tax wallet delivery** or an executed swap.
- A nonzero-liquidity RHEA/wNEAR candidate exists at
  `token.v2.ref-finance.near|wrap.near|400`.
- The probed DIARHEA/RHEA DCL pools at fees 100, 400, 2000 and 10000 were absent.
- The probed DIARHEA/wNEAR pool at fee 10000 existed but had zero current and total liquidity.
  The other three probed fee tiers were absent.

## Execution remains disabled

No production `route-mainnet.json` is supplied. A complete native-NEAR-to-MPOO route was not
established by these DCL probes. Classic-pool discovery is a remaining investigation, rather than
an assumed direct pair. If that route crosses exchange contracts, it needs separate fresh-quote
checkpoints; verified consecutive DCL hops keep the owner's one-transaction wrap/swap batching.

The deployed token's tax rounding, stability during execution, DCL final-output minimum semantics,
and multi-pool all-or-refund behaviour have not been established here. A positive pool quote does
not pass those release gates. The embedded acquisition modules therefore require an explicit
reviewed route, code hashes, gas ceilings and net-minimum proof before allowing submission. The
existing Nearly acquisition link remains available.

Fixture tests exercise integer quotes, approved action planning, wrapped-input recovery,
transaction-argument matching, transfer-resolver results, attributable token events and native
reserve checks. They do not claim live Privy approvals, mainnet execution, or tax compatibility.
