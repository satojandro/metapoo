# 04 Cursor Parallel-Agent Orchestration

## Purpose

Parallel work is useful when agents own distinct files and agree on an interface first. It creates confusion when several agents invent the data model or edit the same integration at once. The human coordinator owns shared decisions and final integration.

## Before dispatch

1. Read the repository README, package manifests, existing contract and frontend code, tests, deployment scripts, and local agent instructions.
2. Write the pixel ownership rule, board dimensions, palette, network for local development, and contract/frontend interface in a short shared decision record.
3. Identify files each agent may edit and files that are integration-owned.
4. Create a clean branch or worktree for each agent if Cursor supports it; otherwise assign disjoint file ownership.
5. Paste only the agent's brief plus relevant project context. Do not copy unverified token claims as verified facts.
6. Ask each agent to report assumptions, changed files, verification performed, and unresolved risks.

## Suggested parallel lanes

- Contract agent: state model, bounded draw action, event design, tests, and local deployment instructions.
- Frontend agent: board interaction, wallet flow, transaction status, responsive layout, and adapter boundary against the agreed interface.
- Chain-abstraction research agent: short decision memo only. No production implementation and no edits to shared MVP interfaces unless the coordinator accepts the recommendation.

## Integration sequence

1. Coordinator settles the contract/frontend interface from the agent proposals.
2. Contract agent implements and supplies a working local/test contract plus example calls.
3. Frontend agent wires to that interface and stubs unavailable methods clearly.
4. Research agent presents options, risks, source links, and a recommendation; this remains non-blocking.
5. Coordinator integrates one change at a time, resolves conflicts, and checks that the experience matches contract behavior.
6. Run the acceptance and security checklist. Deploy only to the intended environment after an explicit review of configuration and keys.

## Shared protocol for agent updates

Every handoff should include:

- Goal and non-goals.
- Files the agent owns and files it must not change.
- Accepted assumptions and open questions.
- Interface contract and example payload/result.
- Definition of done.
- Required verification and exact environment.
- Risks or decisions that need the coordinator.

Agents must not silently expand scope, add payment flows, edit secrets, commit or deploy to mainnet, alter token addresses, or claim live verification without evidence. If an interface change is necessary, pause that change and propose it with migration impact.

## Definition of ready for integration

An agent returns a concise summary, a list of changed files, commands or manual checks performed, screenshots or logs where useful, remaining defects, and whether the result is a mock, local implementation, testnet result, or live chain observation. A successful build is not proof of an on-chain user journey.

