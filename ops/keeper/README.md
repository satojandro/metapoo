# Revenue keeper

Work order REV-F ([`revenue-keeper.task.json`](../../docs/implementation/revenue-keeper.task.json)).
Spec: [paid board revision](../../docs/payments/2026-11-01-paid-board-revision-spec.md), sections
R1, R2 and "Automation".

A NEAR contract can't run on a timer. Once an hour this script sends two transactions to the board:
`distribute_near()` and `distribute_mpoo()`. Both take no arguments and anyone may call them. The
contract rejects a call made before the 1-hour interval has passed. The keeper counts that as
success.

If the keeper stops, nothing is lost. Revenue waits on the board and the next call (from the keeper
or anyone else) sends all of it.

**Status:** code written against the spec. The methods don't exist yet (REV-D). Nothing here has
run against a chain.

## What it does

1. Reads its configuration from environment variables (below) and checks it before signing anything.
2. Calls `distribute_near`, then `distribute_mpoo`, each with no deposit and modest prepaid gas. A
   failure of the first call doesn't stop the second.
3. Prints one JSON line per call:

   ```json
   {"ts":"2026-11-02T10:17:03.120Z","network":"testnet","contract":"board3.example.testnet","keeper":"keeper.example.testnet","method":"distribute_near","gasTgas":50,"outcome":"distributed","txHash":"9xQd…"}
   ```

   `outcome` is one of:

   | outcome | meaning |
   |---|---|
   | `distributed` | the transaction succeeded. `failedReceipts: n` is added if some outgoing transfers failed inside it. The contract's callbacks restore those amounts and the next run retries them, but a number that keeps appearing (for example, the team account isn't registered for storage on the mPOO contract) needs a look |
   | `too_soon` | the contract rejected the call with `DistributionTooSoon`. Normal if someone else distributed this hour, or if the scheduler ran early relative to the last run |
   | `failed` | anything else: RPC down, allowance used up, out of gas, a contract panic. `detail` holds the error |

4. Exits **1 only if both calls failed** (`failed`, not `too_soon`). Exits 2 on a configuration
   error. Otherwise exits 0.

The error code is the constant `TOO_SOON_CODE` in [`src/classify.js`](src/classify.js). If REV-D
names the error differently, change that one line.

## Configuration

| variable | required | notes |
|---|---|---|
| `KEEPER_NETWORK` | yes | `testnet` or `mainnet`. Account ids ending in the other network's suffix are rejected |
| `KEEPER_RPC_URL` | no | defaults to `https://rpc.testnet.near.org` / `https://rpc.mainnet.near.org` |
| `KEEPER_BOARD_CONTRACT_ID` | yes | the board contract, e.g. board3 on testnet |
| `KEEPER_ACCOUNT_ID` | yes | the dedicated keeper account (below) |
| `KEEPER_PRIVATE_KEY` | yes | `ed25519:…` private key of the keeper's **function-call** key. Comes from a secret env var only. Never put it in a file in this repo |
| `KEEPER_GAS_NEAR_TGAS` | no | prepaid gas for `distribute_near`, default 50 |
| `KEEPER_GAS_MPOO_TGAS` | no | prepaid gas for `distribute_mpoo`, default 150 (three `ft_transfer` legs plus callbacks) |

The gas defaults are guesses until the testnet rehearsal measures them. Unused gas is refunded.

The script never prints the key. Configuration errors name the variable but not its value.

## The keeper account and its key

The keeper gets **its own account**. Its signing key is a **function-call access key** that can only
call `distribute_near` and `distribute_mpoo` on the board, can't attach a deposit, and has a small
allowance. If that key leaks, all an attacker can do is pay gas to trigger distributions, and those
are open to everyone anyway.

> **Verify these commands against the current near-cli-rs docs before running them**
> (`near --version`, then `near account add-key --help`). Flag names have changed between
> releases. They are written for near-cli-rs 0.x as of late 2026 and haven't been run in this repo.

Replace `OWNER.testnet` with the owner's account and `board3.OWNER.testnet` with the board.

**1. Create the account.** The owner funds it. The full-access key goes into the owner's keychain
and is never used by the keeper.

```sh
near account create-account fund-myself keeper.OWNER.testnet '2 NEAR' \
  autogenerate-new-keypair save-to-keychain \
  sign-as OWNER.testnet network-config testnet sign-with-keychain send
```

**2. Generate the keeper's key locally**, without printing the private half to the terminal:

```sh
cd ops/keeper && npm ci
node -e "import('near-api-js').then(({KeyPair})=>{const k=KeyPair.fromRandom('ed25519');process.stderr.write(k.getPublicKey().toString()+'\n');process.stdout.write(k.toString())})" \
  | gh secret set KEEPER_PRIVATE_KEY      # stdout (private) goes straight to the repo secret
# the public key (ed25519:…) is printed on stderr: use it in step 3
```

For a local run instead, write stdout to a file outside the repo with mode 600, for example
`~/.config/metapoo/keeper.key`.

**3. Add it as a function-call key** limited to the two methods, with a small allowance:

```sh
near account add-key keeper.OWNER.testnet \
  grant-function-call-access \
    --allowance '1 NEAR' \
    --receiver-account-id board3.OWNER.testnet \
    --method-names 'distribute_near, distribute_mpoo' \
  use-manually-provided-public-key ed25519:<PUBLIC_KEY_FROM_STEP_2> \
  network-config testnet sign-with-keychain send
```

**4. Check it.** Expect `FunctionCall` permission, the board as receiver, and exactly the two methods:

```sh
near account list-keys keeper.OWNER.testnet network-config testnet now
```

**Rotating or retiring the key:** add a new one as in steps 2–3, then delete the old one:

```sh
near account delete-keys keeper.OWNER.testnet public-keys ed25519:<OLD_PUBLIC_KEY> \
  network-config testnet sign-with-keychain send
```

### Sizing the allowance

The allowance is a **lifetime budget** for the key. Each transaction's gas cost is subtracted from
it. Each call also needs `prepaid gas × gas price` of allowance left: 100 TGas at the minimum gas
price is 0.01 NEAR. The spec estimates 0.001–0.005 NEAR burned per call. Two calls an hour is 48
a day, so roughly 0.05–0.25 NEAR a day. A 1 NEAR allowance lasts about 4–20 days.

When the allowance runs out, both calls fail with `NotEnoughAllowance`, the run goes red, and you
rotate the key. Treat that as the intended way to check in on the keeper. After the testnet run
has measured real gas, re-size the allowance. The account's balance must also cover the gas. The
allowance only caps spending, it doesn't fund it.

## Running it locally

```sh
cd ops/keeper
npm ci
npm test                     # unit tests, no network

export KEEPER_NETWORK=testnet
export KEEPER_BOARD_CONTRACT_ID=board3.OWNER.testnet
export KEEPER_ACCOUNT_ID=keeper.OWNER.testnet
export KEEPER_PRIVATE_KEY="$(cat ~/.config/metapoo/keeper.key)"   # outside the repo
npm start
echo "exit=$?"
```

Requires Node 22. `near-api-js` is pinned to an exact version in `package.json`, with a lockfile.

## Scheduling: GitHub Actions (chosen)

[`.github/workflows/keeper.yml`](../../.github/workflows/keeper.yml) runs hourly at minute 17,
and can also be started by hand ("Run workflow"). **The job is skipped unless the repository
variable `KEEPER_ENABLED` is `true`**, so merging the workflow does nothing.

To switch it on (after REV-D is deployed to testnet and the key exists):

```sh
gh variable set KEEPER_NETWORK            --body testnet
gh variable set KEEPER_BOARD_CONTRACT_ID  --body board3.OWNER.testnet
gh variable set KEEPER_ACCOUNT_ID         --body keeper.OWNER.testnet
# KEEPER_PRIVATE_KEY secret: set in step 2 above
gh workflow run keeper.yml                 # one manual run first; read the log
gh variable set KEEPER_ENABLED            --body true
```

Why Actions:

- No server to keep alive or patch, and the key lives in GitHub's secret store rather than on a disk.
- Every run's log keeps the JSON lines with transaction hashes (retained 90 days by default). That
  is the evidence the acceptance criterion asks for ("24 h with hashes in the log").
- A failed run is visible on the Actions tab and triggers an email without extra tooling.

Known costs:

- GitHub's cron is best-effort. Runs can be late by many minutes, and occasionally skipped under
  load. Because the contract interval is exactly 1 hour, a run that comes early after a late one
  gets `too_soon`, and that hour's revenue goes out on the next run. Nothing is lost. The real
  cadence is between one and two hours. If that matters, change the cron to every 30 minutes. The
  extra calls return `too_soon` and burn a little gas.
- On a public repository, GitHub disables scheduled workflows after 60 days with no repository
  activity. It emails a warning first. Re-enable on the Actions tab.
- Scheduled runs use the workflow file on the default branch only.

### Alternative: cron on Hermes's server

The same script runs from cron without changes. Use this if Actions' timing gets in the way, or the
repo goes quiet for months:

```cron
# /etc/cron.d/metapoo-keeper: env file is outside the repo, owned by the keeper user, mode 600
17 * * * * keeper cd /opt/metapoo/ops/keeper && set -a && . /etc/metapoo-keeper.env && set +a && node src/main.js >> /var/log/metapoo-keeper.log 2>&1
```

What you gain: exact timing, no inactivity cut-off. What you take on: the key sits on a server
disk, you keep the host and Node updated, you rotate the log, and alerting is yours to build. For
example, a watcher that pages when the last three runs each ended with `"outcome":"failed"` on both
lines.

## Alerting

- **A failed run is the alert.** The script exits non-zero only when both calls failed for a real
  reason, so the workflow goes red only then. A `too_soon` hour stays green.
- **GitHub emails on failed scheduled runs.** The email goes to the user who last changed the
  workflow's `cron` line, if they have Actions failure notifications on (Settings → Notifications →
  Actions; "Only notify for failed workflows" is enough). Whoever should be alerted should make the
  most recent edit to the schedule.
- **Suggested rule: act on three failed runs in a row.** One red run is usually a public RPC hiccup.
  Three in a row (about 3 hours with no distribution) means something is wrong: allowance used up,
  key removed, the contract changed, or the keeper account is out of NEAR. To check quickly:

  ```sh
  gh run list --workflow keeper.yml --limit 3 --json conclusion,createdAt
  ```

  If the hiccups get noisy, the next step is a final workflow step that only fails when the
  previous two runs also failed. Not built yet.

## Staking sync (TR-S)

The board pays the stakers' share to the staking contract
([`contracts/toilet-staking`](../../contracts/toilet-staking/README.md)) with a plain `ft_transfer`, so
the staking contract only counts it when someone calls its `sync_inflow()`. With the flag below set,
the keeper does that right after a `distribute_mpoo` whose outcome is `distributed`, and logs a third
JSON line (`"method":"sync_inflow"`, `"contract"` = the staking contract). It never syncs after
`too_soon` or `failed`. A failed sync is logged and does not change the exit code: the next sync, by
anyone, counts the same mPOO.

**Off by default.** Leave it unset until the board's `set_staking_contract` has been called.

| variable | required | notes |
|---|---|---|
| `KEEPER_STAKING_CONTRACT_ID` | no | the staking contract. Setting it switches the sync on |
| `KEEPER_STAKING_PRIVATE_KEY` | when the above is set | a **second** function-call key on the same keeper account. A function-call key names one receiver, so the board key can't call the staking contract |
| `KEEPER_GAS_SYNC_TGAS` | no | prepaid gas for `sync_inflow`, default 50. The contract refuses less than 40 |

Add the second key as in steps 2–3 above, with `--receiver-account-id <staking contract>` and
`--method-names 'sync_inflow'`. On GitHub Actions, [`keeper.yml`](../../.github/workflows/keeper.yml)
passes the variable `KEEPER_STAKING_CONTRACT_ID` (and optional `KEEPER_GAS_SYNC_TGAS`) and the secret
`KEEPER_STAKING_PRIVATE_KEY`; an unset variable arrives empty, which keeps the sync off.

## Tests

```sh
cd ops/keeper && npm test
```

`node:test`, no network. They cover outcome classification (success, success with failed
receipts, `DistributionTooSoon` in a failure status or a thrown error, other failures), the
exit-code rule, configuration validation (missing or invalid values, network suffix mismatch, gas
bounds, the key never echoed or serialised), the run loop against a mocked NEAR client, and the
exact function-call action built with the real `near-api-js` (no network).

## Must be verified on testnet (REV-E)

- The real error text for an early call contains `DistributionTooSoon`. If not, change `TOO_SOON_CODE`.
- Gas actually used by each method, so the defaults and the allowance can be re-sized.
- `failedReceipts` shows up as expected when a transfer fails, e.g. the team account isn't
  registered for storage on the mPOO contract.
- The near-cli-rs commands above, the key's permissions shown by `list-keys`, and that a call to
  any other method with this key is refused.
- 24 hours of runs with transaction hashes in the Actions log (the acceptance criterion).
