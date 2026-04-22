---
status: ready
priority: p2
issue_id: "008"
tags: [execution, wave-5, docs, operators, handoff]
dependencies: ["004", "005", "006", "007"]
---

## Problem Statement

ping-mem’s operator-facing docs still overstate closure and mix old remediation claims with newer runtime reality.

## Findings

- `state.md` is materially false relative to current live evidence
- `agents.md`, `CLAUDE.md`, `README.md`, `docs/AGENT_INTEGRATION_GUIDE.md`, and older verification summaries still need reconciliation
- without a final operator-truth wave, future work will continue inheriting misleading starting assumptions

## Proposed Solutions

### Option A

Patch docs incrementally during implementation.

- Pros: small local updates
- Cons: narrative drifts and contradictory docs linger longer

### Option B

Reserve a final operator-truth wave to reconcile all primary docs after runtime truth and capability acceptance are stable.

- Pros: cleaner closure and more honest handoff
- Cons: some stale docs remain until later waves finish

## Recommended Action

Execute Option B.

1. Rewrite `state.md` after Waves 1-4 establish the real baseline.
2. Reconcile operator-facing docs and agent handoff docs together.
3. Leave a clean execution handoff for later delegated implementation.

## Acceptance Criteria

- [ ] Primary operator docs match runtime truth.
- [ ] The old false-green closure story is removed from active repo guidance.
- [ ] Future agents can start from `agents.md`, the grounding plan, and the execution-waves doc without rediscovery.

## Work Log

### 2026-04-22 - Wave created

**By:** Codex

**Actions:**
- Created a final documentation wave rather than letting stale docs linger as informal cleanup.
- Tied operator-truth reconciliation to the completion of earlier runtime and capability waves.

**Learnings:**
- Documentation truth is a closure criterion here, not a cosmetic follow-up.

### 2026-04-22 - Active operator docs reconciled to unified-server truth

**By:** Codex

**Actions:**
- Updated `README.md`, `CLAUDE.md`, `docs/AGENT_INTEGRATION_GUIDE.md`, `docs/claude/deployment.md`, and `docs/claude/api-contract.md`.
- Removed the stale dual-port guidance from active entry-point docs.
- Reframed local client guidance around `dist/mcp/proxy-cli.js` as the recommended path when the shared server is already running.

**Learnings:**
- The most damaging doc drift was in the first-hop guidance, not the archival research/planning set.
- Wave 5 still needs broader historical cleanup, but the active operator path is now much less likely to reintroduce old assumptions.
