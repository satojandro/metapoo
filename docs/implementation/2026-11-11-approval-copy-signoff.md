# Wallet approval copy — proposed for owner sign-off

Status: **proposal, not approved.** Nothing in this document is implemented. It exists so the
wording a player reads in their wallet can be signed off once, before the G + SEND-HARDEN PR.
Date: 11 November 2026. Base: `main` at `016521f`.

Review basis: UI launch review section **G** (approval window) and **A4** (Send, Self-custody).
Decision taken by the owner, 11 Nov: **G ships with SEND-HARDEN in one PR, separate from the A4 PR.**

## 1. What the first draft got wrong

The first table was not approved. Six faults, all confirmed against the code or the contracts
before rewriting — each one was a false statement a player would have read:

1. Registration on the board is **`register_credit_account`**, not `storage_deposit` — and my claim
   that it is never its own approval was **only half right** (`web/src/wallet.ts:788-814` vs
   `:840-874`). A NEAR purchase batches it with `buy_credits_near` in **one** transaction and one
   approval; an **mPOO purchase signs it as its own transaction first**, so that path shows **two
   approvals**. The board has no unregister and no refund either way, so "refundable if you close
   your account" was false.
2. The first-purchase **button understated its total**: the transaction sends credits **plus** the
   one-time setup, so the button must carry the sum.
3. My paint row was wrong twice over. With a painting key active, a `draw`/`draw_many` **never
   reaches an approval window at all** — it signs locally (`submit-draw.ts:127-136`,
   `local-draw.ts:287,511`). The NEAR it spends was prepaid as a **0.25 NEAR allowance when the key
   was added** (itself one approval, `wallet.ts:473-491`). The window only appears in the fallback
   where the account's main key signs (`submit-draw.ts:213`).
4. `claim_toilet` and `claim_rewards` take **no amount argument**; the figure accrues until
   execution, so a number in the title would be one the game passed in, not one the wallet can check.
5. "About 0.0004 NEAR" was **not computed anywhere**. The existing honest note stays: you pay only
   for gas used, never more than the limit.
6. `ft_transfer_call` is **two different actions** depending on the token: mPOO → board buys credits;
   TOILET → staking with `msg: "stake"`. It must be matched on (token contract, receiver, msg),
   never on the method name alone.

## 2. Approved-wording table (proposed)

Every row is derived **inside the sign page from the transaction itself** — deposit, `min_credits`,
`max_credits`, cell count, `amount`. No label the game passes in may caption the transaction.

| Action (matched on) | Title | Rows | Button |
|---|---|---|---|
| `buy_credits_near` on the board | Buy 10 credits | Pay · 0.025 NEAR — To · the Meta Poo wall | Pay 0.025 NEAR |
| `register_credit_account` + `buy_credits_near` | Buy 10 credits | Credits · 0.025 NEAR — One-time account setup · 0.01 NEAR — Total · 0.035 NEAR | Pay 0.035 NEAR |
| `register_credit_account` (mPOO path) — **first of two approvals** | Set up your account | One-time account setup · 0.01 NEAR — Needed once before mPOO credits | Pay 0.01 NEAR |
| `ft_transfer_call` (mPOO → board) — **second approval** | Buy 10 credits with mPOO | Pay · 48.25 mPOO — To · the Meta Poo wall | Pay 48.25 mPOO |
| `draw` / `draw_many` on the board — **only when the main key signs** (no painting key active) | Paint 3 tiles | Cost · at most 3 credits — Network fee · a little NEAR | Paint 3 tiles |
| `claim_toilet` on the board | Claim your TOILET | Everything your tiles have earned — To · your wallet | Claim TOILET |
| `ft_transfer_call` (TOILET → staking, `msg: "stake"`) | Stake 607.68 TOILET | To · the staking pool | Stake 607.68 TOILET |
| the same, preceded by `storage_deposit` on staking | Stake 607.68 TOILET | To · the staking pool — One-time setup · 0.01 NEAR, returned if you leave with nothing staked | Stake 607.68 TOILET |
| `unstake` on staking | Unstake 100 TOILET | You get back · 90 TOILET — Burned forever · 10 TOILET | Unstake 100 TOILET |
| `claim_rewards` on staking | Claim your mPOO | Everything the pool has paid you — To · your wallet | Claim mPOO |
| `storage_deposit` on mPOO + `claim_rewards` | Claim your mPOO | as above — One-time mPOO setup · `<amount read from the token>` NEAR | Claim mPOO |
| Send (unchanged) | Send 0.5 NEAR | You send · 0.5 NEAR — To · bob.near — Network fee, at most · 0.0004 NEAR | Send 0.5 NEAR |

Place rules: "the Meta Poo wall" only when the receiver is the configured board id; "the staking
pool" only for the configured staking contract. Anything else is unmapped and **refused**.

Owner console gets an explicit allowlist — board plus `distribute_near`, `distribute_mpoo`,
`set_paused`, `set_tunables` — so that "untouched" cannot leave the generic "Calls X on Y" path open
as a catch-all. **After this PR there is no catch-all.** The fact-check added four shapes that need
rows or refusals: `distribute_near` / `distribute_mpoo` take no args, no deposit and **anyone may
call them** (`wallet.ts:908-928`); the owner setters (`set_tunables`, `set_paused`, `set_near_price`,
`set_mpoo_price`, `set_team_account`, `set_buyback_account`, `set_staking_contract`) are owner-only
1-yocto calls (`wallet.ts:1018-1061`); the staking contract also accepts **mPOO with `msg: "fund"`**
(`contracts/toilet-staking/src/lib.rs:232-237`), which is a different caption from `"stake"`; and the
RHEA swap sends `near_deposit` + `ft_transfer_call` to an exchange
(`integrations/rhea/plan.ts:118-127`), so an unlisted exchange receiver must be refused, not captioned.

Rates and setup amounts come from the contracts (the same reads the Stake page makes): the unstake
burn rate, the staking registration amount, the mPOO registration amount. **No constants in the sign
page**, and no claim of refundability for the mPOO token until that contract is checked — which is
why its amount is left as `<amount read from the token>` here.

Multi-transaction approvals keep the existing note: *if one fails, the others can still happen.*

## 3. Missing from the table — the two wordings this document exists to get signed

### 3.1 Adding a full-access key (Self-custody) — the highest-stakes approval in the app

| element | proposed text |
|---|---|
| eyebrow | `Add your own key` |
| title | **Give your wallet full control** |
| rows | **Adds** · a full-access key you control (`ed25519:3sF9…kQ2`) — **Can do** · sign anything for this account, including moving every token — **Privy's key** · stays, so both keys can sign — **Meta Poo** · cannot remove your key; only your wallet can |
| note | Network fees come out of your NEAR. You only pay for gas actually used, never more than the limit. |
| button | **Add full-access key** |
| Technical details | unchanged: the public key, method, gas limit, arguments |

Why this shape: the title says who ends up in control; the "Can do" row is the risk in one clause; the
two remaining rows answer the two questions a player actually has — does my normal sign-in stop
working (no), and can the game undo this (no).

### 3.2 Self-custody panel intro (two sentences: what it is, what it risks)

> **Self-custody adds a second, full-access key that you control, so the account and everything in it
> stay reachable with your own wallet even if Privy is unavailable. Nothing moves between wallets —
> but a full-access key can sign anything, including moving every token, so keep it somewhere only you
> can reach.**

`VITE_SELF_CUSTODY_ENABLED` stays off until both 3.1 and 3.2 are approved. The panel's structure
(labelled key rows, numbered steps, in-panel confirmation) lands first, under the flag, with the
existing sentence still in place.

## 4. Done means (G + SEND-HARDEN PR)

- A test per row that **fails before and passes after**, including: an `ft_transfer_call` to an
  unlisted receiver is refused; an unmapped method on the board is refused; a caption cannot be
  changed by anything outside the transaction.
- One real approval **per row on mainnet**, with a screenshot of the window and the transaction
  reference in the PR description. Reachable is not verified.
- Method name, contract id, gas limit and arguments all still present under Technical details.
- The sign page reads amounts and rates only from the transaction and the contracts; a grep for
  numeric literals in the new copy path must come back empty.

## 5. Open questions for the owner

1. Sign off on §2's rows and the two buttons that carry a **total** (first NEAR purchase, first mPOO
   purchase) — those are the two places the wording changed most from my first draft.
2. Sign off on §3.1 and §3.2.
3. The mPOO token is external (`mpoo.nearlytrade.near`, `web/README.md:48`) with **no source in
   `contracts/`**, so its refundability is **not established in the repo**. The code already reads the
   amount at runtime (`storage_balance_bounds` → `mpooStorageMin`, `staking.ts:163-172`), which is why
   the table shows `<amount read from the token>`; the row makes **no refund claim**. Settling
   refundability needs the token's source or a `storage_unregister` probe — say which you want before
   that row ships.
4. `claim_toilet` currently sends a `toilet` argument that the contract signature does not have
   (`wallet.ts:1011`); it is silently ignored. The approval copy will not mention it, but the dead
   argument should be removed in a follow-up rather than captioned.
