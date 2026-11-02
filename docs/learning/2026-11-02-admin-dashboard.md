# 2 November — ADM-1 board settings dashboard

## What changed

`/admin` reads the board settings without a wallet and offers owner-only,
wallet-signed edits. A tunables edit re-reads the whole record immediately before
signing, reports changed fields if it differs from the editor's starting record,
and changes only the chosen field. TOILET controls remain read-only.

## Verified boundaries

- Public testnet reads on `board3.metapoo-player1.testnet`, 2 November 2026:
  `get_tunables`, payment config, daily sales, happy hour, free first paints,
  revenue, outstanding credits, withdrawable NEAR, state version, board and
  TOILET emission succeeded at blocks **275861240–275861277**.
- `get_free_first_paints` was called with `{account_id: board}`; its account-specific
  remaining allowance is not presented as the visitor's allowance.
- `get_owner` returned `MethodNotFound`. The actual browser route displayed the
  board read-only. The optional `VITE_BOARD_OWNER` fallback is used only for a
  missing owner method, never an RPC failure. REV-G can remove that fallback need.
- The actual browser route showed the 20,000 daily mPOO credit cap and the live
  0.001 TOILET per-cell-per-second rate. The reference document's assumption that
  emission stays zero was not copied into the live display.
- The team/buyback change timestamps are not exposed in current views. Their
  rows state the seven-day rule and that the contract checks it; no countdown is
  invented. Staking is one-time and its edit disappears once it is set.
- Owner/visitor screenshots at 390 and 1280 pixels use an explicitly labelled
  layout fixture and simulated wallet. Live read-only screenshots use the actual
  `/admin` route. No admin transaction was sent, no contract was changed, no deploy.

## Learned

`get_tunables` includes plain JSON `u64` timestamps. These exceed JavaScript's
safe-integer range. Parsing and re-sending them with ordinary `JSON.parse` and
`JSON.stringify` can corrupt history and trigger `PriceHistoryImmutable`.
The admin reader preserves large integers as `bigint`; its serializer writes
them back as exact JSON numbers, keeping quoted U128 amounts quoted.

Meteor's published adapter accepts typed-array argument bytes via its
`stringifyJsonOrBytes` path. The helper uses those bytes when needed; another
adapter must be verified before it can send settings with unsafe-size integers.
This is source-checked and fixture-tested, not a live Meteor signing claim.

## Regression evidence

`admin-route.test.ts` / “opens public board settings at /admin and /admin/”
fails against the original routing (`not-found`) and passes after the change.
Other tests cover owner/network gating, disconnecting during pre-sign reads,
stale-record detection, exact history bytes, token-price arithmetic, contract
bounds, cooldown countdowns, and unavailable reads.

On this Mac, Node 26's experimental global web storage causes unrelated connector
tests to finish with unhandled localStorage errors. Run the full suite here with
`NODE_OPTIONS=--no-experimental-webstorage npm test`. CI uses Node 22.

## Backlog handoff

ADM-1 implementation and local/real-read verification are ready for review.
Owner-wallet transaction verification remains open. The merger updates
`docs/backlog.md` on main; this PR does not edit it.
