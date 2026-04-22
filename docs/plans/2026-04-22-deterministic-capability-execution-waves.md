---
title: "fix: ping-mem deterministic capability execution waves"
type: execution
date: 2026-04-22
status: in_progress
parent_plan: docs/plans/2026-04-22-fix-deterministic-capability-grounding-plan.md
github_issue: 133
verification_method: "Wave ownership and issue mapping derived from the grounding plan, current open issue set, runtime findings, and existing todo artifacts"
---

# ping-mem Deterministic Capability Execution Waves

This document is the execution companion to [docs/plans/2026-04-22-fix-deterministic-capability-grounding-plan.md](/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-22-fix-deterministic-capability-grounding-plan.md).

Use the grounding plan for capability scope and blast radius.
Use this document for sequencing, issue-to-wave mapping, and task ownership.

## Execution Rule

Advance wave-by-wave.

- do not mark a wave complete on code alone
- do not start a downstream wave on a false-green upstream surface
- if implementation discovers new work, attach it to an existing capability family and wave before creating a new stream

## Wave Summary

| Wave | Goal | Primary outcomes | Depends on |
|---|---|---|---|
| Wave 0 | Truth baseline and freeze | O5, O8 | none |
| Wave 1 | Operational truth | O5, O6, O7 | Wave 0 |
| Wave 2 | State convergence | O2, O3, O4, O13 | Wave 1 |
| Wave 3 | Capability correctness and acceptance | O1, O2, O3, O7, O9, O14 | Wave 2 |
| Wave 4 | Declared surface and environment parity | O6, O10, O11, O12 | Wave 3 |
| Wave 5 | Documentation and operator truth | O8 and closure criteria | Waves 1-4 |

## Outcomes Carried Forward

The grounding plan defines outcomes `O1` through `O10`. This execution view extends the same model with four explicit operational outcomes that were implicit in the broader plan:

| Outcome | Meaning |
|---|---|
| O11 | deployment and runtime modes do not silently redefine supported behavior |
| O12 | tool surfaces are verified proportionally to their claim level |
| O13 | ingestion corpus and audit state converge deterministically after cleanup or re-ingest |
| O14 | time-aware and snapshot query claims are either verified or narrowed |

## Execution Backlog

The wave todos `003` through `008` are the parent wave trackers.
Concrete execution tasks are tracked in `009` through `022`.

| Wave | Parent todos | Concrete execution todos |
|---|---|---|
| Wave 0 | `003` | `009` |
| Wave 1 | `004` | `010`, `011` |
| Wave 2 | `001`, `002`, `005` | `012`, `013`, `014` |
| Wave 3 | `006` | `015`, `016`, `017` |
| Wave 4 | `007` | `018`, `019`, `020` |
| Wave 5 | `008` | `021`, `022` |

## Wave Details

### Wave 0. Truth Baseline And Freeze

**Why first**

Every later green signal is suspect until the repo has one frozen evidence baseline and the stale closure story is explicitly displaced.

**Scope**

- capture current live truth for `/health`, `doctor`, `/ui/health`, project rows, active sessions, canonical regression queries, search behavior, orphan/quality state, and deployment-health surfaces
- identify which claims in `state.md`, remediation docs, and operational guides are invalid now
- freeze the issue map and wave ownership so later work does not drift

**Acceptance**

- a reproducible evidence snapshot exists for the current runtime
- all currently known open issues are assigned to a wave or explicitly declared out-of-scope
- the umbrella issue and repo execution docs reference the same wave structure

**Primary repo todos**

- `003-ready-p1-wave-0-truth-baseline-and-freeze.md`

### Wave 1. Operational Truth

**Why now**

Health, doctor, readiness, and session semantics are upstream truth surfaces. If they lie, every downstream acceptance is noisy.

**Scope**

- fix or narrow `/health` semantics
- align `doctor`, `/ui/health`, `health:shallow`, readiness/status routes, and compose healthchecks
- fix or harden deterministic session semantics across REST, SSE, MCP, and shell routes
- tighten contract failures where clients currently get warnings instead of deterministic behavior

**Acceptance**

- live state semantics match health/dashboard/doctor outputs
- false-green healthchecks are gone
- session ambiguity is either eliminated or converted into an explicit hard contract

**Primary repo todos**

- `004-ready-p1-wave-1-operational-truth.md`

**Current status**

- live `/health` is `ok`
- live `doctor` is `34/34` pass on OrbStack
- session ambiguity is hardened on shell routes and no longer silently falls through

### Wave 2. State Convergence

**Why here**

Only after truth surfaces are credible should we reconcile graph/search/manifest state and trust the results.

**Scope**

- reconcile active project rows and orphan debt
- unify codebase delete and admin delete convergence semantics
- fix manifest and structural-edge cleanup mismatches
- re-ingest active projects intentionally where identity/history/storage fixes require it

**Acceptance**

- active projects are authoritative
- delete and re-ingest converge without manual Neo4j intervention
- manifest, graph, and search state no longer drift by route

**Primary repo todos**

- `001-ready-p1-deterministic-cross-repo-ingestion.md`
- `002-ready-p1-runtime-reingest-and-state-reconciliation.md`
- `005-ready-p1-wave-2-state-convergence-and-reconciliation.md`

**Current status**

- stale zero-file project rows were removed from the live fleet
- active projects were deliberately re-ingested
- SQLite durability for core/admin/diagnostics stores was hardened
- queue/admin-store reconciliation now persists and survives restart

### Wave 3. Capability Correctness And Acceptance

**Why after convergence**

This is where the product either proves deterministic outcomes or narrows its claims.

**Scope**

- verify memory sync and recall determinism from real entry points
- verify cross-repo ingestion, structural dependency, impact, blast-radius, and historical-query correctness
- ground code search, memory search, hybrid search, and knowledge search semantics
- add route-level and behavior-level acceptance, not just payload-shape tests

**Acceptance**

- canonical and non-trivial capability checks pass from supported user entry points
- search behavior has explicit deterministic acceptance gates
- temporal/snapshot claims are verified or narrowed

**Primary repo todos**

- `006-ready-p1-wave-3-capability-correctness-and-acceptance.md`

**Current status**

- canonical regression acceptance is now restart-stable on OrbStack
- doctor-backed regression proof is green after a live container restart
- `scripts/test-all-capabilities.sh` is green (`54/54`)
- `scripts/agent-path-audit.sh` is green
- `scripts/mcp-smoke-test.sh` now exercises the full 53-tool MCP surface by exact name and is green (`58 PASS / 0 FAIL / 0 SKIP`, including observability extras)
- `#94` was re-audited and closed with regression proof in `src/search/__tests__/CodeIndexer.test.ts`; the tied-score empty-result bug is not present in the current `CodeIndexer`
- structural impact and blast-radius surfaces now expose `truncated` and caller-controlled `maxResults`, so callers no longer receive silent partial answers when result caps are hit
- broader capability proof work still remains for the yet-unclosed Wave 4 / Wave 5 surfaces, not the core Wave 3 acceptance harnesses

### Wave 4. Declared Surface And Environment Parity

**Why later**

Once core outcomes are grounded, unverified peripheral claims can be triaged without polluting the earlier acceptance signal.

**Scope**

- classify advanced subsystems and tool families as verified, weakly verified, partial, dormant, or docs-only
- verify deployment parity across local Docker, direct mode, proxy mode, and production assumptions
- cover diagnostics/worklog, extractor/runtime wiring, transcript mining, dreaming/event loops, shell daemon/hooks, admin/auth, SDK/transport, and SSE security/rate limiting

**Acceptance**

- declared surface area is supportable or demoted
- deployment mode boundaries are explicit and truthful
- issue backlog for advanced surfaces is grounded in capability categories rather than scattered symptoms

**Primary repo todos**

- `007-ready-p2-wave-4-declared-surface-and-environment-parity.md`

**Current status**

- focused transport parity checks are green: `src/http/__tests__/sse-parity.test.ts` and `src/http/__tests__/cors-security.test.ts`
- `/mcp` now has direct security-header and rate-limit coverage in `src/http/__tests__/sse-security.test.ts`
- live OrbStack verification is green after redeploy: `/health` is `ok`, `doctor` is `34/34`, `/mcp` returns security headers on `OPTIONS`, and authenticated burst traffic now reaches `429`
- stale Wave 4 backlog has started to collapse: `#96`, `#97`, `#98`, `#99`, `#101`, `#102`, `#121`, and `#122` are now closed as implemented, activated, or fixed-and-verified
- active operator docs were reconciled to the real unified-server model:
  single listener on `:3003`, MCP streamable HTTP at `/mcp`, and app SSE at `/api/v1/events/stream`
- proxy CLI is now the documented recommended local MCP path against a running OrbStack or Docker server
- Mining UI now consumes `TRANSCRIPT_MINED` directly from the event log, giving operators a live `Recent Mined Transcripts` view instead of leaving transcript mining as an invisible background capability

### Wave 5. Documentation And Operator Truth

**Why last**

Docs should close after runtime truth and capability acceptance, not before.

**Scope**

- rewrite `state.md`
- reconcile `agents.md`, `CLAUDE.md`, `README.md`, `docs/AGENT_INTEGRATION_GUIDE.md`, `docs/claude/*`, and older verification summaries
- leave a clean execution handoff for later delegated work

**Acceptance**

- core operator docs match live truth
- repo execution artifacts point to the same current baseline
- no major doc still implies the old false-green closure story

**Primary repo todos**

- `008-ready-p2-wave-5-documentation-and-operator-truth.md`

**Current status**

- `README.md`, `CLAUDE.md`, `docs/AGENT_INTEGRATION_GUIDE.md`, `docs/claude/deployment.md`, and `docs/claude/api-contract.md` no longer describe the stale dual-port or direct-CLI-first story
- operator-facing transport and deployment guidance is now aligned with the live Wave 1-3 baseline
- broader historical docs still remain for later reconciliation, but the active entry-point docs are now materially closer to runtime truth

## GitHub Issue Mapping

| Wave | Issues | Why they belong there |
|---|---|---|
| Wave 0 | `#133` | umbrella grounding issue; owns baseline, sequencing, and scope freeze |
| Wave 1 | `#95`, `#122` | operational truth surfaces, REST error semantics, SSE security/rate-limit parity |
| Wave 2 | `#132`, `#114`, `#134` | ingestion/state cleanup, structural persistence correctness, corpus determinism, project inventory truth |
| Wave 3 | `#94`, `#126`, `#118` | search determinism, regression hardening, capability verification coverage |
| Wave 4 | `#96`, `#97`, `#98`, `#99`, `#101`, `#102`, `#110`, `#121` | advanced subsystem wiring, deployment parity, event-driven automation, audit-history safety |
| Wave 5 | `#133` follow-through | closure only after state/docs/operator truth are reconciled |

## Issue Notes

### Wave 0

- `#133` remains the umbrella issue and should carry links to this execution doc, the grounding plan, and wave todos.

### Wave 1

- `#95` is a contract-truth issue: error behavior must not violate supported API semantics.
- `#122` belongs here because SSE parity affects whether health/session/client claims are actually consistent across transports.

### Wave 2

- `#132` is partly code-fixed but still belongs here until multi-repo structural acceptance is complete in reconciled live state.
- `#114` belongs here because corpus hygiene and stale-manifest behavior affect whether reconciliation is deterministic. It is now materially complete in live state after the registered-set refresh on 2026-04-22.
- `#134` belongs here because project inventory truth is part of state convergence: operators cannot trust the codebase surface if stale worktree/ad hoc rows pollute the default project list. It is now materially resolved in live state via registered-only defaults, explicit `scope=all`, and a reconciliation script for stale rows.

### Wave 3

- `#94` is directly about deterministic search behavior under low-score/empty-result conditions.
- `#126` belongs here because regression CI is part of repeatable capability acceptance.
- `#118` belongs here because the supported tool surface needs proof, not just declarations.

### Wave 4

- `#96`, `#99` are runtime wiring issues for declared enrichment/observability surfaces.
- `#98` is shell activation parity.
- `#97` is deployment parity.
- `#101`, `#102`, `#121` were event-driven consumer/automation gaps; `#101` and `#102` are now closed, leaving the remaining Wave 4 work concentrated in broader capability truth rather than missing basic consumers.
- `#110` is audit-history safety and belongs with advanced/maintenance capability truth rather than core ingestion.

## Delegation Strategy

When using sub-agents, keep wave ownership stable:

- explorers gather bounded evidence or issue-to-capability mapping
- workers implement within a single wave and a disjoint write scope
- the main agent verifies each wave locally before moving on

Recommended sub-agent split for later execution:

1. operational truth agent
2. state convergence agent
3. capability acceptance/search agent
4. docs/operator-truth agent

## Repo Tracking

Wave tracking in the repo lives in:

- [todos/003-ready-p1-wave-0-truth-baseline-and-freeze.md](/Users/umasankr/Projects/ping-mem/todos/003-ready-p1-wave-0-truth-baseline-and-freeze.md)
- [todos/004-ready-p1-wave-1-operational-truth.md](/Users/umasankr/Projects/ping-mem/todos/004-ready-p1-wave-1-operational-truth.md)
- [todos/005-ready-p1-wave-2-state-convergence-and-reconciliation.md](/Users/umasankr/Projects/ping-mem/todos/005-ready-p1-wave-2-state-convergence-and-reconciliation.md)
- [todos/006-ready-p1-wave-3-capability-correctness-and-acceptance.md](/Users/umasankr/Projects/ping-mem/todos/006-ready-p1-wave-3-capability-correctness-and-acceptance.md)
- [todos/007-ready-p2-wave-4-declared-surface-and-environment-parity.md](/Users/umasankr/Projects/ping-mem/todos/007-ready-p2-wave-4-declared-surface-and-environment-parity.md)
- [todos/008-ready-p2-wave-5-documentation-and-operator-truth.md](/Users/umasankr/Projects/ping-mem/todos/008-ready-p2-wave-5-documentation-and-operator-truth.md)

This file should be updated whenever:

- a wave boundary changes
- an issue moves between waves
- a new discovery introduces a new deliverable inside an existing wave

## Detailed Task Backlog

These tasks are the current autonomous execution queue.

If a task is completed or split further during implementation, update the relevant wave todo and this section together.

### Wave 0 Task Queue

- `W0-T1` Capture live `/health`, `doctor`, `/ui/health`, Docker healthcheck, and shallow-health evidence from the running stack.
- `W0-T2` Capture active project rows, duplicates, stale rows, and current ingest-age / coverage signals.
- `W0-T3` Capture active session state, session ambiguity evidence, and current client-routing behavior.
- `W0-T4` Capture representative memory/code/hybrid regression behavior and identify current fail/pass baseline.
- `W0-T5` Capture delete/re-ingest, manifest, structural-edge, and orphan-debt evidence from live state and code paths.
- `W0-T6` Produce a repo evidence artifact summarizing the baseline with file references and concrete runtime outputs.
- `W0-T7` Update umbrella tracking so the baseline displaces the old false-green closure story.

### Wave 1 Task Queue

- `W1-T1` Trace the exact cause of degraded `/health`, including the `sqlite integrity_ok=0` alert path and whether it is signal or bug.
- `W1-T2` Align `/health` body semantics, HTTP semantics, and doctor expectations.
- `W1-T3` Align `health:shallow`, Docker healthchecks, readiness/status routes, and any deployment probes with the intended semantics.
- `W1-T4` Audit `/ui/health` live-vs-historical presentation and correct misleading operator signals.
- `W1-T5` Fix or harden session routing semantics across REST, SSE, MCP, and shell-facing routes.
- `W1-T6` Add or tighten tests for the operational-truth contract.
- `W1-T7` Re-verify the operational truth surfaces against live runtime.

### Wave 2 Task Queue

- `W2-T1` Audit current project rows and identify the authoritative live row for each active project.
- `W2-T2` Reconcile delete semantics between codebase routes and admin routes.
- `W2-T3` Fix manifest convergence so delete/re-ingest cannot short-circuit on stale manifests.
- `W2-T4` Fix structural-edge cleanup when a re-ingest yields zero edges.
- `W2-T5` Run intentional cleanup and re-ingest for affected active projects.
- `W2-T6` Verify graph, search, diagnostics, and manifest state converge together.
- `W2-T7` Re-run project-list and state-quality checks after reconciliation.

### Wave 3 Task Queue

- `W3-T1` Define capability acceptance cases by entry point: REST, MCP, UI, and direct/internal where applicable.
- `W3-T2` Verify memory search determinism and recall quality against supported query shapes.
- `W3-T3` Verify code search filter semantics, ranking semantics, and empty-result behavior.
- `W3-T4` Verify hybrid and knowledge search behavior independently rather than as one blended claim.
- `W3-T5` Verify structural dependency, impact, and blast-radius correctness on multiple real repos.
- `W3-T6` Verify temporal and snapshot query semantics, or narrow the claims when implementation is weaker than docs.
- `W3-T7` Raise regression and MCP/tool coverage where platform claims exceed current proof.

### Wave 4 Task Queue

- `W4-T1` Classify advanced subsystems and tool families as verified, weakly verified, partial, dormant, or docs-only.
- `W4-T2` Audit deployment parity across local Docker, direct mode, proxy mode, and production assumptions.
- `W4-T3` Verify or narrow diagnostics/worklog support claims.
- `W4-T4` Verify or narrow extractor/runtime, transcript mining, dreaming, and event-driven consumer claims.
- `W4-T5` Verify or narrow shell daemon/hook activation claims.
- `W4-T6` Verify auth, admin, SDK, SSE, and transport parity/security claims.
- `W4-T7` Fold the related GitHub issue backlog into capability families with explicit support-level outcomes.

### Wave 5 Task Queue

- `W5-T1` Rewrite `state.md` from current verified runtime truth.
- `W5-T2` Reconcile `agents.md`, `CLAUDE.md`, `README.md`, and `docs/AGENT_INTEGRATION_GUIDE.md`.
- `W5-T3` Reconcile `docs/claude/*` and older verification / implementation summaries that still overclaim closure.
- `W5-T4` Leave a compact execution handoff for future delegated work.
- `W5-T5` Verify the repo no longer contains an active false-green closure narrative.

## Current Start Point

The next executable wave is **Wave 0**.

That preserves the order required by the grounding plan:

1. freeze the live truth
2. fix operational truth
3. then reconcile state and verify capability correctness
