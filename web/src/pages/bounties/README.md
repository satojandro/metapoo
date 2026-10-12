# Art Bounties pages (Worker G)

Frontend integrator F registers these via `registerBountyPageStubs()` from
`register-stubs.ts` (called from `register-default-pages.ts`).

That helper calls `registerPageMount` for:

- `bounties` → browse
- `bounties/new` → create
- `bounties/:id` → detail

## Adapters

`createDefaultBountyAdapter()` / `selectBountyAdapter()`:

| Mode | When | Behavior |
| --- | --- | --- |
| `fixture` (default) | `VITE_BOUNTY_CONTRACT_ID` empty | Demo fixtures; banner **Demo data — no funds or NFTs** |
| `live` | contract id set | View calls (`list_bounties`, `get_bounty`, `list_submissions`, `list_claims`); clear error if unset while forced live |

Funding CTA stays **disabled** unless `VITE_BOUNTY_FUNDING_ENABLED=true`. Even then the UI only confirms — wallet broadcast stays with F. MPOO is escrow liability; NEAR storage deposit is shown separately.

To re-register or override without touching wallet wiring:

```ts
import { registerBountyPagesWithShell } from "./register-stubs";
// or:
import { registerPageMount } from "../../app/page-registry";
import { mountBountiesListPage } from "./register-stubs";

registerPageMount("bounties", mountBountiesListPage);
```

Shared wallet + operations live on `ctx.services` and survive navigation.
