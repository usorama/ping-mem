---
status: ready
priority: p1
issue_id: "014"
tags: [execution, wave-2, runtime, reconciliation, orbstack, neo4j, qdrant]
dependencies: ["001", "002", "012", "013"]
---

## Problem Statement

The live OrbStack-backed project fleet still contains stale rows and old data debt that must be reconciled against the fixed codepaths.

## Findings

- live `/api/v1/codebase/projects` still showed 40 rows with 19 zero-file rows during the baseline
- old project shells and alias rows remained from pre-fix ingestion behavior
- deterministic fixes do not become true in production until the live fleet is cleaned and re-ingested

## Recommended Action

1. Delete stale live project rows on the repaired delete path.
2. Re-ingest the authoritative active project set with the new scoped-identity/full-history code.
3. Recheck project counts, zero-file rows, doctor freshness, and cross-repo behavior.

## Acceptance Criteria

- [ ] Stale live rows are removed without manual graph surgery.
- [ ] Active repos are re-ingested under the current deterministic model.
- [ ] Project counts, freshness, and zero-file debt are materially reduced and explained.

