---
status: ready
priority: p2
issue_id: "021"
tags: [execution, wave-5, docs, state, operators, claude]
dependencies: ["018", "019", "020"]
---

## Problem Statement

Core operator docs still overclaim closure and capability status relative to runtime truth.

## Findings

- `state.md`, `CLAUDE.md`, `README.md`, and older remediation materials still contain outdated closure language
- the new grounding and execution artifacts should become the canonical frame
- docs should lag verified runtime truth, not lead it

## Recommended Action

1. Rewrite core operator docs after the capability waves are verified.
2. Remove or narrow stale green claims, outdated gate counts, and unsupported capability language.
3. Cross-link the final verified execution artifacts and support boundaries.

## Acceptance Criteria

- [ ] Core operator docs match verified runtime truth.
- [ ] No major doc still implies the old false-green closure story.
- [ ] Support boundaries and limitations are explicit where capabilities were narrowed.

