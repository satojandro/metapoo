# 08 Acceptance Security and QA

## Product acceptance checklist

- [ ] Read-only visitor can load the board and understand the basic rules.
- [ ] Board dimensions and coordinate orientation are consistent across UI and contract.
- [ ] The agreed pixel ownership and overwrite rule is visible to users and enforced by the contract.
- [ ] If tenure is displayed, its start and end times come from authoritative successful writes; no payout is implied.
- [ ] Wallet connection and network mismatch are clearly handled.
- [ ] Invalid coordinate and palette inputs are rejected before transaction submission and by the contract.
- [ ] Wallet rejection, RPC failure, transaction failure, and slow confirmation show distinct recoverable states.
- [ ] The UI only shows success after observing the relevant successful transaction result and updated state.
- [ ] User can inspect a transaction reference or understand why one is unavailable.
- [ ] Keyboard and mobile users can select a pixel and color.
- [ ] No MVP flow requests MPOO or NEAR as an application payment.
- [ ] Sponsorship is off by default until budget, replay, abuse, and key-custody controls are reviewed.

## Security review

- [ ] Contract access control is minimal and documented.
- [ ] Coordinates, palette index, action size, storage growth, and event payloads are bounded.
- [ ] Repeated calls, duplicate submissions, and stale frontend state cannot violate the pixel rule.
- [ ] Any future tenure accounting has finite per-pixel, per-account, and season limits; the MVP makes no token payouts.
- [ ] Administrative updates and pause behavior are constrained, observable, and recoverable.
- [ ] Sponsor signatures are bound to account, contract, method, arguments, nonce, expiry, and network; replay protection is explicit.
- [ ] Sponsor has per-account, per-action, daily, and total spend ceilings, plus alerting and a kill switch.
- [ ] Sponsor signing keys are not shipped to the browser or committed.
- [ ] Third-party RPC, wallet, indexer, and relayer failures are included in the threat model.
- [ ] Token transfer behavior and tax are treated as unverified until independently inspected.
- [ ] Treasury custody, creator fee routing, and rage quit are excluded until separately reviewed.

## QA plan

- Contract: unit tests for normal draw, ownership transitions, bounds, invalid color, repeated action, admin access, and event/state agreement.
- Integration: local or sandbox flow from wallet action through contract state to board refresh.
- Frontend: read-only, connected, rejected, pending, success, failure, network mismatch, narrow viewport, keyboard-only selection, and empty board.
- Sponsor (later phase): exhausted budget, expired signature, replay attempt, wrong method/args, concurrent requests, and sponsor unavailable.
- Release: inspect built configuration, contract account, network, wallet origin, and deployed code hash before any public claim.

## Evidence levels in reports

1. Mock/UI simulation.
2. Local contract or sandbox.
3. Testnet transaction.
4. Mainnet read-only inspection.
5. Successful live user journey.

Agents must label evidence precisely. A test passing at one level does not establish a higher level. A transaction receipt alone does not prove the board rendered the intended state or that an economic action completed.

