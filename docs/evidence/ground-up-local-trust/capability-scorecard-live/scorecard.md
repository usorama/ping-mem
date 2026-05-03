# ping-mem Capability Scorecard

Generated: 2026-05-03T11:49:16.576Z
Live checks: enabled

Overall: **100% green** (54/54 weighted metrics)

## Objective Rollup

| Objective | Score | Status |
|---|---:|---|
| OBJ-1 | 100% (6/6) | green |
| OBJ-2 | 100% (6/6) | green |
| OBJ-3 | 100% (6/6) | green |
| OBJ-4 | 100% (4/4) | green |
| OBJ-5 | 100% (4/4) | green |
| OBJ-6 | 100% (5/5) | green |
| OBJ-7 | 100% (7/7) | green |
| OBJ-8 | 100% (4/4) | green |

## Outcome Rollup

| Outcome | Score | Status |
|---|---:|---|
| OUT-1 | 100% (6/6) | green |
| OUT-2 | 100% (6/6) | green |
| OUT-3 | 100% (6/6) | green |
| OUT-4 | 100% (4/4) | green |
| OUT-5 | 100% (4/4) | green |
| OUT-6 | 100% (5/5) | green |
| OUT-7 | 100% (7/7) | green |
| OUT-8 | 100% (4/4) | green |

## Capability Metrics

| Capability | Objective | Outcome | Score | Status | Goal |
|---|---|---|---:|---|---|
| CAP-1 Runtime Ground Truth | OBJ-4 | OUT-4 | 100% | green | One local REST runtime owns writes, sessions, indexes, and project registry truth. |
| CAP-2 Agent Reachability | OBJ-1 | OUT-1 | 100% | green | Codex and Claude Code can reach the intended local runtime through approved entrypoints. |
| CAP-3 Explicit Identity | OBJ-5 | OUT-5 | 100% | green | Every approved path carries project, agent, and session identity or fails loudly. |
| CAP-4 Memory Lifecycle Correctness | OBJ-2 | OUT-2 | 100% | green | Save, search, retrieve, update/supersede, recall, delete, and confirm absent work end to end. |
| CAP-5 Codebase Grounding Correctness | OBJ-3 | OUT-3 | 100% | green | Verify, ingest, search, timeline, registered inventory, and file/line anchors work on real repos. |
| CAP-6 Recovery And Readiness | OBJ-6 | OUT-6 | 100% | green | Sleep, reboot, runtime restart, Neo4j restart, Qdrant restart, auth drift, and stale launchd states are known events. |
| CAP-7 Truthful Observability | OBJ-7 | OUT-7 | 100% | green | Health, doctor, UI, logs, alerts, and graph answers distinguish healthy, stale, partial, blocked, and error states. |
| CAP-8 Controlled Re-Adoption | OBJ-8 | OUT-8 | 100% | green | Agent integrations are restored only after proof passes and final claims stay inside evidence. |

### CAP-1 Runtime Ground Truth

- [x] S002 REST owner issue done: passed
- [x] S010 runtime registry issue done: passed
- [x] Direct-mode quarantine evidence exists: passed
- [x] Runtime registry alignment evidence exists: passed

### CAP-2 Agent Reachability

- [x] S003 unified CLI issue done: passed
- [x] S005 Codex memory proof issue done: passed
- [x] S006 Claude memory proof issue done: passed
- [x] S007 Codex codebase proof issue done: passed
- [x] S008 Claude codebase proof issue done: passed
- [x] Approved ping-mem wrapper projects: command exited 0

### CAP-3 Explicit Identity

- [x] S004 identity issue done: passed
- [x] Identity/path safety evidence exists: passed
- [x] Agent REST tests include graph identity gate: passed
- [x] Agent trust tests include graph answer identity: passed

### CAP-4 Memory Lifecycle Correctness

- [x] S005 Codex memory issue done: passed
- [x] S006 Claude memory issue done: passed
- [x] Codex proof JSON exists: passed
- [x] Claude proof JSON exists: passed
- [x] Codex memory proof ok: ok=true
- [x] Claude memory proof ok: ok=true

### CAP-5 Codebase Grounding Correctness

- [x] S007 Codex codebase issue done: passed
- [x] S008 Claude codebase issue done: passed
- [x] Codex codebase proof JSON exists: passed
- [x] Claude codebase proof JSON exists: passed
- [x] Codex codebase proof ok: ok=true
- [x] Claude codebase proof ok: ok=true

### CAP-6 Recovery And Readiness

- [x] S012 LaunchAgent hygiene issue done: passed
- [x] S013 recovery scenarios issue done: passed
- [x] Recovery scenario report exists: passed
- [x] LaunchAgent reconciliation evidence exists: passed
- [x] Sleep/wake HITL blocker remains explicit: passed

### CAP-7 Truthful Observability

- [x] S009 failure-state honesty issue done: passed
- [x] S014 observability issue done: passed
- [x] S017 structured graph issue done: passed
- [x] Failure-state matrix exists: passed
- [x] Observability alignment evidence exists: passed
- [x] Structured graph evidence exists: passed
- [x] Live health agrees codebase dependencies are ready: status=ok, neo4j=healthy, qdrant=healthy

### CAP-8 Controlled Re-Adoption

- [x] S015 CLI-first re-adoption issue done: passed
- [x] S016 optional MCP proxy remains blocked/deferred: passed
- [x] S015 readoption report exists: passed
- [x] S016 quarantine report exists: passed

## Feature Metrics

| Feature | Score | Status | Goal |
|---|---:|---|---|
| ping-mem relationship lift over rg | 100% | green | Return the files rg can reveal plus relationship edges, paths, provenance, and denominator evidence the user did not explicitly ask for. |
| rg baseline remains available | 100% | green | rg stays the fast exact-match baseline; ping-mem must add relationship and provenance lift, not replace exact search. |
| Live ping-mem discovery path | 100% | green | The approved ping-mem wrapper should discover indexed context when the runtime has ingestion configured. |
| Optional MCP proxy remains outside current claim | 100% | green | MCP can become a convenience adapter later, but it must not inflate the current proven capability score. |

### ping-mem relationship lift over rg

- [x] Complete graph evidence file exists: complete_graph-answer.json
- [x] Complete answer has denominator: nodeCount=4, edgeCount=3
- [x] Complete answer has unasked relationship edges: edgeCount=3
- [x] Complete answer has source anchors: sourceAnchorCount=4
- [x] Semantic answer blocks completeness language: semantic blockedClaims mention incomplete
- metric data: `{"nodeCount":4,"edgeCount":3,"anchorCount":4}`

### rg baseline remains available

- [x] rg exact search runs: 9 hit(s)
- [x] rg finds direct text hits: 9 hit(s) for Structured Knowledge Graph
- metric data: `{"query":"Structured Knowledge Graph","hits":9}`

### Live ping-mem discovery path

- [x] REST health exposes ready codebase dependencies: status=ok, neo4j=healthy, qdrant=healthy
- [x] ping-mem registered project inventory live check: command exited 0
- [x] ping-mem indexed discovery live check: command exited 0

### Optional MCP proxy remains outside current claim

- [x] S016 is blocked/deferred: status=blocked
- [x] S016 quarantine evidence exists: passed

## Original Capability Inventory

Source: `docs/evidence/ground-up-local-trust/capability-inventory.json`

Total original capabilities: **14**

| Status | Count |
|---|---:|
| verified | 5 |
| partial | 7 |
| dormant | 1 |
| out_of_current_claim | 1 |

| ID | Capability | Status | Claim Boundary |
|---|---|---|---|
| ORIG-01 | Session Lifecycle And Project Tracking | verified | Verified for REST/CLI local runtime paths; long-running cross-agent lifecycle policy remains bounded by existing session tests. |
| ORIG-02 | Memory Lifecycle | verified | Verified for approved local agent proof paths; native Codex memory writes remain outside ping-mem unless explicitly re-enabled. |
| ORIG-03 | Agent Identity, Scope, And Quotas | partial | Approved path identity gates are verified; broader multi-agent orchestration and quota behavior need explicit live metrics. |
| ORIG-04 | Codebase Ingestion And Registry | verified | Verified for the approved registered roots; stale or ad hoc ingests must be identified by scope, not mixed into registered truth. |
| ORIG-05 | Code Search, Timeline, And Structural Impact | partial | Search and structural modules exist with tests; every subtool still needs a live metric before broad product claims. |
| ORIG-06 | Graph Relationships And Structured Answers | partial | Structured answer semantics are verified; live Neo4j-backed relationship breadth still needs denominator metrics. |
| ORIG-07 | Events, Worklog, And Streams | partial | Routes and tests exist; live stream delivery and event coverage need explicit capability metrics. |
| ORIG-08 | Diagnostics Intelligence | partial | Core diagnostics behavior is test-backed; live project diagnostics freshness needs a scorecard metric. |
| ORIG-09 | Knowledge, Mining, Dreaming, And Profiles | dormant | Modules exist, but this is not currently in the live capability claim until trigger paths and acceptance metrics are proven. |
| ORIG-10 | Health, Doctor, Observability, And Recovery | verified | Live local runtime readiness is verified; Mac sleep/wake remains explicitly human-in-the-loop where required. |
| ORIG-11 | Web UI And Static Surfaces | partial | Existing views are tested in pieces; capability metrics dashboard integration is tracked separately by issue #139. |
| ORIG-12 | CLI And Approved Agent Entrypoints | verified | The Codex-approved wrapper is verified; direct CLI/MCP paths remain quarantined unless explicitly claimed. |
| ORIG-13 | MCP And Proxy Boundaries | out_of_current_claim | MCP remains optional and blocked/deferred for current trust claims; it must not inflate live capability scores. |
| ORIG-14 | Docs And Operator Truth | partial | Docs have been quarantined and partially rewritten; final closure evidence and soak remain tracked by Wave 5. |

## Claim Boundary

- Scorecard metrics are proof-routing signals, not a replacement for direct evidence.
- ping-mem results are treated as discovery leads unless backed by evidence files, tests, or live runtime output.
- S016 optional MCP proxy remains blocked/deferred and must not expand the current completion claim.

