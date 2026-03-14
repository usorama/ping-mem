# Lessons Learned — Code Structural Intelligence Plan

**Date**: 2026-03-09
**Plan**: docs/plans/2026-03-09-code-structural-intelligence.md
**Workflow**: deterministic-plan v2.0
**Iterations**: eval_iteration: 1, review_iteration: 1, verification_iteration: 1

---

## What Worked Well

### 1. VERIFY step caught real implementation bugs (4 critical/high)
The 4-agent VERIFY pass caught 2 critical bugs that would have caused compilation errors:
- `IngestionResult`/`CodeFileResult` import location: both live in `IngestionOrchestrator.ts`, NOT `types.ts`. Without VERIFY, the first compile would fail with "Cannot find module".
- `isTest` write location: the plan said "written at persist time" but never specified WHERE. Without this fix, `queryHotspots` would return 0 rows silently — the hardest class of bug to diagnose.

**Learning**: VERIFY is the most valuable step for TypeScript plans. Import locations and schema write gaps are exactly the bugs that pass EVAL/REVIEW but fail at compile time.

### 2. REVIEW scope reductions saved ~320 LOC
Three YAGNI cuts accepted from the simplicity reviewer:
- Removing EXPORTS edges (no v1 query used them)
- Deferring temporal coupling (O(N²) in-memory computation)
- Inlining BlastRadiusScorer into TemporalCodeGraph (single-use class)

These reductions also eliminated 2 architectural bugs (the `persistTemporalCoupling` atomicity issue became moot; the `queryFileSymbols` silent failure from untracked `isExported` was caught before writing any code).

**Learning**: The simplicity reviewer catches speculative schema/type additions before they become dead code in the final implementation.

### 3. Architecture reviewer caught project-scoping bug early
The cross-project contamination bug in `queryTransitiveImpact` and blast radius queries would have produced wrong answers in multi-project deployments — correct but subtly wrong results, not a crash. These are the hardest bugs to catch in testing because single-project test setups never trigger them.

**Learning**: Always run a "graph traversal scope" checker on Neo4j queries in multi-tenant designs. Pattern: every `MATCH (:File)` should be prefixed with `(p:Project)-[:HAS_FILE]->`.

---

## What Could Improve

### 1. Type location research should be a Phase 0 step
The VERIFY bug about `IngestionResult` being in `IngestionOrchestrator.ts` (not `types.ts`) could have been caught in RESEARCH by simply reading the actual `types.ts` exports. Future plans should include a "type inventory" step: `grep "^export " src/ingest/types.ts` before specifying function signatures.

### 2. Blast radius `isTest` was mentioned without a write anchor
Q6 said "each File node gains `isTest: boolean`" but the implementation phases didn't call out the modification to `persistFilesBatch`. This pattern recurs: plan says a property "is written" without saying which existing function writes it. Future plans should have a rule: every new Neo4j property must name the exact `persist*Batch()` method that writes it.

### 3. TS API verification agent was noisy (2 false positives)
The TS API agent flagged `ExportNamedDeclaration` and `ExportAllDeclaration` as CRITICAL bugs, but the plan already used the correct names. The agent was checking a list of "potential mistakes" rather than verifying actual plan claims. Future verification agents should extract exact claims from the plan text first, not check hypothetical failure modes.

---

## Bugs Found Per Validation Pass

| Pass | Bugs Found | Severity Breakdown |
|------|-----------|-------------------|
| EVAL (iteration 1) | 12 | 4 CRITICAL, 5 HIGH, 3 MEDIUM |
| REVIEW (iteration 1) | 20 | 6 scope reductions, 8 arch bugs, 4 TS bugs + 2 moot |
| VERIFY (iteration 1) | 9 | 2 real critical, 2 real medium, 5 false positives/no-ops |
| **Total** | **41** | All addressed before implementation |

---

## Quality Standards Updates

### New standard: "property write anchor"
Every new Neo4j node property in a plan must name the exact `persist*Batch()` method (and `buildParams` expression) that writes it. Example:
> "`f.isTest` is written in `persistFilesBatch` items mapping: `isTest: /\.(?:test|spec)\.[tj]sx?$/.test(f.filePath) || f.filePath.includes('/__tests__/')`"

### New standard: "import source annotation"
Every new class that takes an existing type as parameter must name the exact import path. Example:
> "Imports: `IngestionResult` from `src/ingest/IngestionOrchestrator.ts` (NOT types.ts)"

### Reinforced standard: "multi-tenant query scoping"
Every Neo4j query that touches `File`, `Chunk`, `Symbol`, or `Commit` nodes must be prefixed with a `(p:Project { projectId: $projectId })` anchor. No exceptions.

---

## Time Estimation (for calibration)

| Step | Estimated | Notes |
|------|-----------|-------|
| RESEARCH (6 parallel agents) | ~45 min | 6 docs, ~350KB research |
| SYNTHESIZE | ~20 min | Founding principles + ADRs + gap analysis |
| SPECFLOW | ~15 min | Identified 12 edge cases, most already answered |
| PLAN draft | ~60 min | Dense implementation spec |
| EVAL (3 agents) | ~30 min | 12 bugs found |
| AMEND (post-EVAL) | ~45 min | All bugs fixed |
| REVIEW (3 agents) | ~30 min | 20 findings |
| AMEND (post-REVIEW) | ~60 min | All findings addressed |
| VERIFY (4 agents) | ~20 min | 9 findings (2 real) |
| FIX (post-VERIFY) | ~15 min | 4 amendments |
| LESSONS + PACKAGE | ~20 min | This document |
| **Total** | **~6 hours** | For a 4-day implementation plan |
