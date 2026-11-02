# Work queue — 1 November 2026 (status updated 2 November)

## Status, 2 November — read this first

**Merged (2 Nov):** #33 keeper, #34 REV-A, #39 the combined revision, #37 the wall split, #44 CI,
#41 FE-1, #43 FE-2, #40 FE-4, #42 FE-5 (`/money`), #45 board3 migration rehearsal, #46 ADM-1, #47 the TOILET
round spec. Closed as superseded: #35, #36, #38.

**Waiting for merge:** nothing. **In progress:** nothing.

**Ready to pick up.** Each has a work order in this folder. The TOILET round spec is
[`../economy/2026-11-02-toilet-round-spec.md`](../economy/2026-11-02-toilet-round-spec.md).

Codex streams (run in parallel; each is contract or ops code with named tests, and none deploys):

| stream | id | work order | needs |
|---|---|---|---|
| 1 | **REV-G**, then **TR-B** | [`rev-followups`](rev-followups.task.json), then [`toilet-round-board`](toilet-round-board.task.json) | nothing; pause decided (distributions keep running). **Same line of work**: both change `Tunables` and `set_tunables`, so TR-B starts from REV-G's merge |
| 2 | **TR-S** | [`toilet-staking`](toilet-staking.task.json) | nothing (no owner, no upgrade: T9). External review after, before any `set_staking_contract` |
| 3 | **TR-K** | [`buyback-keeper`](buyback-keeper.task.json) | nothing; the swap route needs on-chain research. Hermes does the testnet run after |

Claude (frontend, for one voice and look):

| id | work order | needs |
|---|---|---|
| **FE-HIW** | [`fe-how-it-works`](fe-how-it-works.task.json) | nothing |
| **ADM-2** | [`adm-2-owner-console`](adm-2-owner-console.task.json) | nothing; step 7 waits for TR-B |
| **FE-3** | [`fe-free-paints-happy-hour`](fe-free-paints-happy-hour.task.json) | nothing (reassigned to Claude, 2 Nov) |
| **FE-BUYBACK** | [`fe-buyback-ledger`](fe-buyback-ledger.task.json) | nothing |
| **FE-TOILET** | [`fe-toilet-page`](fe-toilet-page.task.json) | TR-B and TR-S rehearsed on testnet |

Hermes, the owner, or both (keys, a browser, a person):

| id | work order | needs |
|---|---|---|
| **REV-E** | [`rev-testnet-rehearsal`](rev-testnet-rehearsal.task.json) | the owner's testnet team and buyback accounts; board3's owner key |
| **TR-X** | [`toilet-exchange-tax`](toilet-exchange-tax.task.json) | the owner's choice of tax split and treasury; a testnet venue |
| **FE-29** | [`issue-29-recheck`](issue-29-recheck.task.json) | a browser and wallet |
| REV-E0 | superseded: the burn goes by transfer to the 64-zero address, registered on mainnet 2 Nov | — |

ADM-1 ([`admin-dashboard`](admin-dashboard.task.json)) is delivered (#46); its follow-up is ADM-2.

Frontend consistency (owner, 2 Nov): Claude takes the public-facing pages so they share one voice and look.
Designs are in [`../visual-concepts/README.md`](../visual-concepts/README.md).

**Branches to start from:** `main`. Everything above is merged.

**Settings at a glance:** [`../payments/board-settings-reference.html`](../payments/board-settings-reference.html).

**Backwards compatibility (owner, 2 Nov):** a fresh testnet board can be deployed at any time, and
mainnet is a fresh deploy. New work doesn't need to support today's board3 contract.

**Workload note (owner, 2 Nov):** running five agents at once hit the 5-hour usage limit. Run two or
three at a time, and spread work across Claude, Hermes, Cursor and Codex.

**Open owner decisions:** (decided 2 Nov: distributions keep running while paused)
- the mPOO daily cap at launch (recommended 20,000)
- the testnet team and buyback account ids
- bounding the distribution interval (proposed 10 min – 24 h, in REV-G)

---


**Baseline:** `main` = `0c3eb8d`. **Goal:** the launch contract and the page that goes with it, built in
parallel by several agents without colliding.

Specs: [paid board revision](../payments/2026-11-01-paid-board-revision-spec.md) ·
[wall controller split](2026-11-01-wall-split-spec.md). Every row below has a work order (`*.task.json`
in this folder) that an agent can be given as-is. TOILET is the next review round and isn't here.

Assignees are suggestions by lane (Codex: contracts, Cursor: frontend, Hermes: chain and ops, Claude:
anything, priority over Codex). The owner or Hermes reassigns freely.

## Waves

```mermaid
flowchart LR
  subgraph W1[Wave 1 - start now, in parallel]
    A[REV-A state + migration]
    E0[REV-E0 mPOO burn signature]
    F0[FE-0 wall split]
    F29[FE-29 recheck #29]
  end
  subgraph W2[Wave 2]
    B[REV-B price guards]
    C[REV-C paint cost + 16 colours]
    D[REV-D revenue split]
    K[REV-F keeper]
    F1[FE-1 16 swatches]
    F2[FE-2 max_credits + one balance]
    F4[FE-4 mPOO checkout]
    F5[FE-5 revenue panel]
  end
  subgraph W3[Wave 3]
    E[REV-E testnet rehearsal]
    F3[FE-3 free paints + happy hour]
  end
  A --> B & C & D
  E0 --> D
  D --> K
  B & C & D --> E
  F0 --> F1 & F2 & F4 & F5
  C --> F1 & F2
  F2 --> F3
  B --> F4
  D --> F5
```

## Assignment

| id | work order | lane | blocked by | files it owns |
|---|---|---|---|---|
| **REV-A** | [`rev-state-migration`](rev-state-migration.task.json) | Codex | — | paid-board structs, `migrate.rs`, `upgrade` |
| **REV-E0** | [`mpoo-burn-signature`](mpoo-burn-signature.task.json) | Hermes | — | docs only |
| **FE-0** | [`wall-split`](wall-split.task.json) | Cursor or Claude | — | `web/src/pages/wall/**` |
| **FE-29** | [`issue-29-recheck`](issue-29-recheck.task.json) | Hermes or owner | — | none (browser check) |
| **REV-B** | [`rev-price-guards`](rev-price-guards.task.json) | Codex | REV-A | `payments.rs` pricing, `Tunables::validate` |
| **REV-C** | [`rev-paint-cost`](rev-paint-cost.task.json) | Codex | REV-A | `draw`, `draw_many`, `PALETTE`, `free_paint.rs`, `shared/palette.ts` |
| **REV-D** | [`rev-revenue`](rev-revenue.task.json) | Codex or Claude | REV-A, REV-E0 | `revenue.rs`, `safety.rs`, `ft_on_transfer` parsing |
| **REV-F** | [`revenue-keeper`](revenue-keeper.task.json) | Hermes | REV-D (interface) | `ops/keeper/` |
| **FE-1** | [`fe-palette-16`](fe-palette-16.task.json) | Cursor | FE-0, REV-C | `wall-view.ts` palette, CSS |
| **FE-2** | [`fe-max-credits`](fe-max-credits.task.json) | Cursor | FE-0, REV-C | `pricing-controller.ts`, `paint-controller.ts` |
| **FE-4** | [`fe-mpoo-checkout`](fe-mpoo-checkout.task.json) | Cursor | FE-0, REV-B | buy-credits sheet, `paint-wallet.ts` |
| **FE-5** | [`fe-revenue-panel`](fe-revenue-panel.task.json) | Cursor | FE-0, REV-D | new revenue panel |
| **REV-E** | [`rev-testnet-rehearsal`](rev-testnet-rehearsal.task.json) | Hermes | REV-B, REV-C, REV-D | deployment record, cost doc, `STORAGE_PER_PIXEL` |
| **FE-3** | [`fe-free-paints-happy-hour`](fe-free-paints-happy-hour.task.json) | Cursor | FE-2, REV-C | pricing display, happy-hour banner |

Up to **four agents in wave 1** and **eight in wave 2**. The frontend tasks can start against the
spec'd contract interface with fake services as soon as FE-0 merges. Only their testnet check waits for
REV-E.

## Rules that keep parallel work from colliding

1. **One owner per file set**, as in the table. If a task needs a file another open task owns, it
   waits or the two agree in their PRs which lands first.
2. **REV-A lands every new struct field.** REV-B, REV-C and REV-D add behaviour, not layout. If one of
   them finds a missing field, it's a small follow-up to REV-A's layout, not a private addition.
3. **`ft_on_transfer`:** REV-D owns message parsing; REV-B adds the cap check inside the credit path.
4. **`mount-wall.ts` is frozen** for everyone except FE-0 while FE-0 is open.
5. **Each PR updates `docs/backlog.md`** for its own row, with the merge commit (`AGENT.md`).
6. **Nothing deploys to mainnet** from this queue. REV-E upgrades `board3.metapoo-player1.testnet` only.

## Waiting on the owner

- The **team and buyback account ids** for testnet. REV-E needs them. REV-A and REV-D take them as
  arguments and don't block on them.
- The **mPOO daily cap** launch value (recommended 20,000 credits a day). It's a setting, so nothing
  blocks on it.
