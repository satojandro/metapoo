# Art Bounties pages (Worker G)

Frontend integrator F registers these via `registerBountyPageStubs()` from
`register-stubs.ts` (called from `register-default-pages.ts`).

That helper calls `registerPageMount` for:

- `bounties` → browse
- `bounties/new` → create
- `bounties/:id` → detail

To re-register or override without touching wallet wiring:

```ts
import { registerBountyPagesWithShell } from "./register-stubs";
// or:
import { registerPageMount } from "../../app/page-registry";
import { mountBountiesListPage } from "./register-stubs";

registerPageMount("bounties", mountBountiesListPage);
```

Shared wallet + operations live on `ctx.services` and survive navigation.
