# PRD: ping-mem Ground-Up Local Trust Rebuild

**Date:** 2026-04-29
**Status:** PRD draft locked for product intent; requires `/to-architect` before `/to-issues`
**Tracking mode recommendation:** local markdown issues first, then one parent GitHub issue only if/when implementation scope is approved

## How To Read This PRD

This PRD is the shared founder/product contract. It should stay readable to the founder and explicit enough for Codex to turn into architecture, issues, tests, and implementation.

The main product promise is simple:

> ping-mem should reliably give Codex and Claude Code the right memory and codebase context, from the current live system, with honest status when something is broken.

The implementation artifacts that follow this PRD can be more technical. Those are for Codex and downstream agents. This PRD should not make the founder choose low-level design details.

## Founder Summary

ping-mem is not trustworthy today because the product has never proven the full user-facing capability path. It has many components, tests, health checks, routes, tools, and UI pages, but those do not matter if Codex and Claude Code still cannot reliably remember, recall, search current code, and recover after normal machine events.

This rebuild starts with the core product, not with UI polish or another green status board:

- **Memory must work:** save, find, update, delete, and recall.
- **Codebase grounding must work:** verify, ingest, search, and return real file evidence.
- **Agent identity must work:** Codex and Claude Code must not mix sessions or projects.
- **Runtime truth must work:** one live system owns the data; no split-brain database paths.
- **Recovery must work:** sleep, reboot, and dependency restarts must not require babysitting.
- **Status must be honest:** health, logs, UI, and alerts must tell the same truth.
- **Re-adoption must be earned:** agents stay quarantined until these capabilities pass.

The acceptance command or doctor is not the product. It is only the final proof that these product capabilities are actually working.

This PRD does not assume MCP is the only acceptable agent path. The architecture should choose the most deterministic local path for Codex and Claude Code. A shared CLI plus agent skill is acceptable, and may be preferable, if it gives clearer identity, proof output, rollback, and failure behavior than an MCP-only integration.

## Problem Statement

ping-mem is supposed to be the durable memory and codebase truth layer for AI agents. In practice, the founder cannot trust it as a product: agents have hit stale context, auth failures, split runtime paths, session ambiguity, misleading health, and sleep/reboot fragility. The issue is not one bug. The issue is that the core capability path has never been proven end to end from a real agent request to a trustworthy memory or codebase answer.

The product is broken until Codex and Claude Code can reliably use ping-mem locally for memory, codebase context, and project continuity without false-green status or hidden failure.

## Goal Contract Status

**LOCKED for product intent.**

The PRD scope is locked to a local deterministic trust rebuild for Codex and Claude Code. Multi-user tenancy, VPS/prod, public packaging, and UI polish are explicitly deferred.

**Architecture required before issue slicing.**

The implementation touches runtime ownership, data ownership, agent identity, session identity, direct database access, MCP/REST/CLI/hook contracts, launchd/recovery behavior, and observability. `/to-architect` must define those ownership and proof boundaries before `/to-issues` creates execution slices.

## Solution

Rebuild ping-mem from the product capability spine outward:

1. Prove there is one local runtime truth.
2. Prove Codex and Claude Code can reach that runtime through their intended paths.
3. Prove memory save, recall, supersede, and delete work deterministically.
4. Prove codebase verify, ingest, search, and evidence anchors work deterministically.
5. Prove project, agent, and session identity are explicit on all agent paths.
6. Prove expected machine events do not silently break the product.
7. Prove health, doctor, UI, logs, and alerts tell the same truth.
8. Re-enable agent usage only after the capability proof passes.

The proof command or dashboard is not the product. It is only the acceptance gate that shows the product capabilities are working.

## Objectives

- **OBJ-1:** Restore trust in ping-mem as local agent infrastructure for the founder.
- **OBJ-2:** Make memory lifecycle behavior deterministic for Codex and Claude Code.
- **OBJ-3:** Make codebase grounding deterministic and evidence-backed.
- **OBJ-4:** Remove split-brain runtime and data-path behavior.
- **OBJ-5:** Make agent, session, and project identity explicit enough to avoid cross-talk.
- **OBJ-6:** Make recovery from sleep, reboot, and dependency restart predictable.
- **OBJ-7:** Make product status honest when broken.
- **OBJ-8:** Re-adopt ping-mem only after the local capability spine earns trust.

## Outcomes

- **OUT-1:** The founder can ask Codex or Claude Code for remembered/project context and get current, relevant, source-backed answers.
- **OUT-2:** A memory can be saved, found, superseded or updated, deleted, and confirmed absent through Codex and Claude Code paths.
- **OUT-3:** A repository can be verified or ingested, searched, and returned with real file/line evidence.
- **OUT-4:** Codex and Claude Code use the same local runtime and data plane, not separate in-memory or direct-DB paths.
- **OUT-5:** Every agent call has explicit project, agent, and session identity, or fails loudly.
- **OUT-6:** Sleep, reboot, ping-mem restart, Neo4j restart, and Qdrant restart either recover within the architecture-defined window or report an actionable blocker.
- **OUT-7:** Health, doctor, UI, logs, and alerts agree on what is healthy, degraded, blocked, or broken.
- **OUT-8:** ping-mem remains quarantined as a default memory system until the acceptance gate passes.

## Capabilities

- **CAP-1:** Runtime Ground Truth: one local runtime owns live state, writes, indexes, and project registry truth.
- **CAP-2:** Agent Reachability: Codex and Claude Code can reach the live runtime through intended local entrypoints.
- **CAP-3:** Explicit Identity: each relevant call carries project, agent, and session identity.
- **CAP-4:** Memory Lifecycle Correctness: save, search, retrieve, update/supersede, delete, and recall work end to end.
- **CAP-5:** Codebase Grounding Correctness: verify, ingest, search, timeline, and evidence anchors work on real repos.
- **CAP-6:** Recovery and Readiness: common local machine and dependency events are tested events, not surprises.
- **CAP-7:** Truthful Observability: status surfaces distinguish healthy, loading, empty, stale, partial, blocked, and error.
- **CAP-8:** Controlled Re-Adoption: agent integrations are restored only after proof passes.

## User Stories

1. As the founder, I want Codex to recall the right project context, so that I do not repeatedly explain the same background.
2. As the founder, I want Claude Code to recall the right project context, so that Claude sessions do not start blind.
3. As the founder, I want memories saved by one approved agent path to be searchable from the same live runtime, so that memory is not split across processes.
4. As the founder, I want stale or missing memory data to be reported honestly, so that I do not make decisions from false context.
5. As the founder, I want codebase search to return real source anchors, so that agents can verify claims against files.
6. As the founder, I want repo verification and ingest to finish or fail clearly, so that stale manifests and timeouts do not masquerade as success.
7. As the founder, I want agent/session/project identity to be explicit, so that Codex and Claude Code do not cross-talk.
8. As the founder, I want ping-mem to survive sleep/reboot/restart scenarios, so that I do not babysit infrastructure.
9. As the founder, I want health and UI to show broken versus empty states, so that I know whether there is no data or the system failed.
10. As the founder, I want agent re-adoption to be gated, so that ping-mem earns trust before becoming default infrastructure again.

## Functional Requirements

- **FR-1:** The rebuild must inventory all local ping-mem entrypoints used by Codex and Claude Code, including REST, CLI, MCP/proxy, hooks, launchd jobs, Docker/OrbStack services, local config files, and active operator instructions/docs/UI that could tell an agent or founder to use ping-mem. Supports CAP-1, CAP-2, CAP-8.
- **FR-2:** Codex and Claude Code must remain quarantined from default ping-mem usage until re-adoption criteria pass. Supports CAP-8.
- **FR-3:** The architecture must identify the single owner for writes, sessions, memory state, codebase indexes, and project registry truth. Supports CAP-1.
- **FR-4:** Direct database access from active agent paths must be removed, blocked, or explicitly classified as offline maintenance only. Supports CAP-1.
- **FR-5:** Codex and Claude Code must each have a tested local path for memory save, search, retrieve, update/supersede, delete, and recall. Supports CAP-2, CAP-4.
- **FR-6:** Codex and Claude Code must each have a tested local path for codebase verify, ingest, search, and source-anchor retrieval. Supports CAP-2, CAP-5.
- **FR-7:** All approved agent paths must carry explicit project, agent, and session identity, or fail with an actionable error. Supports CAP-3.
- **FR-8:** Missing, stale, timed-out, blocked, and unauthorized states must be represented as first-class states, not generic success or empty results. Supports CAP-5, CAP-7.
- **FR-9:** Recovery checks must cover ping-mem restart, Neo4j restart, Qdrant restart, Docker/OrbStack restart where applicable, Mac sleep/wake, Mac reboot, auth/config drift, and stale launchd/watchdog state. Supports CAP-6.
- **FR-10:** Health, doctor, UI, logs, and alerts must report the same capability truth for the tested local paths. Supports CAP-7.
- **FR-11:** The final re-adoption gate must be read-only by default. Repair actions must require a separate explicit command or flag. Supports CAP-7, CAP-8.
- **FR-12:** Re-enabling Codex and Claude Code integrations must be tracked as a controlled rollout with backups and restore instructions. Supports CAP-8.

## Non-Functional Requirements

- **NFR-1 Reliability:** A passing acceptance gate must prove already-healthy behavior, not hidden auto-repair.
- **NFR-2 Determinism:** Each acceptance check must have an exact command, expected state, and failure interpretation.
- **NFR-3 Observability:** Every failure must include an actionable reason and the layer that failed.
- **NFR-4 Data Safety:** Active runtime writes must avoid split-brain SQLite/WAL access and ambiguous direct-DB clients.
- **NFR-5 Privacy/Security:** Local credentials and admin tokens must not be written into committed artifacts. Config backups must remain machine-local.
- **NFR-6 Performance:** Agent-path checks must have bounded timeouts so a broken ping-mem does not burn agent sessions.
- **NFR-7 Operability:** Recovery expectations must be understandable to a non-technical founder: green, degraded, blocked, or broken with next action.
- **NFR-8 Rollback Safety:** Re-adoption config changes must be reversible from backups.

## Acceptance Criteria

- **AC-1:** A Phase 0 inventory identifies every Codex and Claude Code ping-mem entrypoint and active instruction/operator surface, then marks each as quarantined, test-only, approved, blocked, historical, or out-of-scope.
- **AC-2:** The architecture contract names one owner for runtime writes, sessions, memory state, codebase indexes, and project registry truth.
- **AC-3:** Codex memory lifecycle proof passes from its approved path.
- **AC-4:** Claude Code memory lifecycle proof passes from its approved path.
- **AC-5:** Codex codebase grounding proof passes from its approved path.
- **AC-6:** Claude Code codebase grounding proof passes from its approved path.
- **AC-7:** Every approved path proves explicit project, agent, and session identity.
- **AC-8:** Failure-state tests prove stale, missing, timeout, unauthorized, and dependency-down states fail loudly.
- **AC-9:** Recovery tests prove the defined local machine/dependency events recover or report actionable blockers.
- **AC-10:** Health, doctor, UI, logs, and alerts align for each tested capability.
- **AC-11:** Re-adoption config/skill contract for Codex and Claude Code is restored only after AC-1 through AC-10 pass.
- **AC-12:** The final completion claim is limited to the proven local Codex and Claude Code paths.

## Traceability Matrix

| Objective | Outcome | Capability | User Stories | FRs | NFRs | Acceptance Criteria | Verification |
|---|---|---|---|---|---|---|---|
| OBJ-1 | OUT-1 | CAP-8 | US-1, US-2, US-10 | FR-1, FR-2, FR-12 | NFR-7, NFR-8 | AC-1, AC-11, AC-12 | Config inventory, quarantine evidence, re-adoption evidence |
| OBJ-2 | OUT-2 | CAP-4 | US-3, US-4 | FR-5, FR-8 | NFR-1, NFR-2 | AC-3, AC-4, AC-8 | Codex and Claude memory lifecycle proofs |
| OBJ-3 | OUT-3 | CAP-5 | US-5, US-6 | FR-6, FR-8 | NFR-2, NFR-6 | AC-5, AC-6, AC-8 | Repo verify/ingest/search proofs with source anchors |
| OBJ-4 | OUT-4 | CAP-1 | US-3 | FR-3, FR-4 | NFR-4 | AC-2 | Architecture contract plus direct-DB denial/offline-only proof |
| OBJ-5 | OUT-5 | CAP-3 | US-7 | FR-7 | NFR-2, NFR-3 | AC-7 | Identity propagation tests for each approved path |
| OBJ-6 | OUT-6 | CAP-6 | US-8 | FR-9 | NFR-1, NFR-7 | AC-9 | Recovery scenario evidence bundle |
| OBJ-7 | OUT-7 | CAP-7 | US-4, US-9 | FR-8, FR-10, FR-11 | NFR-3, NFR-7 | AC-8, AC-10 | Aligned health/doctor/UI/log/alert evidence |
| OBJ-8 | OUT-8 | CAP-8 | US-10 | FR-2, FR-12 | NFR-8 | AC-11, AC-12 | Re-adoption gate report and restored config/skill diff |

## Semantic Claim Boundary

| Claim | Population / discovery rule | Proof level required | Allowed completion claim | Blocked claim |
|---|---|---|---|---|
| "Agents work" | Codex and Claude Code only | Operational local proof | ping-mem is locally trustworthy for proven Codex and Claude Code paths | ping-mem works for all agents |
| "Memory works" | save, search, retrieve, update/supersede, delete, recall | Operational local proof through both agents | Memory lifecycle works for proven local paths | All memory features are production-ready |
| "Codebase grounding works" | verify, ingest, search, source anchors on selected real repos | Operational local proof | Codebase grounding works for tested repos and paths | All repos and all languages are covered |
| "Recovery works" | specified local events in FR-9 | Scenario proof | Defined local events recover or fail actionably | ping-mem survives every possible machine event |
| "Health is honest" | health, doctor, UI, logs, alerts | Cross-surface proof | Tested status surfaces align for tested capabilities | Every monitoring surface is complete |

## UI / Workflow Experience Inventory

This PRD is not a UI redesign. UI work is limited to truthful operator states required by CAP-7.

| Surface | Required states | Action | Data source | Proof |
|---|---|---|---|---|
| `/health` or successor | healthy, degraded, blocked, dependency down | read status | live runtime probes | response evidence |
| doctor/status command | pass, fail, blocked, stale | run read-only check | live runtime + config + logs | command evidence |
| existing UI health/status surfaces | healthy, empty, stale, blocked, error | inspect status | same truth as doctor | screenshot or HTML evidence after architecture decides exact routes |
| logs/alerts | actionable failure | inspect latest event | runtime logs/alert store | log excerpt evidence |

## Evidence Ledger

| Claim | Evidence class | Source | Verified on | Notes |
|---|---|---|---|---|
| ping-mem purpose is persistent memory, codebase intelligence, and cross-project awareness for agents | repo-evidence | `README.md` | 2026-04-29 | README states product purpose and exposed interfaces |
| Current repo claims prior local checks were green | repo-evidence | `state.md` | 2026-04-29 | Green checks are not accepted as product trust proof by this PRD |
| Prior remediation emphasized outcome-anchored proof and one source of truth per capability | repo-evidence | `docs/ping-mem-remediation-research/07-synthesis.md` | 2026-04-29 | Reused as product principle, not proof of current success |
| Claude Code proxy mode is the recommended local integration | repo-evidence | `README.md` Claude Code Integration | 2026-04-29 | Architecture must verify current implementation and config |
| Direct MCP DB mode exists and must be constrained | repo-evidence | `README.md` Claude Code Integration | 2026-04-29 | README says direct mode should be isolated development only |
| Codex and Claude Code are first-scope agents | user-decision | Current conversation | 2026-04-29 | OpenCode deferred/quarantined |
| Multi-user tenancy is deferred | user-decision | Current conversation | 2026-04-29 | GitHub issue #90 is not first rebuild driver |
| Phase 0 is read-only forensics plus acceptance-gate design | user-decision | Current conversation | 2026-04-29 | Product code changes start after PRD/architecture/issues |
| Re-adoption requires proof gate | user-decision | Current conversation | 2026-04-29 | Gate is proof, not the product itself |

## Decision Log

- **D-1:** First rebuild is local-only. VPS/prod, public packaging, and UI polish are deferred.
- **D-2:** ping-mem is quarantined as default memory/context infrastructure until re-adoption gates pass.
- **D-3:** Local configs were backed up and ping-mem usage was disabled for Claude Code and OpenCode. Codex static config showed no ping-mem MCP entry, but architecture must also inventory live Codex processes before claiming Codex is fully quarantined.
- **D-4:** Phase 0 is read-only forensics and acceptance-gate design; no product code changes yet.
- **D-5:** First agent population is Codex and Claude Code. OpenCode is deferred.
- **D-6:** Multi-user tenancy is deferred. First identity model is one local owner, multiple approved agents, explicit project/agent/session identity.
- **D-7:** Re-adoption requires a single external proof gate, but the gate must not replace the product capability work.
- **D-8:** The main proof command must be read-only by default; repair is explicit and separate.
- **D-9:** MCP is not assumed to be the first re-adoption path. Architecture may choose a shared CLI plus Codex/Claude skill as the first trust path, with MCP remaining a later convenience adapter if it satisfies the same proof contract.

## Assumptions and Open Questions

### Assumptions

- Local-only trust can be proven without external web or hosted production dependencies.
- Existing code contains reusable pieces for memory, codebase, sessions, agents, health, doctor, and MCP/proxy paths, but architecture must verify what is salvageable.
- UI work preserved outside the repo can be reintroduced later if it still aligns with truthful product states.

### Open Questions

No founder product decision remains open for this PRD. Technical ownership and sequencing questions are intentionally routed to `/to-architect`.

## Non-Goals

- Multi-user tenancy, OAuth, teams, billing, shared hosted instance isolation.
- VPS/prod deployment or public product packaging.
- Broad "all agents" support.
- UI redesign or visual polish beyond truthful status surfaces.
- New autonomous self-healing beyond explicit architecture-approved recovery and repair paths.
- Re-enabling ping-mem as default infrastructure before proof passes.

## Technical Handoff: Architecture Boundary Questions For `/to-architect`

This section is for Codex and downstream agents. The founder should not need to answer these unless the answer changes product scope, risk, or approval posture.

- Which process owns active writes, sessions, memory state, indexes, and project registry truth?
- Which direct DB paths remain, and are they removed, blocked, or offline-only?
- What is the exact Codex local path, given Codex currently has no ping-mem MCP configured?
- What is the exact Claude Code local path after quarantine?
- Should the first approved agent path be MCP proxy, a shared CLI plus skill, or both in a staged order?
- What identity headers or payload fields are required for project, agent, and session identity?
- Which existing scripts become product proofs versus internal checks?
- Which recovery checks are read-only verification, and which are explicit repair actions?
- Which UI/status surfaces must align, and which can be deferred?

## Technical Handoff: Proposed Slice Seed For `/to-issues`

`/to-issues` must wait for `/to-architect`, but the expected vertical slice families are:

- **S1 Phase 0 Inventory:** prove current configs, entrypoints, runtime, data paths, active instructions/docs/static UI, and quarantine state.
- **S2 Runtime/Data Ownership:** enforce one live owner and remove or constrain split-brain paths, including hidden maintenance paths that can write outside the live runtime.
- **S3 Unified Agent Path:** choose and build the first approved Codex/Claude route, likely a shared CLI plus skill if architecture confirms it is the most deterministic path.
- **S4 Identity and Project Safety Contract:** require explicit project/agent/session identity and safe project paths across approved paths.
- **S5 Codex Memory Path:** prove Codex memory lifecycle end to end.
- **S6 Claude Code Memory Path:** prove Claude Code memory lifecycle end to end.
- **S7 Codex Codebase Grounding Path:** prove Codex repo verify/ingest/search/timeline/project-inventory/source anchors.
- **S8 Claude Code Codebase Grounding Path:** prove Claude Code repo verify/ingest/search/timeline/project-inventory/source anchors.
- **S9 Failure-State Honesty:** prove stale/missing/timeout/auth/dependency failures are actionable.
- **S10 Registry and Observability Alignment:** align runtime project registry plus health, doctor, UI, logs, and alerts.
- **S11 Recovery Scenarios:** prove defined local recovery behavior.
- **S12 Controlled Re-Adoption:** restore Codex and Claude Code usage only after proof passes.
