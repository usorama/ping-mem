---
status: ready
priority: p1
issue_id: "009"
tags: [execution, wave-0, docs, freeze, issue-133]
dependencies: ["003"]
---

## Problem Statement

Wave 0 captured the live truth baseline, but the repo still needs an explicit freeze task that ties the baseline to the umbrella issue and invalidates stale closure claims.

## Findings

- the baseline exists at `docs/plans/2026-04-22-wave-0-truth-baseline.md`
- `state.md` and older remediation materials still imply green closure
- issue `#133` is the umbrella tracker, but later execution needs one stable freeze reference

## Recommended Action

1. Keep the baseline artifact, grounding plan, execution waves doc, and issue `#133` cross-linked.
2. Record stale-claim invalidation explicitly so later waves do not regress into outdated assumptions.
3. Treat this todo as complete only when the new execution model is the canonical operator frame.

## Acceptance Criteria

- [ ] Baseline, grounding plan, execution waves doc, and `#133` reference the same scope and wave model.
- [ ] Stale closure claims are explicitly displaced by the new execution baseline.
- [ ] Later waves can rely on the freeze without reopening Wave 0 framing work.

