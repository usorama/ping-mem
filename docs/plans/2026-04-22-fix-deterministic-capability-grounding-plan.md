---
title: "fix: ping-mem deterministic capability grounding"
type: fix
date: 2026-04-22
status: planning
supersedes:
  - state.md
  - docs/plans/2026-04-18-ping-mem-complete-remediation/overview.md
verification_method: "Grounded against current codebase, live container behavior, current doctor/health semantics, and existing regression artifacts"
---

# ping-mem Deterministic Capability Grounding

## Purpose

Create a single starting scope for the remaining work required for ping-mem to provide its claimed capabilities deterministically across repositories, sessions, and clients.

This document is intentionally narrower than a full implementation spec and broader than a bug list:

- broader than a bug list because the failures interact across memory, ingestion, health, search, sessions, and docs
- narrower than a full implementation spec because some runtime unknowns still need discovery during execution

This document should be treated as the current source of truth for **what is still open**, **why it matters**, and **what blast radius each gap has on capabilities and outcomes**.

Wave-by-wave execution is tracked separately in [docs/plans/2026-04-22-deterministic-capability-execution-waves.md](/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-22-deterministic-capability-execution-waves.md). That document translates this grounding scope into ordered waves, concrete issue mapping, and repo todos. The two documents should be kept in sync.

## Position

The current closure story is overstated.

- `state.md` still says all 8 phases are closed and all gates are green.
- The live service is not in that state today.
- The codebase now contains important fixes for cross-repo ingestion determinism and low-memory project deletion, but runtime acceptance is still incomplete.

So the right framing is not "one last bug." The right framing is "capability closure is incomplete, and we need a grounded plan that measures outcomes from user entry points."

## Objectives

1. Re-establish a truthful capability map for what ping-mem can and cannot do deterministically today.
2. Close the remaining gaps that can cause silent failure, false green health, misleading docs, or non-repeatable outcomes.
3. Replace "component appears healthy" with "user-facing capability passes a deterministic acceptance gate."
4. Keep this scope expandable as new discoveries appear during implementation.

## Claimed Outcomes That Still Need Grounding

These are the outcomes that matter operationally:

| Outcome | What it means in practice | Why it matters |
|---|---|---|
| O1 | memory saved by hooks and clients is retrievable deterministically | ping-mem fails its core purpose if recall is partial or stale |
| O2 | codebase ingestion is deterministic across repos, paths, and re-ingests | cross-repo code understanding is the main differentiator |
| O3 | graph relationships and structural queries are trustworthy | dependency, impact, and blast-radius queries depend on this |
| O4 | delete, re-ingest, and migration workflows converge live state without operator heroics | remediation is not complete if stale state lingers |
| O5 | health, doctor, and dashboards tell the truth | false green blocks safe operation and makes soak meaningless |
| O6 | MCP, REST, UI, and automation clients see the same contract | parity is required for reliable agent use |
| O7 | sessions behave deterministically under multi-client usage | ambiguous session routing produces non-repeatable outcomes |
| O8 | docs and state artifacts match runtime truth | stale docs create repeated regressions and bad operator decisions |
| O9 | declared search capabilities return stable, useful, deterministic results instead of silent empty or low-signal failures | search quality is part of the product, not a secondary concern |
| O10 | declared advanced subsystems are either wired, verified, and supportable or explicitly demoted from current capability claims | dead or partial capability claims are another form of false green |

## Capability Matrix

### 1. Memory Sync And Recall Determinism

**Capability**
- Claude memory hooks, project memory files, and client writes should become searchable and recallable without truncation or silent omission.

**What is now true**
- The regression suite exists and can prove some canonical recalls.
- Session-based search works in the live service.

**What is still open**
- We have not re-proved the whole memory-sync capability surface after the later runtime drift.
- `state.md` and remediation docs still present old closure claims as if they are currently true.
- Search contract mismatches still show up in logs for some caller shapes.

**Blast radius**
- Core memory usefulness
- recall confidence
- downstream agent trust
- regression gates and soak validity

### 2. Cross-Repo Ingestion Determinism

**Capability**
- Same relative paths or same chunk contents in different repositories must not collide in Neo4j or search identity.

**What is now true**
- Project-scoped file/chunk/symbol identity is implemented.
- Full-history defaults are fixed.
- Live ingestion proved same-path files in different repos produce different scoped graph identities.

**What is still open**
- The active-project fleet has not been fully reconciled after these identity changes.
- We still need a deliberate migration/re-ingest policy for old data, not just incremental live use.

**Blast radius**
- codebase search precision
- cross-repo isolation
- project list trustworthiness
- every structural or timeline query built on graph identity

### 3. Structural Graph Correctness

**Capability**
- import/dependency/impact/blast-radius queries should reflect the actual codebase deterministically.

**What is now true**
- Python import extraction for rankforge-style repos is now implemented.
- Structural persistence is project-scoped.

**What is still open**
- We have not yet re-run broad structural acceptance across multiple real repositories after cleanup and migration.
- The current open issue set still suggests incomplete test coverage across tools and paths.

**Blast radius**
- dependency maps
- impact analysis
- blast-radius analysis
- agent trust in code intelligence answers

### 4. Project Lifecycle Cleanup And Migration

**Capability**
- deleting a project, re-ingesting it, or replacing stale graph state should work on large repositories without memory failure or leftover corruption.

**What is now true**
- The low-memory batched Neo4j delete path is implemented and live.
- The stale `rankforge` row that previously failed with Neo4j transaction-memory exhaustion was successfully deleted.

**What is still open**
- The first live run swept a large orphan backlog, which proves there is historical graph debt.
- We do not yet have a full reconciliation run and post-cleanup quality baseline for all active projects.
- The delete/re-ingest contract is split across routes: admin delete and codebase delete do not currently guarantee the same cleanup semantics for manifests and follow-on ingestion behavior.
- Structural graph cleanup is not guaranteed when a re-ingest produces zero edges, which can leave stale dependency state behind after refactors.

**Blast radius**
- admin delete
- re-ingest safety
- graph quality alerts
- confidence in project list and historical graph state

### 5. Health, Doctor, And Observability Truthfulness

**Capability**
- `/health`, `doctor`, and `/ui/health` should reflect reality and should not produce false green or unexplained degraded states.

**What is now true**
- `/health` is reachable.
- doctor infrastructure exists.

**What is still open**
- Live `/health` currently returns `degraded` while component statuses are healthy.
- The service is raising a critical SQLite integrity alert path in the monitor.
- The doctor gate still expects `/health` to report `status=ok`, which is not compatible with the current live state.
- Docker healthchecks, shallow health scripts, and some docs still treat HTTP 200 from `/health` as fully healthy even when the body reports degradation.
- `/ui/health` mixes persisted doctor history with live probe signals, so operators can read it as “live green” when it is really “last recorded run green.”

**Blast radius**
- every automated health check
- soak tracking
- operator decisions
- acceptance gating
- trust in any "all green" statement

### 6. Session Determinism Under Real Multi-Client Use

**Capability**
- clients without explicit session ambiguity should still get deterministic behavior, or the contract should fail loudly and consistently.

**What is now true**
- Session reaping and hydration exist.

**What is still open**
- Live logs show repeated warnings about multiple active sessions with no `X-Session-ID`.
- This means some clients are still operating outside a deterministic session contract.

**Blast radius**
- REST search consistency
- memory attribution
- client interoperability
- multi-agent or multi-tool correctness

### 7. Client Contract Parity

**Capability**
- MCP, REST, UI, scripts, and automation clients should observe compatible semantics for health, auth, search, and project operations.

**What is now true**
- MCP/REST/search/project operations exist across surfaces.

**What is still open**
- Some docs still describe health and closure states that do not match runtime.
- Search callers are still hitting invalid parameter shapes in logs.
- Several open issues remain around MCP coverage and contract hardening.
- REST, SSE/MCP, shell routes, and direct/proxy CLI paths do not all share the same session and state-ownership semantics.
- SSE/client security and rate-limit parity are still part of the unclosed contract surface.

**Blast radius**
- Claude Code integration
- auto-os integration
- external client SDKs
- operational scripts

### 8. Documentation And State Truth

**Capability**
- human and agent operators should be able to trust `state.md`, plans, and integration docs to represent current reality.

**What is now true**
- rich documentation exists.

**What is still open**
- `state.md` materially overclaims closure.
- the remediation overview still describes assumptions that are now false in the live system.
- docs are not yet reconciled to the latest code and runtime findings.
- authoritative summary docs like `CLAUDE.md`, `README.md`, `docs/AGENT_INTEGRATION_GUIDE.md`, and older verification/implementation summaries still read as if full closure has already been achieved.
- some docs also preserve outdated gate counts, soak semantics, and transport/health assumptions that no longer match runtime.

**Blast radius**
- future planning
- triage quality
- repeated regressions
- wasted operator cycles

### 9. Search Quality And Retrieval Determinism

**Capability**
- memory search, code search, hybrid search, and recall should return deterministic and useful results for supported query shapes, without silent empty-result behavior when the system actually has relevant data.

**What is now true**
- canonical regression queries can still hit in the current live service.
- the repo contains substantial deterministic-search research and prior gap analysis.

**What is still open**
- open issues already exist for silent empty-result and contract failure behavior, including hybrid search zero-score behavior and REST contract drift.
- historical research in this repo shows deterministic search quality and code-search ranking were broader problem areas than the first grounding draft captured.
- current logs still show search requests hitting invalid shapes, which means parts of the retrieval contract are still brittle.
- current code paths still need direct behavioral verification for filter semantics, ranking semantics, and route-level contract promises, not just payload shape tests.
- deterministic search quality must be split into memory search, code search, hybrid search, and knowledge search rather than treated as one surface.

**Blast radius**
- primary user-perceived product quality
- agent confidence in recall and search
- regression-suite validity
- cross-project discovery

### 10. Declared But Ungrounded Subsystems

**Capability**
- subsystems that ping-mem claims as part of its platform surface should either be production-wired and verified, or explicitly removed from current capability claims.

**What is now true**
- the repo contains implementations and docs for mining, dreaming, extractor-based enrichment, shell daemon behavior, diagnostics, and other advanced surfaces.

**What is still open**
- the open issue set and prior capability-audit research show several subsystems were partially implemented, not wired in production, or only documented as if complete.
- this includes areas like extractor/runtime wiring, transcript mining observability, shell-hook activation, and broad MCP tool verification coverage.
- the first grounding draft did not explicitly account for this “declared but ungrounded capability” class.
- event-driven consumers that should turn observations into behavior are still part of this gap class: emitted or planned signals like transcript-mined and recall-miss do not yet necessarily drive corrective or downstream behavior.

**Blast radius**
- false platform claims
- support burden
- agent/runtime divergence
- future plans built on capabilities that are not actually live

### 11. Deployment And Environment Parity

**Capability**
- local, proxy, direct, and production deployment modes should not materially change which documented capabilities work.

**What is now true**
- local Docker-based runtime is usable and has been the basis for recent verification.

**What is still open**
- existing repo issues and capability-audit docs show known parity gaps in production env wiring, direct-vs-proxy usage, and port/config assumptions.
- a capability is not deterministic if it only works in one environment while the docs imply broader support.

**Blast radius**
- production reliability
- operator runbooks
- consumer integrations
- deploy-time failures that masquerade as runtime regressions

### 12. Tool Surface And Test Coverage Grounding

**Capability**
- tools exposed via MCP, REST, and UI should have coverage proportional to the claim that they are part of the supported platform.

**What is now true**
- ping-mem exposes a large tool surface and has some regression and route coverage.

**What is still open**
- the open issue set still includes major MCP tool test coverage gaps.
- this means many user-visible capabilities are still asserted by documentation and schemas more strongly than by verification evidence.
- diagnostics/worklog, knowledge/agent/causal, admin/API-key management, SDK/transport, and structural tools should be treated as distinct capability families during verification, not buried under one generic tool-surface bucket.

### 13. Ingestion Corpus And Audit Determinism

**Capability**
- the set of files and history ingested for a project should be deliberate, repeatable, and auditable, with no silent junk inclusion, stale manifest short-circuit, or audit-history loss.

**What is now true**
- full-history defaults and project-scoped graph identity are fixed.

**What is still open**
- issue and research history still points to corpus leakage risks: tracked junk, vendored type files, symlinks, large-file behavior, and stale manifest behavior.
- delete/re-ingest convergence is not fully trustworthy if manifest cleanup differs by route.
- event pruning and related audit-history concerns are part of deterministic closure, not just maintenance hygiene.

**Blast radius**
- ingestion repeatability
- project coverage metrics
- recovery after cleanup
- trust in historical audit state

### 14. Temporal And Snapshot Correctness

**Capability**
- timeline, file-history, and point-in-time graph queries should mean what they say and stay correct after later ingests.

**What is now true**
- commit, file, and structural history surfaces exist.

**What is still open**
- some “time-aware” query surfaces still need explicit verification against current implementation semantics.
- if current project rows overwrite the state a query depends on, the API may advertise stronger temporal guarantees than it really provides.

**Blast radius**
- historical reasoning
- timeline trust
- “what changed when” answers
- downstream agent explanations

**Blast radius**
- silent regressions on lesser-used tools
- broken agent workflows
- mismatch between advertised and supportable capability surface

## Starting Scope Of Work

This is the minimum grounded implementation scope.

### Phase A. Truth Baseline

- capture current live state for health, doctor, project list, active sessions, orphan quality, and canonical regression queries
- write the baseline as evidence, not narrative
- define which claims in `state.md` and remediation docs are now invalid

### Phase B. Health And Observability Truth

- trace and fix the SQLite integrity/degraded health path, or explicitly narrow what `/health` is supposed to mean
- align `/health`, doctor gates, `/ui/health`, and soak assumptions to the same semantics
- ensure "healthy", "degraded", and "unhealthy" are operationally meaningful and not contradictory

### Phase C. Data Reconciliation

- run an intentional cleanup/reconciliation pass for Neo4j project state and orphan backlog
- verify active projects are represented once and correctly
- re-run ingestion where identity or history changes require fresh state
- unify delete semantics so admin and codebase delete routes converge to the same follow-on ingest behavior
- verify manifests, graph state, search state, and diagnostics state are all reconciled together

### Phase D. Capability Acceptance

- expand acceptance from "containers up" to capability proofs:
- memory-sync regression
- cross-repo same-path isolation
- structural dependency correctness
- project delete/re-ingest convergence
- session determinism under realistic client usage
- temporal/snapshot correctness for advertised history queries

### Phase E. Contract And Client Hardening

- resolve search/session caller shapes that currently produce warnings or 400s
- confirm MCP, REST, and automation paths exercise the same intended semantics
- tighten tests where the contract is underspecified
- explicitly reconcile direct-DB MCP mode versus REST-proxy mode as a contract boundary
- align shell-route, REST-route, and SSE/MCP session semantics

### Phase F. Search And Retrieval Grounding

- re-audit deterministic memory search, code search, hybrid search, and zero-score/empty-result behaviors
- distinguish “works but low quality” from “contract bug” from “unsupported query shape”
- add acceptance checks for declared search capabilities, not just a narrow canonical subset
- add direct behavioral tests for filter semantics, ranking semantics, and route-level promises

### Phase G. Declared Capability Triage

- review declared advanced subsystems and tool surfaces against actual runtime wiring and verification
- classify each as: live and verified, live but weakly verified, partial, dormant, or docs-only
- fold existing open issues into this map so the umbrella scope reflects real capability debt
- include event-driven consumers and feedback loops, not just emitters and storage paths

### Phase H. Deployment And Environment Parity

- verify which capabilities differ across local Docker, proxy mode, direct mode, and production compose/runtime assumptions
- close or explicitly document environment-specific support boundaries
- include healthcheck semantics, shallow-health scripts, readiness/status endpoints, and live-vs-historical dashboard surfaces

### Phase I. Documentation And State Reconciliation

- rewrite `state.md` to match actual runtime truth
- update remediation docs and integration guidance to reflect current semantics and residual risk
- make the remaining open scope explicit instead of implied
- explicitly reconcile `CLAUDE.md`, `README.md`, `docs/AGENT_INTEGRATION_GUIDE.md`, `docs/claude/*`, and older verification/implementation-summary artifacts

## Acceptance Gates For This Grounding Plan

This plan is complete only when these are true:

1. `/health`, doctor, and `/ui/health` agree on service state and explain degradation consistently.
2. Every active project has one authoritative live row or an explicitly justified duplicate.
3. No stale-project cleanup requires manual Neo4j intervention.
4. Canonical memory and code capability checks pass from real client entry points.
5. Session ambiguity is either eliminated or turned into a hard, explicit contract for callers.
6. `state.md` and key operational docs match live reality.
7. Search capabilities have explicit deterministic acceptance gates beyond a single narrow happy-path suite.
8. Declared subsystems and tools are either verified or removed from current capability claims.
9. Environment-specific behavior is documented or normalized so deployment mode does not silently redefine the product.
10. Delete/re-ingest convergence is verified across all supported routes, including manifest behavior.
11. Historical and time-aware query surfaces are explicitly verified or narrowed in claim.

## Known Unknowns

These are intentionally left open for implementation-time discovery:

- whether `integrity_ok=0` is a real SQLite issue or a health-monitor/checkpoint bug
- how much orphan graph debt remains beyond the row we already cleaned
- whether any other active projects still carry stale pre-scope graph/search state
- whether canonical regression success currently depends on stale data rather than correct current data
- whether additional search/client contract mismatches exist outside the ones already visible in logs

## Out Of Scope For This Starting Plan

- net-new product capabilities unrelated to deterministic closure
- speculative improvements to dreaming/mining/self-improving loops unless they block deterministic outcomes
- broad architecture rewrites not required to make current capabilities truthful and repeatable

## Existing Issue Surface To Fold In

The open issue set already overlaps this work and should be triaged under this grounding effort rather than treated as isolated bugs:

- `#132` Python structural extraction support
- `#126` regression workflow hardening
- `#118` MCP tool test coverage gaps
- `#114` ingestion file/corpus audit
- `#134` project inventory truth for codebase project listing
- `#94` hybrid search empty-result behavior
- `#95` REST contract breakage around stats/error handling
- `#99` extractor/runtime wiring
- `#96` transcript miner observability wiring
- `#98` shell daemon / shell-hook activation
- `#97` deployment env parity
- `#122` SSE security and rate-limit parity
- `#121` event-driven automation / periodic mining-dreaming behavior
- `#101` transcript-mined consumer behavior
- `#102` recall-miss consumer behavior
- `#110` event pruning / audit-history safety
- older contract/quality issues in the `#94` to `#110` range

This plan should become the umbrella scope that decides which of those issues are:

- already resolved by newer work
- still valid and in-scope
- symptoms of a larger capability-level gap

## Deliverables

- a corrected capability-level remediation plan
- a reconciled operational state document
- a capability acceptance checklist tied to user-facing outcomes
- a triaged issue set under one umbrella scope

## Conclusion

You were not wrong to suspect the current list was incomplete.

The remaining work is wider than a few follow-up bugs and narrower than a full product rewrite. The real scope is deterministic capability closure across memory, ingestion, graph correctness, health semantics, session behavior, and documentation truth.

This document is the starting scope. It should be expanded during implementation whenever new findings affect a capability, an outcome, or the truthfulness of operational state.
