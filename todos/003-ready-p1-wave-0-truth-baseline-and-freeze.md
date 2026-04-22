---
status: ready
priority: p1
issue_id: "003"
tags: [execution, wave-0, baseline, observability, planning]
dependencies: []
---

## Problem Statement

ping-mem still lacks a frozen evidence baseline for the current live system, while `state.md` and older remediation artifacts still imply full closure.

Without a truth-baseline wave, every later change risks arguing with stale claims instead of measured reality.

## Findings

- `state.md` still claims all 8 phases are closed and all gates are green.
- the live system has already shown contradictory facts: degraded `/health`, historical graph debt, session ambiguity warnings, and post-remediation deterministic ingestion fixes not reflected in operator docs
- umbrella scope now exists in `docs/plans/2026-04-22-fix-deterministic-capability-grounding-plan.md`
- execution sequencing now exists in `docs/plans/2026-04-22-deterministic-capability-execution-waves.md`

## Proposed Solutions

### Option A

Proceed directly into fixes without a new baseline.

- Pros: faster apparent movement
- Cons: guarantees more scope drift and repeated rediscovery

### Option B

Capture one evidence baseline and freeze issue-to-wave ownership before further execution.

- Pros: reduces rediscovery and gives every later wave a stable starting point
- Cons: delays implementation work slightly

## Recommended Action

Execute Option B.

1. Capture current evidence for health, doctor, `/ui/health`, active project rows, session state, canonical search/regression behavior, and graph quality.
2. Record which claims in `state.md` and older remediation docs are invalid.
3. Keep issue `#133`, the grounding plan, the execution-waves doc, and the todo set aligned before further implementation.

## Acceptance Criteria

- [ ] A current live evidence baseline exists and is stored in repo documentation.
- [ ] Every known in-scope issue is mapped to a wave or explicitly marked out-of-scope.
- [ ] `#133`, the grounding plan, and the execution-waves doc reference the same execution model.
- [ ] Future work can start from Wave 1 without re-discovering the scope frame.

## Work Log

### 2026-04-22 - Wave created

**By:** Codex

**Actions:**
- Created the wave-based execution model and linked it to the grounding plan.
- Positioned Wave 0 as the mandatory freeze line before further fixes.

**Learnings:**
- The earlier rediscovery pattern was primarily a missing execution freeze, not just missing bugs.

### 2026-04-22 - Live baseline captured

**By:** Codex

**Actions:**
- Captured live `/health`, doctor, `/ui/health`, project-list, session, and regression evidence from the running stack.
- Verified current code paths behind health semantics, session ambiguity handling, historical-vs-live UI health behavior, manifest short-circuiting, structural-edge persistence, and low-memory delete behavior.
- Wrote the baseline artifact at [docs/plans/2026-04-22-wave-0-truth-baseline.md](/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-22-wave-0-truth-baseline.md).

**Learnings:**
- The runtime is materially not green: doctor is 27/34 pass with 7 failures, `/health` is degraded, project rows are not converged, and session/search truth differs across surfaces.
- Wave 1 is now clearly the correct next execution target.
