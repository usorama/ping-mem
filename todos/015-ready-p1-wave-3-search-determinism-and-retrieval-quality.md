---
status: ready
priority: p1
issue_id: "015"
tags: [execution, wave-3, search, retrieval, ranking, filters]
dependencies: ["014"]
---

## Problem Statement

Search is a core product surface, and deterministic acceptance must cover ranking, filters, and empty-result behavior rather than only happy-path hits.

## Findings

- doctor regressions still had failing search queries after Wave 1 recovery
- open issue `#94` already captures one empty-result failure mode
- current scope requires separate grounding for memory search, code search, hybrid search, and knowledge search

## Recommended Action

1. Define deterministic acceptance gates for each search surface.
2. Fix or narrow empty-result, low-score, and filter/ranking behavior.
3. Verify the final behavior from supported routes, not just internals.

## Acceptance Criteria

- [ ] Memory, code, hybrid, and knowledge search each have explicit acceptance checks.
- [ ] Known silent-empty or zero-score failure modes are closed or demoted from claims.
- [ ] Search regression queries pass reliably on reconciled live state.

