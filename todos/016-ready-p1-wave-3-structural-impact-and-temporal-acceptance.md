---
status: ready
priority: p1
issue_id: "016"
tags: [execution, wave-3, structural, impact, blast-radius, temporal]
dependencies: ["014"]
---

## Problem Statement

Structural and temporal code-intelligence claims are only meaningful if they are proven on real repositories after reconciliation.

## Findings

- Python structural extraction now exists, but broad live acceptance is still open
- impact and blast-radius queries depend on structural correctness and may still hide truncation or stale-state risks
- temporal/time-aware claims need proof or narrowing

## Recommended Action

1. Run structural, impact, blast-radius, and timeline acceptance across multiple active repos.
2. Close any remaining truncation, stale-edge, or historical-query gaps.
3. Narrow unsupported temporal claims if they cannot be proven deterministically.

## Acceptance Criteria

- [ ] Structural dependency answers are correct on real repos.
- [ ] Impact and blast-radius queries do not silently truncate or drift.
- [ ] Time-aware query claims are verified or explicitly narrowed.

