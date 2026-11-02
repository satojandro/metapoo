# Admin dashboard — spec

Date: 2 November 2026. Work order: [`admin-dashboard.task.json`](admin-dashboard.task.json) (ADM-1).
Owner request (2 Nov): one page where every setting that can be turned on or off or adjusted is easy to
track and change, because the settings are abstract when they only exist as contract calls.

Reference: [`../payments/board-settings-reference.html`](../payments/board-settings-reference.html) lists every
setting, its launch value, limits and timing rule. It is the content model for this page. The page must
meet the standard of [`../visual-concepts/palette-16-proposal.html`](../visual-concepts/palette-16-proposal.html):
plain explanations next to every number, real data, phone and desktop.

## What it is

A route `/admin` in the existing web app.

- **Anyone can open it read-only.** Showing the rules publicly is part of the trust story. Nothing on it
  is secret.
- **Editing appears only when the connected wallet is the board's owner** (`payments.owner`). Every
  change is a normal wallet-signed transaction. The page holds no keys.
- It reads live from the chain on load and after every change. It never shows cached or invented values.

## Sections (same grouping as the reference page)

1. **Status strip:** paused or live; first board full or not; happy hour open, closed or next window;
   mPOO sales open with credits left today; next distribution time. One line each, coloured by state.
2. **Emergency:** pause and unpause, with a confirmation that names the effect ("painting and buying
   stop; reading and distributions continue").
3. **Prices:** NEAR and mPOO price per credit, each with:
   - its cooldown countdown
   - the allowed range for the next change (half to double)
   - for mPOO, a helper that computes the price from the 7-day average pool rate and the 20% discount.
     The owner enters the average; there's no oracle.
4. **Repaint pricing**, **mPOO sales**, **supply and reserves**, **free painting**, **happy hour**,
   **revenue accounts**, **TOILET (read-only for now)**, **fixed rules (read-only)**.

Each setting row shows:
- the name in plain words and one sentence on what it does
- the current value, read live, formatted in human units (NEAR, hours, UTC time and the viewer's local
  time)
- its limits
- a timing pill: *any time*, *cooldown, ready in 3 h 12 min*, *once only*, *fixed*
- for the owner: an edit control and a **preview line** ("Base repaint 1 → 2 credits. Counts as a NEAR
  price change: the NEAR price can't change again for 24 h.")

## Making changes safely

- **`set_tunables` replaces the whole settings record.** The page must:
  1. re-read `get_tunables()` immediately before signing
  2. change only the edited fields
  3. send the record with every history field (`last_*_change_ns`) exactly as read
  4. if the record changed between the read and the send, the call can still succeed and overwrite
     another change. So compare with the record the editor started from, and warn if they differ.
- **Validate on the page before signing,** with the contract's own rules and the same rejection codes:
  - `RepaintCreditsOutOfRange`, `RepaintCreditsOutOfOrder`, `RepaintWindowTooLong`
  - `FloatCapBelowOutstanding`, `MpooDailyCapTooHigh`
  - the `HappyHour*` codes, `ReserveFloorTooLow`, `PriceStepTooLarge`
  - the cooldowns

  The contract still enforces them. The page check exists to explain them before the owner signs.
- **One change per transaction** where possible, so a rejection is easy to read. Batched edits are a
  later nicety.
- After each transaction, show the receipt outcome and the transaction link, then re-read everything.
- **Turning happy hour off and pausing** get a one-click path (both are immediate). Everything else
  needs an explicit confirm that shows the preview line.

## Change history

A **recent changes** list built from the board's events: `price_changed`, `pause_changed`,
`revenue_account_changed`, `staking_contract_set`, and the tunables changes if an event exists. Read
from an indexer (nearblocks API, `https://api.nearblocks.io/v1/account/<board>/txns?method=...`), with
a link per transaction. If `set_tunables` emits no event, list its transactions by method and say so.
Adding a `tunables_changed` event is a small contract follow-up (REV-G).

## Out of scope

- TOILET settings are read-only until the TOILET round.
- Upgrades and migrations are not on this page. They stay a reviewed, scripted operation.
- Multisig or delayed admin is a separate decision before mainnet ([upgrade policy](../payments/upgrade-policy.md)).

## Acceptance

- Read-only view works for a visitor with no wallet. Edit controls appear only for the owner account
  (tested with fake wallets).
- Every setting on the reference page appears, with its live value, limits and timing pill.
- Tests:
  - the `set_tunables` read-modify-write sends history fields unchanged and only the edited field
    changed
  - page validation rejects each out-of-range value with the contract's code
  - cooldown countdown and "ready" state
  - the mPOO price helper's arithmetic is exact (integer yocto), including the 20% discount
- Works against today's board3 (old contract) by showing only the settings it has, with the rest
  marked "arrives with the next board version".
- Screenshots at 390 px and 1280 px, visitor and owner views.
- `npm test`, `npm run build`, `## Learned`, backlog row.
