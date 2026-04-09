---
title: "feat: Full Capability Activation — Harness, Primitives, Architecture Gaps + Regressions"
type: feat
date: 2026-04-09
status: ready
github_issues: [92, 93, 94, 95, 96, 97, 98, 99, 101, 102]
github_pr: null
research: docs/ping-mem-research/capability-audit-verified.md (31 claims, 28 paper-verified); second-opinion Codex+Gemini 2026-04-09; research agents 2026-04-09
synthesis: docs/ping-mem-research/capability-audit-verified.md
eval_iteration: 1
review_iteration: 1
verification_iteration: 1
verification_method: "4-agent binary verification (4 agents: codebase functions, integration points, algorithms, external deps)"
---

# Full Capability Activation Plan

## VERIFY Amendments (Iteration 1 — 2026-04-09)

Four parallel VERIFY agents ran. Critical findings drastically change implementation scope.

### V1 (Codebase Functions) — 11/13 PASS, 2 FAIL

**[V1.5 BLOCKING] EventStore.createEvent() signature**
- Plan calls: `createEvent(sessionId, type, data)` 
- Actual: `createEvent(sessionId, eventType, payload, metadata?, causedBy?): Promise<Event>`
- Fix: All plan code snippets corrected to use actual param names. Implementations in Phase 2 already use the correct signature (verified committed code at lines 974-979).

**[V1.11] TranscriptMiner already has 5-arg constructor**
- Actual committed code: `constructor(db, memoryManager, userProfile, config?, eventStore?)`
- Phase 2B (4-arg plan) moot — EventStore is ALREADY the 5th arg in committed code

### V2 (Integration Points) — KEY FINDING: Phase 1, 2, 3B, 4A, 4B, 4E ALREADY DONE

**Phases verified as ALREADY IMPLEMENTED in committed code:**

| Phase | Change | Status |
|-------|--------|--------|
| Phase 1 | LLMEntityExtractor in runtime.ts (lines 21, 57, 213-226) | ✅ DONE |
| Phase 2A | RECALL_MISS in EventType (types/index.ts:302) | ✅ DONE |
| Phase 2B | TranscriptMiner EventStore (lines 86-95, 362-363) | ✅ DONE |
| Phase 2C | rest-server.ts passes EventStore (both sites at 2979-2984, 3767-3772) | ✅ DONE |
| Phase 2D | ContextToolModule RECALL_MISS emission with cooldown (lines 974-979) | ✅ DONE |
| Phase 3B | .zshrc shell hook (lines 78-80) | ✅ DONE |
| Phase 4A | Embedding env vars in prod compose (OLLAMA_URL, GEMINI_API_KEY, OPENAI_API_KEY, OLLAMA_EMBED_MODEL) | ✅ DONE |
| Phase 4B | embeddingProvider in /health (rest-server.ts:415 via PingMemServerConfig) | ✅ DONE |
| Phase 4E | deploy-prod.sh exists (scripts/deploy-prod.sh, 899 bytes) | ✅ DONE |

**REMAINING WORK:**
| Phase | Change | Status |
|-------|--------|--------|
| Phase 0 | Pop stash@{0} + fix 4 regressions + caller updates | ❌ NOT DONE |
| Phase 3A | Plist exists but needs ThrottleInterval + log path update | 🔄 PARTIAL |
| Phase 4C | DreamingEngine docs | Unknown |
| Phase 4D | Consumer migration (cli.js → proxy-cli.js) | Unknown |

**[V2.12] LaunchAgent plist already exists (created this session)**
- Plist at `~/Library/LaunchAgents/com.ping-mem.daemon.plist` EXISTS
- Uses `dist/cli/index.js daemon start --foreground` (valid — confirmed shell-hook supported)
- MISSING: `ThrottleInterval` key — MUST ADD (crash loop risk)
- USING: `/tmp/ping-mem-daemon.log` — MUST UPDATE to `~/Library/Logs/ping-mem-daemon.log`
- Phase 3A is now "UPDATE plist" not "CREATE plist"

### V3 (Algorithms & Types) — 7/8 PASS

**[V3.1] GH#92 premise clarification**
- Plan claimed "score=0 when 1 result each" — INCORRECT. Code gives full credit (1.0) when range=0.
- ACTUAL REGRESSION: Filter drops results when a candidate appears in ONE search method and is the minimum scorer in that method (normalized score = 0). The fix (remove filter) is STILL CORRECT.
- Impact: rationale is slightly wrong, fix is right.

**[V3.3] queryBlastRadius in stash has NO LIMIT (only queryImpact has LIMIT 100)**
- GH#95 fix must explicitly add LIMIT to queryBlastRadius query as well (not just change LIMIT 100)

**[V3.4] LLM extraction IS already fire-and-forget in committed code**
- `ContextToolModule.ts:443-449` uses await for LLM extraction
- BUT the `extractionRouting.ts` may wrap it. EVAL-3 C1 finding may already be addressed in committed code — the fire-and-forget plan amendment applied to the STASH version. Since Phase 1 is DONE in committed code, verify the actual behavior.

### V4 (External Deps) — 11/12 PASS — All critical dependencies confirmed correct.

---

## REVIEW Amendments (Iteration 1 — 2026-04-09)

Three parallel REVIEW agents ran (Architecture, Simplicity/YAGNI, Delivery). Reconciliation below.

### REVIEW-1 Architecture — APPROVE WITH CONDITIONS

**[A2] codebase-extra.ts caller audit**: Verified — `grep -n "queryImpact|queryBlastRadius" src/http/routes/codebase-extra.ts` returns 0 matches. No action needed.

**[R1] Stash pop conflict detection**: ADDED to Phase 0-PRE — `git stash pop || { echo "CONFLICT"; exit 1; }` with instructions for runtime.ts conflict resolution.

**[A1] recallMissCooldown Map → single number**: ADOPTED (also REVIEW-2 S1) — replaced session-keyed `Map<string,number>` with module-level `let recallMissLastEmit = 0`.

**[A3] SSEPingMemServer embeddingService**: DEFERRED — prod uses REST transport only, SSE is dev-local. Added to debt-registry.md.

### REVIEW-2 Simplicity/YAGNI — APPROVE WITH CONDITIONS

**[S1] cooldown Map → single number**: ADOPTED — see REVIEW-1 A1.

All other items confirmed necessary:
- Caller chain (GH#95): 4 files required for type safety + truncated signal delivery
- Deploy script: outcome M3 IS automation
- Fire-and-forget LLM: correct minimal pattern
- Phase 4B 3-file embeddingService chain: minimum to thread typed config

### REVIEW-3 Delivery — APPROVE WITH CONDITIONS

**[D1] TRANSCRIPT_MINED has no consumer**: RECLASSIFIED as "audit log foundation". GH#101 created for consumer activation. Wiring Matrix W2 updated to reflect this. Debt registry entry added.

**[D2] RECALL_MISS has no consumer**: RECLASSIFIED as "audit log foundation". GH#102 created for consumer activation. Wiring Matrix W3 updated. Debt registry entry added.

**[D3] W5 requires manual VPS operator step**: ACCEPTED — plan acknowledges this; verification command confirms end-state. Cannot be fully automated without SSH key management automation (out of scope).

**Outcome-Anchored Reconciliation**:
Every REVIEW recommendation tested against stated outcomes. No cuts were made that break any of the 11 stated outcomes. W2 and W3 outcomes are accurately restated as "audit infrastructure" with consumer GH issues. All other outcomes remain deliverable by the plan.

---

## EVAL Amendments (Iteration 1 — 2026-04-09)

Three parallel EVAL agents ran. Below are all critical/high findings and amendments applied.

### EVAL-1 (Completeness) — SCORE: 44/100 — FAIL → Amended

**[C1-RESOLVED] Phase 0 regressions are in stash@{0}, not working tree**
- Root cause: Regressions were stashed (`git stash push -m "pre-capability-closure working tree"`) before session resumption
- Fix: Phase 0 now starts with `git stash pop stash@{0}` to restore working tree, then applies fixes inline

**[C3-CRITICAL] GH#95 return type change missing 3 caller files**
- `IngestionService.ts:418-422` — pass-through wrapper, must update return types
- `StructuralToolModule.ts:143,178` — must use `.files` and `.truncated`
- `rest-server.ts:1360,1377` — must use `.files` and pass `truncated` in response
- Fix: Added Phase 0D caller updates section (see below)

**[H1] Phase 4B embeddingService missing from HTTPServerConfig**
- Fix: Added `src/http/types.ts` to Phase 4B file list — must add `embeddingService?: EmbeddingService` to config type

**[H3] runtime.ts createRuntimeServices() ends at line ~184, not ~207**
- Fix: Phase 1A line reference corrected to "~184 (before `return services`)"

**[H4] PingMemServer.ts:405 direct stdio mode not updated for llmEntityExtractor**
- Stash already contains PingMemServer.ts changes (lines 34, 92, 187, 216 have llmEntityExtractor)
- Fix: Phase 1B now notes that stash application covers PingMemServer; verify after stash pop

### EVAL-2 (Safety) — SCORE: 61/100 — FAIL → Amended

**[C2-CRITICAL] Daemon plist missing ThrottleInterval**
- Risk: Crash loop with no back-off if daemon.ts fails repeatedly at startup
- Fix: Added `<key>ThrottleInterval</key><integer>30</integer>` to plist (see Phase 3A)

**[C3-CRITICAL] Deploy script missing second sed pattern (PING_MEM_PORT)**
- Prior plan (`2026-04-08`) had two-pattern sed. This plan regressed to one-pattern.
- Fix: Added second sed pattern for `PING_MEM_PORT=3003` → `PING_MEM_PORT=3000` (see Phase 4E)

**[H3] RECALL_MISS catch swallows errors with no logging**
- Risk: Wiring bugs (wrong EventType, session ID issues) are invisible during development
- Fix: Changed bare `.catch(() => {})` to `.catch((err) => { log.warn(...) })` (see Phase 2D)

**[H4] Log path /tmp/ping-mem-daemon.log cleared on reboot**
- Fix: Changed to `~/Library/Logs/ping-mem-daemon.log` (persistent, macOS LaunchAgent convention)

### EVAL-3 (Performance) — SCORE: 79/100 — CONDITIONAL PASS → Amended

**[C1-CRITICAL] LLM extraction is blocking on context_save hot path**
- Current ContextToolModule.ts:446 uses `await` for LLM extraction — adds 300-800ms to every qualifying save
- The entity IDs are not returned in the save response, so blocking provides zero benefit
- Fix: LLM extraction in Phase 1 must use fire-and-forget pattern (see Phase 1A note)

**[M1] RECALL_MISS storm risk in sparse-memory deployments**
- Hook calls context_auto_recall on every Claude Code prompt (~60/min in active sessions)
- Fix: Added 60-second per-session cooldown to Phase 2D implementation

---

## Prime Directive

**Built ≠ Wired ≠ Activated ≠ Delivers.**

ping-mem has four architectural layers. A capability must pass all four to deliver value:

| Layer | Question | Tools |
|-------|----------|-------|
| **Primitives** | Is the code written and compilable? | `bun run typecheck` |
| **Wiring** | Is it called from a user-facing path? | Wiring Matrix |
| **Harness** | Is it activated at the OS/deployment level? | Activation Gates |
| **Delivery** | Does a user/agent receive a different outcome because it ran? | Functional Tests |

This plan closes every gap across all four layers: 8 capability gaps (GAP-C1 through GAP-M3) + 4 regressions introduced in the current uncommitted diff (GH#92-95).

---

## Problem Statement

### Regression Layer (current uncommitted diff — must fix before commit)

| Issue | File | Lines | Bug | Impact |
|-------|------|-------|-----|--------|
| GH#92 | `src/search/CodeIndexer.ts` | 198 | `.filter(s => s.score > 0)` drops all results when normalization yields 0 | Precise queries silently return empty |
| GH#93 | `src/maintenance/MaintenanceRunner.ts` | 107–108 | `pruneOldEvents(14)` default destroys audit history | Maintenance run on 15-day-old install permanently deletes SESSION_* events |
| GH#94 | `src/storage/EventStore.ts` | 900–913 | `getStats()` returns `null` on SQLite error | `/api/v1/status` type violation breaks all downstream consumers |
| GH#95 | `src/graph/TemporalCodeGraph.ts` | 798–799 | `LIMIT 100` silently truncates blast-radius | Blast-radius analysis returns incomplete results with no signal |

Evidence: Codex `gpt-5.4-mini` review 2026-04-09; verified against `git diff HEAD`.

### Capability Gap Layer (built but not wired/activated/delivering)

| Gap | Severity | Root Cause | Layer Failure |
|-----|----------|------------|---------------|
| GAP-C1 | CRITICAL | `LLMEntityExtractor` never instantiated in `createRuntimeServices()` | Wiring |
| GAP-C2 | CRITICAL | Shell daemon not in `~/Library/LaunchAgents/`, `.zshrc` unwired | Harness |
| GAP-H1 | HIGH | `OLLAMA_URL`, `GEMINI_API_KEY`, `OPENAI_API_KEY` absent from `docker-compose.prod.yml` | Harness |
| GAP-H2 | HIGH | `TranscriptMiner` has TODO at line 357 — no EventStore wiring | Wiring |
| GAP-H3 | HIGH | Zero-result `context_auto_recall` returns nothing, emits nothing | Wiring |
| GAP-M1 | MEDIUM | `DreamingEngine` uses `callClaude()` directly, bypasses Ollama fallback | Architecture |
| GAP-M2 | MEDIUM | Some consumers still use `cli.js` direct SQLite mode | Deployment |
| GAP-M3 | MEDIUM | `docker-compose.prod.yml` port 3003 but prod Nginx expects 3000 | Harness |

Evidence from `docs/ping-mem-research/capability-audit-verified.md` (31 claims, 28 paper-verified).

### Confirmed Working (not in scope)

- Dreaming → save → auto_recall chain: FULLY WIRED (DreamingEngine saves `derived_insight`, recall includes it)
- DreamingEngine EventStore: emits `INSIGHT_DERIVED` at lines 180, 210, 441 — WIRED
- Claude Code hooks (auto-recall, native-sync): ACTIVE in `~/.claude/settings.json`
- Dev embedding fallback: OLLAMA → Gemini → OpenAI chain WORKING in `docker-compose.yml`

---

## Architecture: Layers and Primitives

```
┌─────────────────────────────────────────────────────────────┐
│  HARNESS LAYER (OS activation — LaunchAgents, env vars)     │
│  shell daemon plist · prod compose vars · port mapping       │
├─────────────────────────────────────────────────────────────┤
│  WIRING LAYER (code paths that connect primitives)           │
│  runtime.ts createRuntimeServices() · server startup         │
│  TranscriptMiner constructor · ContextToolModule recall path │
├─────────────────────────────────────────────────────────────┤
│  PRIMITIVES LAYER (always-available core)                    │
│  EventStore (SQLite) · MemoryManager · SessionManager        │
├─────────────────────────────────────────────────────────────┤
│  INTELLIGENCE LAYER (needs external providers)               │
│  LLMEntityExtractor (OPENAI) · DreamingEngine (Claude API)  │
│  EmbeddingService (Ollama/Gemini/OpenAI) · TranscriptMiner  │
└─────────────────────────────────────────────────────────────┘
```

The regression bugs (GH#92-95) corrupt the Primitives Layer. The capability gaps (GAP-*) are Wiring + Harness failures. Both must be fixed before the system can be called production-ready.

---

## Gap Coverage Matrix

| Gap/Issue | Phase | Component(s) | Layer Fixed | Outcome |
|-----------|-------|-------------|-------------|---------|
| GH#92 | 0 | `CodeIndexer.ts:198` | Primitives | Hybrid search never returns empty for valid queries |
| GH#93 | 0 | `MaintenanceRunner.ts:107-108` | Primitives | Event history preserved by default; pruning is opt-in |
| GH#94 | 0 | `EventStore.ts:900-913` | Primitives | getStats() always returns numbers; REST contract unbroken |
| GH#95 | 0 | `TemporalCodeGraph.ts:798-799` | Primitives | Blast-radius results complete or explicitly truncated |
| GAP-C1 | 1 | `runtime.ts`, `server.ts` | Wiring | LLM entity extraction active on high-value context_save |
| GAP-H2 | 2 | `TranscriptMiner.ts`, `rest-server.ts` | Wiring | Mining completions emit TRANSCRIPT_MINED events |
| GAP-H3 | 2 | `ContextToolModule.ts` | Wiring | Recall misses emit RECALL_MISS events |
| GAP-C2 | 3 | LaunchAgents plist, `.zshrc` | Harness | Shell daemon captures terminal activity |
| GAP-H1 | 4 | `docker-compose.prod.yml` | Harness | Prod embedding config explicit, health shows active provider |
| GAP-M1 | 4 | Docs only | Architecture | DreamingEngine LLM dependency documented |
| GAP-M2 | 4 | Consumer MCP configs | Deployment | Consumers use proxy-cli.js (no SQLite conflicts) |
| GAP-M3 | 4 | `scripts/deploy-prod.sh` | Harness | Port rewrite automated, no manual sed step on deploy |

---

## Critical Questions (All Self-Resolved)

**Q1: Is GH#92 a filter ADD or REMOVE?**
Decision: The uncommitted diff ADDED `.filter(s => s.score > 0)`. Fix: remove the filter entirely (committed code had no filter and is correct). When BM25+Qdrant each have one result, min-max normalization produces score=0 for all. Filtering zeros drops the entire result set. (Evidence: Codex review 2026-04-09; committed `CodeIndexer.ts:198` has no filter)

**Q2: GH#93 — what is the correct default for eventRetentionDays?**
Decision: No default — pruning must be opt-in. Change `options.eventRetentionDays ?? 14` to: only call `pruneOldEvents()` when `options.eventRetentionDays` is explicitly set. (Evidence: EventStore is the audit log; 14-day default destroys sessions on a typical install)

**Q3: GH#94 — should getStats() return null or 0 on SQLite error?**
Decision: Return 0 (numeric fallback) to maintain the existing return type contract. The REST endpoint expects `totalEvents: number`. A brief SQLite lock should not break type contracts. (Evidence: committed code returned 0; diff changed to null breaking callers)

**Q4: GH#95 — remove LIMIT 100 or make configurable?**
Decision: Remove the `LIMIT 100` from the Cypher query and apply `LIMIT $limit` using an explicit `maxResults` parameter (default 500 to bound performance). Add `truncated: boolean` to return shape if results hit the limit. (Evidence: blast-radius is a correctness-critical operation; silent truncation is worse than slowness)

**Q5: Should LLMEntityExtractor use regex fallback?**
Decision: Yes — pass `new EntityExtractor()` as `fallbackExtractor`. Already instantiated in `PingMemServer.ts:184`. (Evidence: `LLMEntityExtractor.ts:44` accepts optional `fallbackExtractor`)

**Q6: Is `openai` package installed?**
Decision: Yes — `package.json` has `"openai": "^6.16.0"`. No `bun add` needed. (Evidence: research agent grep result)

**Q7: Is `TRANSCRIPT_MINED` already in EventType union?**
Decision: Yes — already at `src/types/index.ts:301`. Only `RECALL_MISS` needs to be added. (Evidence: research agent grep result)

**Q8: Is `dist/cli/daemon.js` already compiled?**
Decision: Yes — built 2026-04-07 (6867 bytes). `bun run build` not required before creating plist. (Evidence: research agent ls result)

**Q9: What are exact TranscriptMiner construction sites?**
Decision: `src/http/rest-server.ts:2978-2982` and `src/http/rest-server.ts:3764-3768`. Both are 3-argument calls; add 4th `eventStore` argument. (Evidence: research agent read result)

---

## Implementation Phases

### Phase 0: Regression Fixes (P1 — commit blockers)

**Effort**: ~45 minutes | **Files**: 4 + 3 caller updates | **Gate**: `bun run typecheck && bun test` pass; all V0.x checks PASS

#### 0-PRE: Restore working tree from stash

The regressions exist in `stash@{0}` (labeled "pre-capability-closure working tree"). The working tree is currently clean (matches HEAD). All Phase 0 fixes must be applied to the stash changes, not to HEAD.

```bash
git stash pop stash@{0}
# This restores 19 files including CodeIndexer, MaintenanceRunner, EventStore, TemporalCodeGraph
# and also beneficial changes (runtime.ts, DreamingEngine.ts, docker-compose.yml, etc.)
# After pop: working tree has regressions. Apply fixes 0A-0D immediately.
```

**Conflict detection** (REVIEW-1 R1):
```bash
git stash pop stash@{0} || {
  echo "CONFLICT: stash pop failed — resolve conflicts in:"
  git diff --name-only --diff-filter=U
  echo "For runtime.ts conflicts: preserve BOTH the stash's LLM extractor additions AND any HEAD changes."
  echo "After resolving: git add <files> && git stash drop stash@{0}"
  exit 1
}
```

**Verify stash applied**: `git diff HEAD --stat | grep -c "src/"` should return ≥10.

#### 0A. Fix GH#92 — Remove zero-score filter from CodeIndexer.ts

**File**: `src/search/CodeIndexer.ts:198`

**Before** (current uncommitted diff, incorrect):
```typescript
return scored.filter(s => s.score > 0).slice(0, clampedLimit).map(s => ({ ...metaLookup.get(s.chunkId)!, score: s.score }));
```

**After**:
```typescript
return scored.slice(0, clampedLimit).map(s => ({ ...metaLookup.get(s.chunkId)!, score: s.score }));
```

Rationale: When BM25 and Qdrant each return 1 candidate, min-max normalization assigns all results score=0. The filter then drops the entire set. The committed code (without this filter) is correct.

#### 0B. Fix GH#93 — Make event pruning opt-in in MaintenanceRunner.ts

**File**: `src/maintenance/MaintenanceRunner.ts:107-108`

**Before** (current uncommitted diff, incorrect):
```typescript
const retentionDays = options.eventRetentionDays ?? 14;
const eventsPruned = dryRun ? 0 : this.eventStore.pruneOldEvents(retentionDays);
```

**After**:
```typescript
// Event pruning is opt-in only — EventStore is the immutable audit log
const eventsPruned = (!dryRun && options.eventRetentionDays != null)
  ? this.eventStore.pruneOldEvents(options.eventRetentionDays)
  : 0;
```

Rationale: EventStore is an immutable append-only log used for session replay and dashboard queries. Destroying 14-day-old events by default is destructive. Operators who want pruning must explicitly set `eventRetentionDays`.

#### 0C. Fix GH#94 — Keep numeric returns in getStats() in EventStore.ts

**File**: `src/storage/EventStore.ts:900-913`

**Before** (current uncommitted diff, incorrect — returns null on error):
```typescript
getStats(): { eventCount: number | null; checkpointCount: number | null; dbSize: number | null }
// ... catch blocks return null
```

**After** — restore numeric fallbacks, keep original return type:
```typescript
getStats(): { eventCount: number; checkpointCount: number; dbSize: number } {
  let eventCount = 0;
  try {
    eventCount = (this.stmtGetEventCount.get() as { count: number }).count;
  } catch { /* return 0 — never break callers */ }
  
  let checkpointCount = 0;
  try {
    checkpointCount = (this.stmtGetCheckpointCount.get() as { count: number }).count;
  } catch { /* return 0 */ }
  
  let dbSize = 0;
  if (this.config.dbPath !== ":memory:") {
    try {
      dbSize = fs.statSync(this.config.dbPath).size;
    } catch { /* return 0 */ }
  }
  
  return { eventCount, checkpointCount, dbSize };
}
```

Rationale: REST consumers model `totalEvents` as `number`. Returning null breaks them. 0 is safe — callers cannot distinguish "error" from "empty" but that is acceptable for a health probe.

#### 0D. Fix GH#95 — Replace hard LIMIT 100 with configurable limit + truncation signal in TemporalCodeGraph.ts

**File**: `src/graph/TemporalCodeGraph.ts:798-799`

**Before** (current uncommitted diff, incorrect):
```cypher
RETURN DISTINCT src.path AS file, min(depth) AS depth, via ORDER BY depth, src.path
LIMIT 100
```

**After** — use configurable `maxResults` param (default 500), add `truncated` to return:
```typescript
// queryImpact signature change:
async queryImpact(
  projectId: string,
  filePath: string,
  maxDepth = 5,
  maxResults = 500   // NEW — configurable with safe default
): Promise<{ files: Array<{file: string; depth: number; via: string[]}>; truncated: boolean }>

// In Cypher:
RETURN DISTINCT src.path AS file, min(depth) AS depth, via ORDER BY depth, src.path
LIMIT $maxResults

// After results:
const truncated = result.records.length === maxResults;
return { files: result.records.map(r => ({...})), truncated };
```

**Same change for `queryBlastRadius`**. Callers must handle the `{ files, truncated }` shape.

Rationale: Silent truncation at 100 is worse than no limit (incomplete analysis with no signal). Configurable default of 500 prevents unbounded queries while giving callers truncation awareness.

#### 0E. Update callers of queryImpact / queryBlastRadius (EVAL-1 C3)

Three additional files must be updated when `TemporalCodeGraph` return type changes to `{ files, truncated }`:

**File 1: `src/ingest/IngestionService.ts:418-422`**
```typescript
// Before:
async queryImpact(projectId: string, filePath: string, maxDepth?: number): Promise<Array<{ file: string; depth: number; via: string[] }>> {
  return this.codeGraph.queryImpact(projectId, filePath, maxDepth);
}
async queryBlastRadius(projectId: string, filePath: string, maxDepth?: number): Promise<Array<{ file: string; depth: number }>> {
  return this.codeGraph.queryBlastRadius(projectId, filePath, maxDepth);
}

// After:
async queryImpact(projectId: string, filePath: string, maxDepth?: number, maxResults?: number): Promise<{ files: Array<{ file: string; depth: number; via: string[] }>; truncated: boolean }> {
  return this.codeGraph.queryImpact(projectId, filePath, maxDepth, maxResults);
}
async queryBlastRadius(projectId: string, filePath: string, maxDepth?: number, maxResults?: number): Promise<{ files: Array<{ file: string; depth: number }>; truncated: boolean }> {
  return this.codeGraph.queryBlastRadius(projectId, filePath, maxDepth, maxResults);
}
```

**File 2: `src/mcp/handlers/StructuralToolModule.ts:143,178`**
```typescript
// At line ~143 (queryImpact call):
const result = await this.state.ingestionService.queryImpact(projectId, filePath, maxDepth, maxResults);
// Use result.files instead of result; include result.truncated in response

// At line ~178 (queryBlastRadius call):
const result = await this.state.ingestionService.queryBlastRadius(projectId, filePath, maxDepth, maxResults);
// Use result.files instead of result; include result.truncated in response
```

**File 3: `src/http/rest-server.ts:1360,1377`**
```typescript
// At line 1360 (queryImpact REST handler):
const result = await this.config.ingestionService.queryImpact(projectId, filePath, maxDepth, maxResults);
res.json({ files: result.files, truncated: result.truncated });

// At line 1377 (queryBlastRadius REST handler):
const result = await this.config.ingestionService.queryBlastRadius(projectId, filePath, maxDepth, maxResults);
res.json({ files: result.files, truncated: result.truncated });
```

Also add `maxResults` query param parsing in both REST handlers:
```typescript
const maxResults = req.query["maxResults"] ? Number(req.query["maxResults"]) : undefined;
```

---

### Phase 1: LLM Entity Extraction Activation (GAP-C1)

**Effort**: ~1 hour | **Files**: 3 | **Tests**: existing + 1 integration test
**Gate**: `bun run typecheck && bun test` pass; `OPENAI_API_KEY` set → `context_save` with 500+ char decision → entity in Neo4j graph.

#### 1A. Extend RuntimeServices and createRuntimeServices() in src/config/runtime.ts

**Imports to add** (after existing imports, before line 1):
```typescript
import { LLMEntityExtractor } from "../graph/LLMEntityExtractor.js";
import { EntityExtractor } from "../graph/EntityExtractor.js";
import OpenAI from "openai";
```

**RuntimeServices interface** (at `src/config/runtime.ts:44-54`), add after `embeddingService`:
```typescript
llmEntityExtractor?: LLMEntityExtractor;  // NEW
```

**At end of createRuntimeServices()** (line ~184, before `return services` — EVAL-1 H3 correction):
```typescript
const openAiKey = process.env["OPENAI_API_KEY"];
if (openAiKey && services.graphManager) {
  const openaiClient = new OpenAI({ apiKey: openAiKey });
  const fallbackExtractor = new EntityExtractor();
  services.llmEntityExtractor = new LLMEntityExtractor({
    openai: openaiClient,
    fallbackExtractor,
  });
  log.info("LLMEntityExtractor created (OpenAI gpt-4o-mini)");
} else if (!openAiKey) {
  log.info("LLMEntityExtractor disabled (OPENAI_API_KEY not set)");
} else {
  log.info("LLMEntityExtractor disabled (graphManager not available)");
}
```

#### 1B. Thread through server startup in src/http/server.ts

**At line 93** (RESTPingMemServer construction), add to config object:
```typescript
llmEntityExtractor: services.llmEntityExtractor,
```

**At line 113** (SSEPingMemServer construction), add to config object:
```typescript
llmEntityExtractor: services.llmEntityExtractor,
```

Note: `PingMemServer.ts:92` already has `llmEntityExtractor?: LLMEntityExtractor` in config type. The stash@{0} already contains PingMemServer.ts changes (lines 34, 92, 187, 216) — verify after stash pop that llmEntityExtractor is present in stdio mode too.

**CRITICAL: LLM extraction must be fire-and-forget** (EVAL-3 C1)
`ContextToolModule.ts:446` currently awaits the LLM extraction call, adding 300-800ms to the context_save hot path. Since entity IDs are not returned in the save response, this blocking provides zero user-visible benefit. The guard at line 443 must use fire-and-forget:

```typescript
// CORRECT (fire-and-forget — do NOT await):
if (useLlmExtraction && this.state.llmEntityExtractor) {
  void this.state.llmEntityExtractor.extract(value).then(async (llmResult) => {
    if (llmResult.entities.length > 0 && this.state.graphManager) {
      await this.state.graphManager.batchCreateEntities(llmResult.entities);
      // ... relationships ...
    }
  }).catch((err) => {
    log.warn("LLM entity extraction failed (async)", { error: err instanceof Error ? err.message : String(err) });
  });
}
// context_save returns immediately after the void — no latency added
```

---

### Phase 2: Event System Wiring — TranscriptMiner + RECALL_MISS (GAP-H2, GAP-H3)

**Effort**: ~1 hour | **Files**: 3 | **Tests**: 2 new integration tests
**Gate**: After `transcript_mine`, EventStore contains TRANSCRIPT_MINED event. After zero-result recall, EventStore contains RECALL_MISS event.

#### 2A. Add RECALL_MISS to EventType union in src/types/index.ts

`TRANSCRIPT_MINED` is already present (line 301). Add `RECALL_MISS`:
```typescript
// In EventType union, add after TRANSCRIPT_MINED:
| "RECALL_MISS"
```

Verify first: `grep -n "RECALL_MISS" src/types/index.ts` — must return 0 matches before edit.

#### 2B. Modify TranscriptMiner constructor in src/mining/TranscriptMiner.ts

**Add import** (top of file):
```typescript
import type { EventStore } from "../storage/EventStore.js";
```

**Add field** (in class body):
```typescript
private readonly eventStore: EventStore | null;
```

**Update constructor** (current 3-arg signature → 4-arg):
```typescript
constructor(
  db: Database,
  memoryManager: MemoryManager,
  userProfileStore: UserProfileStore | null,
  eventStore?: EventStore   // NEW optional 4th param
) {
  // ... existing body ...
  this.eventStore = eventStore ?? null;
}
```

**Replace TODO at lines 357-360** with:
```typescript
if (this.eventStore && saved > 0) {
  void this.eventStore.createEvent(
    "system",
    "TRANSCRIPT_MINED",
    { sessionFile, project, factsExtracted: saved }
  ).catch((err) => {
    log.warn("Failed to emit TRANSCRIPT_MINED event", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
return saved;
```

#### 2C. Pass EventStore at both construction sites in src/http/rest-server.ts

**Site 1** (lines 2978-2982):
```typescript
// Before:
this.transcriptMiner = new TranscriptMiner(
  this.eventStore.getDatabase(),
  memoryManager,
  this.userProfileStore
);

// After:
this.transcriptMiner = new TranscriptMiner(
  this.eventStore.getDatabase(),
  memoryManager,
  this.userProfileStore,
  this.eventStore   // NEW: wire EventStore for TRANSCRIPT_MINED events
);
```

**Site 2** (lines 3764-3768): Apply identical change.

#### 2D. Add RECALL_MISS emission in src/mcp/handlers/ContextToolModule.ts

**At lines 966-968** (zero-result path in `handleAutoRecall`):
```typescript
// Before:
if (filtered.length === 0) {
  return { recalled: false, reason: "no relevant memories found", context: "" };
}

// After:
if (filtered.length === 0) {
  if (this.state.eventStore) {
    // Cooldown: process-level 60s throttle to prevent RECALL_MISS storms
    // (hook fires on every Claude Code prompt; sparse-memory deployments miss on every call)
    // REVIEW-2 S1: single number, not per-session Map — per-session granularity adds no protection
    if (Date.now() - recallMissLastEmit > 60_000) {
      recallMissLastEmit = Date.now();  // module-level: let recallMissLastEmit = 0
      void this.state.eventStore.createEvent(
        this.state.currentSessionId ?? "system",
        "RECALL_MISS",
        { query: queryText, timestamp: Date.now() }
      ).catch((err) => {
        log.warn("Failed to emit RECALL_MISS event", {  // EVAL-2 H3: log, never swallow
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
  return { recalled: false, reason: "no relevant memories found", context: "" };
}
// Module-level: let recallMissLastEmit = 0; (add at top of ContextToolModule.ts module scope)
```

Note: `this.state.eventStore` is confirmed present — wired at `rest-server.ts:3639`.

---

### Phase 3: Shell Daemon Activation (GAP-C2)

**Effort**: ~1 hour | **Files**: 2 new system files + `.zshrc`
**Gate**: `launchctl list | grep com.ping-mem.daemon` shows non-dash PID. `type _ping_mem_send` returns "is a function".

#### 3A. Create LaunchAgent plist

**File**: `~/Library/LaunchAgents/com.ping-mem.daemon.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ping-mem.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/umasankr/.bun/bin/bun</string>
        <string>run</string>
        <string>/Users/umasankr/Projects/ping-mem/dist/cli/daemon.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PING_MEM_REST_URL</key>
        <string>http://localhost:3003</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/Users/umasankr/Library/Logs/ping-mem-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/umasankr/Library/Logs/ping-mem-daemon.log</string>
    <key>Nice</key>
    <integer>10</integer>
</dict>
</plist>
```

`ThrottleInterval: 30` — prevents crash loop: launchd waits 30s between restarts (EVAL-2 C2).
Log path is `~/Library/Logs/` (persistent across reboots, macOS LaunchAgent convention) — NOT `/tmp/` which is cleared on reboot (EVAL-2 H4).

**Load**: `launchctl load ~/Library/LaunchAgents/com.ping-mem.daemon.plist`

`dist/cli/daemon.js` is confirmed compiled (6867 bytes, 2026-04-07). No rebuild needed.

#### 3B. Wire shell hook in ~/.zshrc

**Append** (do not replace existing content):
```bash
# ping-mem shell integration
if command -v bun &>/dev/null && [[ -f /Users/umasankr/Projects/ping-mem/dist/cli/index.js ]]; then
  eval "$(bun run /Users/umasankr/Projects/ping-mem/dist/cli/index.js shell-hook zsh 2>/dev/null)"
fi
```

**Reload**: `source ~/.zshrc`

---

### Phase 4: Production Config + Medium Gaps (GAP-H1, GAP-M1, GAP-M2, GAP-M3)

**Effort**: ~1.5 hours | **Files**: `docker-compose.prod.yml`, docs, deploy script
**Gate**: `grep -E "OLLAMA_URL|GEMINI_API_KEY|OPENAI_API_KEY" docker-compose.prod.yml` returns 3 lines; prod health shows non-"none" embeddingProvider.

#### 4A. Add embedding env vars to docker-compose.prod.yml

**After line 69** (PING_MEM_MAX_AGENTS entry):
```yaml
    # Embedding provider — production requires at least one API key in .env
    - OLLAMA_URL=${OLLAMA_URL:-}
    - OLLAMA_EMBED_MODEL=${OLLAMA_EMBED_MODEL:-nomic-embed-text}
    - GEMINI_API_KEY=${GEMINI_API_KEY:-}
    - OPENAI_API_KEY=${OPENAI_API_KEY:-}
```

Operators must set at least one key in `/opt/ping-mem/.env` on VPS. The `/health` endpoint will show the active provider.

#### 4B. Add embeddingProvider to /health response

Three-step change required (EVAL-1 H1 — embeddingService not in HTTPServerConfig):

**Step 1: `src/http/types.ts`** — add to `HTTPServerConfig` interface:
```typescript
embeddingService?: EmbeddingService;  // NEW
```
Add import: `import type { EmbeddingService } from "../search/EmbeddingService.js";`

**Step 2: `src/http/rest-server.ts`** — add private field and use in /health:
```typescript
private readonly embeddingService: EmbeddingService | null;
// In constructor: this.embeddingService = config.embeddingService ?? null;
// In /health handler:
embeddingProvider: this.embeddingService?.providerName ?? "none (keyword-only)",
```

**Step 3: `src/http/server.ts:93`** — thread through at REST server construction:
```typescript
embeddingService: services.embeddingService,
```

#### 4C. Document DreamingEngine LLM requirement (GAP-M1 — docs only)

**In `docs/claude/architecture.md`**, add to DreamingEngine section:

> **DreamingEngine LLM dependency**: DreamingEngine calls `callClaude()` directly (bypassing the Ollama/Gemini fallback chain in EmbeddingService). Claude API access via `CLAUDE_API_KEY` is required for dreaming. In environments without Claude API access, dreaming silently fails. Tracked for future routing through LLMProxy.

#### 4D. Audit and migrate cli.js consumers (GAP-M2)

```bash
grep -r "cli.js\|ping-mem" ~/.claude/settings.json
grep -r "cli.js" ~/Projects/*/CLAUDE.md 2>/dev/null
```

For each `cli.js` reference, replace with proxy-cli.js pattern:
```json
{
  "command": "bun",
  "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/proxy-cli.js"],
  "env": { "PING_MEM_REST_URL": "http://localhost:3003" }
}
```

#### 4E. Automate port rewrite in deploy script (GAP-M3)

**Create `scripts/deploy-prod.sh`**:
```bash
#!/bin/bash
set -euo pipefail
VPS_HOST="72.62.117.123"
VPS_PATH="/opt/ping-mem"

echo "Syncing to VPS..."
rsync -av --exclude='.env' --exclude='node_modules' --exclude='.git' \
  /Users/umasankr/Projects/ping-mem/ root@${VPS_HOST}:${VPS_PATH}/

echo "Patching port for VPS (3003 -> 3000)..."
ssh root@${VPS_HOST} \
  "sed -i 's/127.0.0.1:3003:3003/127.0.0.1:3000:3000/g; s/PING_MEM_PORT=3003/PING_MEM_PORT=3000/g' ${VPS_PATH}/docker-compose.prod.yml"
# Two-pattern sed: port binding + env var (EVAL-2 C3 — restored from prior plan's deploy script)

echo "Restarting containers..."
ssh root@${VPS_HOST} "cd ${VPS_PATH} && docker compose -f docker-compose.prod.yml up -d --build"
echo "Deploy complete."
```

`chmod +x scripts/deploy-prod.sh`

---

## Database Schema Definitions

No new tables. Only TypeScript type additions:

```typescript
// src/types/index.ts — add to EventType union:
| "RECALL_MISS"

// queryImpact / queryBlastRadius return type additions:
// Before: Array<{file: string; depth: number; via: string[]}>
// After: { files: Array<{file: string; depth: number; via: string[]}>; truncated: boolean }
```

Verify `TRANSCRIPT_MINED` already present before adding `RECALL_MISS`:
```bash
grep -n "TRANSCRIPT_MINED\|RECALL_MISS" src/types/index.ts
# Expected: 1 match (TRANSCRIPT_MINED at line 301), 0 for RECALL_MISS
```

---

## Function Signatures

### Phase 0 Changes

```typescript
// src/storage/EventStore.ts
getStats(): { eventCount: number; checkpointCount: number; dbSize: number }
// RESTORED from pre-diff state — no null returns

// src/graph/TemporalCodeGraph.ts
async queryImpact(
  projectId: string,
  filePath: string,
  maxDepth?: number,      // default 5
  maxResults?: number     // default 500, NEW
): Promise<{ files: Array<{ file: string; depth: number; via: string[] }>; truncated: boolean }>

async queryBlastRadius(
  projectId: string,
  filePath: string,
  maxDepth?: number,
  maxResults?: number
): Promise<{ files: Array<{ file: string; depth: number }>; truncated: boolean }>
```

### Phase 1 Changes

```typescript
// src/config/runtime.ts
export interface RuntimeServices {
  // ... existing ...
  llmEntityExtractor?: LLMEntityExtractor;  // NEW
}
export async function createRuntimeServices(): Promise<RuntimeServices>
```

### Phase 2 Changes

```typescript
// src/mining/TranscriptMiner.ts
constructor(
  db: Database,
  memoryManager: MemoryManager,
  userProfileStore: UserProfileStore | null,
  eventStore?: EventStore   // NEW optional 4th param
)
```

### Unchanged / Verified

```typescript
// src/graph/LLMEntityExtractor.ts
constructor(config: { openai: OpenAI; fallbackExtractor?: EntityExtractor; model?: string })
async extract(text: string): Promise<{ entities: Entity[]; relationships: Relationship[]; confidence: number }>

// src/storage/EventStore.ts
async createEvent(sessionId: string, type: EventType, data: Record<string, unknown>): Promise<void>
```

---

## Integration Points

### Phase 0

| File | Line(s) | Change |
|------|---------|--------|
| PREREQ: `git stash pop stash@{0}` | — | Restore working tree with regressions |
| `src/search/CodeIndexer.ts` | 198 | Remove `.filter(s => s.score > 0)` |
| `src/maintenance/MaintenanceRunner.ts` | 107–108 | Change default-14-day pruning to opt-in |
| `src/storage/EventStore.ts` | 900–913 | Restore numeric returns in getStats() |
| `src/graph/TemporalCodeGraph.ts` | 798–799 | Replace LIMIT 100 with configurable $maxResults |
| `src/ingest/IngestionService.ts` | 418–422 | Update queryImpact/queryBlastRadius return types |
| `src/mcp/handlers/StructuralToolModule.ts` | 143, 178 | Use `.files` / `.truncated` from new return type |
| `src/http/rest-server.ts` | 1360, 1377 | Use `.files` / `.truncated`, add `maxResults` query param |

### Phase 1

| File | Line(s) | Change |
|------|---------|--------|
| `src/config/runtime.ts` | 9–22 (imports), 44–54 (interface), ~207 (before return) | Add LLMEntityExtractor |
| `src/http/server.ts` | 93 (REST config), 113 (MCP config) | Add `llmEntityExtractor: services.llmEntityExtractor` |

### Phase 2

| File | Line(s) | Change |
|------|---------|--------|
| `src/types/index.ts` | EventType union | Add `\| "RECALL_MISS"` |
| `src/mining/TranscriptMiner.ts` | imports, constructor, 357–360 | Add EventStore param + replace TODO |
| `src/http/rest-server.ts` | 2978–2982, 3764–3768 | Pass `this.eventStore` as 4th arg |
| `src/mcp/handlers/ContextToolModule.ts` | 966–968 | Emit RECALL_MISS on zero results |

### Phase 3

| Target | Action |
|--------|--------|
| `~/Library/LaunchAgents/com.ping-mem.daemon.plist` | CREATE |
| `~/.zshrc` | APPEND shell hook eval line |

### Phase 4

| File | Change |
|------|--------|
| `docker-compose.prod.yml` | Add 4 embedding env vars |
| `src/http/types.ts` | Add `embeddingService?: EmbeddingService` to HTTPServerConfig |
| `src/http/rest-server.ts` | Add embeddingService field + embeddingProvider to /health |
| `src/http/server.ts` | Thread `embeddingService: services.embeddingService` to REST config |
| `docs/claude/architecture.md` | Document DreamingEngine LLM requirement |
| `scripts/deploy-prod.sh` | CREATE deploy automation with two-pattern port sed |

---

## Wiring Matrix

| # | Capability | Layer | User Trigger | Call Path (file:line) | Activation Gate | Test |
|---|-----------|-------|-------------|----------------------|-----------------|------|
| W0a | Hybrid search returns results for precise queries | Primitives | Any codebase_search | `CodeIndexer.ts:198` — no zero-score filter | None (code fix) | Query with 1 matching file → ≥1 result returned |
| W0b | Event history preserved after maintenance run | Primitives | `memory_maintain` | `MaintenanceRunner.ts:107-108` — opt-in only | None (code fix) | Run maintain without eventRetentionDays → events from 15 days ago still present |
| W0c | /api/v1/status always returns numeric stats | Primitives | GET /api/v1/status | `EventStore.ts:getStats()` → returns numbers | None (code fix) | SQLite lock → getStats() returns `{eventCount:0}` not null |
| W0d | Blast-radius returns complete results with truncation signal | Primitives | codebase_blast_radius | `TemporalCodeGraph.ts:queryBlastRadius()` → `{files, truncated}` | None (code fix) | Large graph → result.truncated === true when > maxResults |
| W1 | LLM entity extraction on high-value context_save | Wiring | context_save with category=decision, content>500 | `ContextToolModule.ts:443` → `state.llmEntityExtractor.extract()` → `graphManager.batchCreateEntities()` | `OPENAI_API_KEY` in env; `createRuntimeServices()` returns non-null `llmEntityExtractor` | Save 500+ char decision → `context_query_relationships` returns entities |
| W2 | TRANSCRIPT_MINED event infrastructure (audit log foundation) | Wiring | transcript_mine MCP tool or POST /api/v1/mining/mine | `rest-server.ts:2978` → `TranscriptMiner.mine()` → `processMessages()` → `eventStore.createEvent("TRANSCRIPT_MINED")` | `TranscriptMiner` constructed with EventStore at `rest-server.ts:2978` | After mine → GET /api/v1/events?type=TRANSCRIPT_MINED returns ≥1. **Consumer activation tracked in [GH#101](https://github.com/usorama/ping-mem/issues/101)** |
| W3 | RECALL_MISS event infrastructure (audit log foundation) | Wiring | context_auto_recall with no-match query | `ContextToolModule.ts:966` → `eventStore.createEvent("RECALL_MISS")` | `state.eventStore` non-null (confirmed at `rest-server.ts:3639`) | Recall "xyzzy123" → GET /api/v1/events?type=RECALL_MISS returns ≥1. **Consumer activation tracked in [GH#102](https://github.com/usorama/ping-mem/issues/102)** |
| W4 | Shell daemon captures terminal activity | Harness | cd to any dir in terminal | `~/.zshrc _ping_mem_chpwd` → `nc -U /tmp/ping-mem-$(id-u).sock` → `daemon.ts` → `POST http://localhost:3003/api/v1/shell/event` | `launchctl list \| grep com.ping-mem.daemon` shows PID | `launchctl list com.ping-mem.daemon` exits 0 with non-dash PID |
| W5 | Prod semantic search (not BM25-only) | Harness | context_auto_recall or context_hybrid_search on prod | `EmbeddingService.createEmbedding()` → Gemini/OpenAI API → Qdrant similarity | `GEMINI_API_KEY` or `OPENAI_API_KEY` in VPS `.env`; `GET /health` shows non-"none" embeddingProvider | `curl https://ping-mem.ping-gadgets.com/health \| jq .embeddingProvider` ≠ "none" |

**Status per capability before this plan**:
- W0a: Built=YES (diff broke it) | Wired=YES | Activated=YES | Delivers=NO → Phase 0 fixes
- W0b: Built=YES (diff broke it) | Wired=YES | Activated=YES | Delivers=NO → Phase 0 fixes
- W0c: Built=YES (diff broke it) | Wired=YES | Activated=YES | Delivers=NO → Phase 0 fixes
- W0d: Built=YES (diff broke it) | Wired=YES | Activated=YES | Delivers=NO → Phase 0 fixes
- W1: Built=YES | Wired=NO | Activated=NO | Delivers=NO → Phase 1 fixes
- W2: Built=YES | Wired=NO | Activated=NO | Delivers=NO → Phase 2 fixes
- W3: Built=NO | Wired=NO | Activated=NO | Delivers=NO → Phase 2 builds+wires
- W4: Built=YES | Wired=NO | Activated=NO | Delivers=NO → Phase 3 fixes
- W5: Built=YES | Wired=NO | Activated=UNKNOWN | Delivers=UNKNOWN → Phase 4 fixes

---

## Activation Gates

| Component | Load Command | Verify Running | On Failure |
|-----------|-------------|----------------|------------|
| Shell daemon | `launchctl load ~/Library/LaunchAgents/com.ping-mem.daemon.plist` | `launchctl list com.ping-mem.daemon` — non-dash PID | `cat /tmp/ping-mem-daemon.log`; verify `dist/cli/daemon.js` exists |
| Shell hook | `source ~/.zshrc` | `type _ping_mem_send` — "is a function" | Verify eval line in `~/.zshrc`; verify `dist/cli/index.js` exists |
| LLM extractor | None (env var conditional) | `grep OPENAI_API_KEY .env` + restart | Set `OPENAI_API_KEY` and restart container |
| Prod embedding | Set vars in VPS `.env`, restart | `curl https://ping-mem.ping-gadgets.com/health \| jq .embeddingProvider` ≠ "none" | Set `GEMINI_API_KEY` or `OPENAI_API_KEY` in `/opt/ping-mem/.env` |

---

## Verification Checklist

### Phase 0 Checks

```bash
# V0.1: zero-score filter removed from CodeIndexer
grep -n "filter.*score.*> 0" src/search/CodeIndexer.ts
# PASS: 0 matches | FAIL: 1+ matches

# V0.2: event pruning is opt-in in MaintenanceRunner
grep -n "pruneOldEvents" src/maintenance/MaintenanceRunner.ts
# PASS: only executed inside `if (options.eventRetentionDays != null)` block | FAIL: unconditional call

# V0.3: getStats() return type is numeric (no null)
grep -n "number | null" src/storage/EventStore.ts
# PASS: 0 matches in getStats() context | FAIL: null in return type

# V0.4: LIMIT in TemporalCodeGraph uses parameter, not literal 100
grep -n "LIMIT 100" src/graph/TemporalCodeGraph.ts
# PASS: 0 matches | FAIL: literal LIMIT 100 present

# V0.5: queryImpact/queryBlastRadius return truncated field
grep -n "truncated" src/graph/TemporalCodeGraph.ts
# PASS: ≥2 matches | FAIL: 0 matches
```

### Phase 1 Checks

```bash
# V1.1: LLMEntityExtractor imported in runtime.ts
grep -n "LLMEntityExtractor" src/config/runtime.ts
# PASS: ≥2 matches (import + instantiation) | FAIL: 0

# V1.2: llmEntityExtractor field in RuntimeServices
grep -n "llmEntityExtractor" src/config/runtime.ts
# PASS: ≥3 matches (interface + conditional + log) | FAIL: 0

# V1.3: llmEntityExtractor threaded in server.ts (both server constructors)
grep -c "llmEntityExtractor" src/http/server.ts
# PASS: 2 | FAIL: <2
```

### Phase 2 Checks

```bash
# V2.1: RECALL_MISS in EventType union
grep -n "RECALL_MISS" src/types/index.ts
# PASS: 1 match | FAIL: 0

# V2.2: EventStore import in TranscriptMiner
grep -n "EventStore" src/mining/TranscriptMiner.ts
# PASS: ≥2 matches | FAIL: 0

# V2.3: TRANSCRIPT_MINED emitted in TranscriptMiner (TODO removed)
grep -n "TRANSCRIPT_MINED" src/mining/TranscriptMiner.ts
# PASS: 1 match | FAIL: 0 (TODO still present)

# V2.4: TranscriptMiner 4-arg construction in rest-server.ts
grep -A4 "new TranscriptMiner" src/http/rest-server.ts | grep -c "eventStore"
# PASS: 2 | FAIL: <2

# V2.5: RECALL_MISS emission in ContextToolModule
grep -n "RECALL_MISS" src/mcp/handlers/ContextToolModule.ts
# PASS: 1 match | FAIL: 0
```

### Phase 3 Checks

```bash
# V3.1: LaunchAgent plist created
ls ~/Library/LaunchAgents/com.ping-mem.daemon.plist
# PASS: file exists | FAIL: No such file

# V3.2: Shell hook in .zshrc
grep -n "ping-mem" ~/.zshrc
# PASS: eval line present | FAIL: 0 matches

# V3.3: Daemon running
launchctl list com.ping-mem.daemon
# PASS: exit 0, non-dash PID | FAIL: exit 1 or PID is -
```

### Phase 4 Checks

```bash
# V4.1: Embedding env vars in prod compose
grep -c "OLLAMA_URL\|GEMINI_API_KEY\|OPENAI_API_KEY" docker-compose.prod.yml
# PASS: 3 | FAIL: <3

# V4.2: TypeScript compiles with 0 errors
bun run typecheck
# PASS: exit 0 | FAIL: any errors

# V4.3: Tests pass
bun test
# PASS: exit 0, 0 failures | FAIL: any failures
```

---

## Functional Tests

| # | Test | Command | Expected Output | Wiring Row |
|---|------|---------|-----------------|------------|
| FT0a | Hybrid search returns result for single match | `bun -e "import {CodeIndexer} from './src/search/CodeIndexer.ts'; const ci = new CodeIndexer(); const r = await ci.search('unique_function_name', {limit:5}); console.log(r.length > 0 ? 'PASS' : 'FAIL')"` | `PASS` | W0a |
| FT0b | Maintenance preserves events without retention flag | Start server, add events, run maintain without `eventRetentionDays`, verify event still present via GET /api/v1/events | Event from 2 days ago still present | W0b |
| FT0c | getStats returns numeric on SQLite stress | `bun test src/storage/__tests__/EventStore.test.ts` | 0 failures (existing tests verify numeric return) | W0c |
| FT0d | Blast-radius returns truncated flag | `curl 'http://localhost:3003/api/v1/codebase/blast-radius?filePath=src/http/rest-server.ts&maxResults=2'` | Response includes `truncated: true` if >2 dependencies | W0d |
| FT1 | LLM extractor instantiated | `OPENAI_API_KEY=sk-test bun -e "import {createRuntimeServices} from './src/config/runtime.ts'; const s = await createRuntimeServices(); console.log(s.llmEntityExtractor ? 'PRESENT' : 'NULL')"` | `PRESENT` | W1 |
| FT2 | TRANSCRIPT_MINED emitted after mining | Call `transcript_mine`, then `GET /api/v1/events?type=TRANSCRIPT_MINED` | ≥1 event returned | W2 |
| FT3 | RECALL_MISS emitted on empty recall | `curl -X POST http://localhost:3003/api/v1/context/auto_recall -d '{"query":"xyzzy123nonexistent"}'` then GET /api/v1/events?type=RECALL_MISS | ≥1 RECALL_MISS event | W3 |
| FT4 | Daemon running | `launchctl list com.ping-mem.daemon` | Exit 0, non-dash PID | W4 |
| FT5 | Shell hook active | `source ~/.zshrc && type _ping_mem_send` | "is a function" | W4 |
| FT6 | Prod health shows embedding provider | `curl https://ping-mem.ping-gadgets.com/health \| python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('embeddingProvider','none')!='none'"` | No assertion error | W5 |

---

## Acceptance Criteria

### Functional

- [ ] **AC-F1**: `context_save` of 500+ char decision → entity appears in Neo4j (`context_query_relationships` non-empty). Requires OPENAI_API_KEY.
- [ ] **AC-F2**: `transcript_mine` → `GET /api/v1/events?type=TRANSCRIPT_MINED` returns ≥1 event.
- [ ] **AC-F3**: `context_auto_recall` with non-matching query → `GET /api/v1/events?type=RECALL_MISS` returns ≥1 event.
- [ ] **AC-F4**: `launchctl list com.ping-mem.daemon` exits 0 with non-dash PID.
- [ ] **AC-F5**: `type _ping_mem_send` returns "is a function".
- [ ] **AC-F6**: Prod `GET /health` returns `embeddingProvider` ≠ "none".
- [ ] **AC-F7**: Precise hybrid search query returns ≥1 result (zero-score regression fixed).
- [ ] **AC-F8**: `bun run typecheck && bun test` pass with 0 errors and 0 failures.
- [ ] **AC-F9**: Blast-radius result includes `truncated: boolean` field.
- [ ] **AC-F10**: `memory_maintain` without `eventRetentionDays` preserves all events.

### Non-Functional

- [ ] **AC-NF1**: `context_auto_recall` p99 latency unchanged (RECALL_MISS is fire-and-forget).
- [ ] **AC-NF2**: `context_save` p99 latency unchanged when `OPENAI_API_KEY` unset (guard is a no-op).
- [ ] **AC-NF3**: Shell daemon KeepAlive verified — kill → restarts within 5s.
- [ ] **AC-NF4**: All existing tests still pass after all phases.

---

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| queryImpact callers don't handle `{files, truncated}` return type | TypeScript error or runtime breakage | Medium | Audit all callers of queryImpact/queryBlastRadius; update REST endpoints to pass through the truncated flag |
| openai `^6.x` API surface different from `^4.x` docs | LLMEntityExtractor constructor fails | Low | `openai@6.16.0` is installed, confirmed. LLMEntityExtractor tests use the actual package — if tests pass, API is compatible. |
| RECALL_MISS event volume too high | EventStore growth | Low | Events are small JSON; opt-in pruning (GH#93 fix) handles cleanup when needed |
| Daemon binary path wrong | LaunchAgent fails to start | Low | `/Users/umasankr/.bun/bin/bun` verified via `which bun`. `dist/cli/daemon.js` confirmed at 6867 bytes. |
| VPS `.env` missing API keys after prod compose fix | Prod still BM25-only | High | Phase 4B adds `/health` embeddingProvider field for visibility. Document required vars explicitly. |
| ContextToolModule caller of `state.currentSessionId` is null | RECALL_MISS event stored under "system" | Low | Acceptable — "system" is a valid fallback session. Events are still queryable. |

---

## Complete File Structure

```
ping-mem/
├── src/
│   ├── config/
│   │   └── runtime.ts              MODIFIED — add LLMEntityExtractor (Phase 1)
│   ├── graph/
│   │   └── TemporalCodeGraph.ts    MODIFIED — configurable limit + truncated return (Phase 0)
│   ├── http/
│   │   ├── types.ts                MODIFIED — add embeddingService to HTTPServerConfig (Phase 4)
│   │   ├── server.ts               MODIFIED — thread llmEntityExtractor + embeddingService (Phase 1, 4)
│   │   └── rest-server.ts          MODIFIED — TranscriptMiner 4-arg ×2 (Phase 2); embeddingProvider health (Phase 4); queryImpact/queryBlastRadius callers (Phase 0)
│   ├── maintenance/
│   │   └── MaintenanceRunner.ts    MODIFIED — opt-in event pruning (Phase 0)
│   ├── mcp/
│   │   └── handlers/
│   │       └── ContextToolModule.ts MODIFIED — emit RECALL_MISS (Phase 2)
│   ├── mining/
│   │   └── TranscriptMiner.ts      MODIFIED — add EventStore param + emit TRANSCRIPT_MINED (Phase 2)
│   ├── search/
│   │   └── CodeIndexer.ts          MODIFIED — remove zero-score filter (Phase 0)
│   ├── storage/
│   │   └── EventStore.ts           MODIFIED — restore numeric getStats() (Phase 0)
│   └── types/
│       └── index.ts                MODIFIED — add RECALL_MISS to EventType (Phase 2)
├── docker-compose.prod.yml          MODIFIED — add embedding env vars (Phase 4)
├── scripts/
│   └── deploy-prod.sh               NEW — deploy automation with port rewrite (Phase 4)
└── docs/
    └── claude/
        └── architecture.md         MODIFIED — DreamingEngine LLM note (Phase 4)

~/Library/LaunchAgents/
└── com.ping-mem.daemon.plist        NEW — shell daemon LaunchAgent (Phase 3)

~/.zshrc                             MODIFIED — append shell hook (Phase 3)
```

---

## Dependencies

| Dependency | Version | Status | Notes |
|-----------|---------|--------|-------|
| `openai` npm | `^6.16.0` | INSTALLED (`package.json` verified) | Required for Phase 1 LLMEntityExtractor |
| OpenAI API key | N/A | Runtime env var | Phase 1 — extractor skipped when absent |
| Bun runtime | `1.x` | Installed | Daemon plist uses `/Users/umasankr/.bun/bin/bun` |
| launchctl | macOS built-in | Active | Phase 3 daemon activation |
| nc (netcat) | macOS built-in | Active | Shell hook Unix socket communication |

---

## Success Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Hybrid search zero-result rate (precise queries) | Broken (uncommitted diff) | 0 regressions | FT0a |
| Event history after maintenance | Destroyed (uncommitted diff) | Preserved by default | FT0b |
| getStats() type contract | Broken (uncommitted diff) | Numeric always | V0.3 |
| Blast-radius completeness signal | None (silent truncation) | truncated: boolean | FT0d |
| LLM entity extraction coverage | 0% of saves | 100% of decision-category saves with OPENAI_API_KEY | AC-F1 |
| Mining event visibility | 0 TRANSCRIPT_MINED events | ≥1 per mine | AC-F2 |
| Recall miss observability | 0 RECALL_MISS events | ≥1 on any zero-result recall | AC-F3 |
| Shell daemon active | Not running | launchctl shows PID | AC-F4 |
| Prod embedding provider | Unknown | Non-"none" on health | AC-F6 |
| TypeScript errors | 0 | 0 (maintained) | V4.2 |
| Test pass rate | 100% | 100% (maintained) | V4.3 |
