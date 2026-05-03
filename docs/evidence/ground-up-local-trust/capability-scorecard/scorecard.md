# ping-mem Capability Scorecard

Generated: 2026-05-03T05:14:32.728Z
Live checks: disabled

Overall: **94% yellow** (49/52 weighted metrics)

## Objective Rollup

| Objective | Score | Status |
|---|---:|---|
| OBJ-1 | 83% (5/6) | yellow |
| OBJ-2 | 100% (6/6) | green |
| OBJ-3 | 100% (6/6) | green |
| OBJ-4 | 100% (4/4) | green |
| OBJ-5 | 100% (4/4) | green |
| OBJ-6 | 100% (5/5) | green |
| OBJ-7 | 100% (6/6) | green |
| OBJ-8 | 100% (4/4) | green |

## Outcome Rollup

| Outcome | Score | Status |
|---|---:|---|
| OUT-1 | 83% (5/6) | yellow |
| OUT-2 | 100% (6/6) | green |
| OUT-3 | 100% (6/6) | green |
| OUT-4 | 100% (4/4) | green |
| OUT-5 | 100% (4/4) | green |
| OUT-6 | 100% (5/5) | green |
| OUT-7 | 100% (6/6) | green |
| OUT-8 | 100% (4/4) | green |

## Capability Metrics

| Capability | Objective | Outcome | Score | Status | Goal |
|---|---|---|---:|---|---|
| CAP-1 Runtime Ground Truth | OBJ-4 | OUT-4 | 100% | green | One local REST runtime owns writes, sessions, indexes, and project registry truth. |
| CAP-2 Agent Reachability | OBJ-1 | OUT-1 | 83% | yellow | Codex and Claude Code can reach the intended local runtime through approved entrypoints. |
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
- [ ] Approved ping-mem wrapper projects: not run; use --live to execute

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
| Live ping-mem discovery path | 0% | red | The approved ping-mem wrapper should discover indexed context when the runtime has ingestion configured. |
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

- [ ] ping-mem registered project inventory live check: not run; use --live to execute
- [ ] ping-mem indexed discovery live check: not run; use --live to execute

### Optional MCP proxy remains outside current claim

- [x] S016 is blocked/deferred: status=blocked
- [x] S016 quarantine evidence exists: passed

## Claim Boundary

- Scorecard metrics are proof-routing signals, not a replacement for direct evidence.
- ping-mem results are treated as discovery leads unless backed by evidence files, tests, or live runtime output.
- S016 optional MCP proxy remains blocked/deferred and must not expand the current completion claim.

