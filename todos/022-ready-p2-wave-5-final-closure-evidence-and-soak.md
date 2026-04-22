---
status: ready
priority: p2
issue_id: "022"
tags: [execution, wave-5, closure, soak, verification, issue-133]
dependencies: ["021"]
---

## Problem Statement

The umbrella issue should only close after there is durable evidence that the verified capability set holds in the live system.

## Findings

- earlier closure claims were made too early
- final closure needs evidence, not just code changes and doc edits
- doctor, health, project-state, and capability acceptance all need one final integrated verification pass

## Recommended Action

1. Run the final integrated verification and soak on the grounded capability set.
2. Record closure evidence in-repo and on issue `#133`.
3. Close the umbrella only when the evidence matches the claimed outcomes.

## Acceptance Criteria

- [ ] Final integrated verification evidence exists.
- [ ] Soak and regression outcomes support the claimed verified capability set.
- [ ] `#133` can close on evidence rather than narrative.
