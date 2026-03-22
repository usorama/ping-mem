---
title: "feat: Auto-Capture Hooks, Progressive Disclosure Search, and FSRS Memory Decay"
type: feat
date: 2026-03-22
status: ready
github_issues: []
github_pr: null
research: docs/auto-capture-research/ (5 documents, 726 lines, 12+ sources)
synthesis: docs/auto-capture-research/05-synthesis.md
eval_iteration: 2
review_iteration: 1
verification_iteration: 2
verification_method: "3-agent binary verification (42 claims, 13 findings fixed, sources: codebase grep, file reads, API docs)"
---

# Auto-Capture Hooks, Progressive Disclosure Search, and FSRS Memory Decay

## Problem Statement

ping-mem requires explicit `context_save` MCP calls for every memory. This means:
1. **Memory doesn't build itself** — agents must be instructed to save memories (via CLAUDE.md prompts)
2. **Search returns full values** — every `context_search` result includes the complete value, consuming 500+ tokens/result when only 80 tokens would suffice for triage
3. **All memories decay identically** — the current `0.97^days` formula (23-day half-life) treats decisions the same as ephemeral observations

Evidence: claude-mem (39K stars) solves #1 via PostToolUse hooks capturing observations automatically. Their progressive disclosure achieves ~10x token savings.

## Proposed Solution

Three enhancements to ping-mem, each independently shippable:

### Enhancement 1: Auto-Capture via Claude Code Hooks
- Shell scripts for PostToolUse, SessionStart, and Stop hooks
- POST to new `POST /api/v1/observations/capture` REST endpoint
- Content-hash dedup (SHA-256 truncated, 30s window)
- Fire-and-forget (async curl, <50ms impact)

### Enhancement 2: Progressive Disclosure Search
- Add `compact: true` parameter to `context_search` MCP tool and `GET /api/v1/search` REST endpoint
- Compact mode returns `{id, key, category, snippet, score}` (~80 tokens/result vs ~500)
- Full details fetched via existing `context_get` by memory ID

### Enhancement 3: FSRS Memory Decay with Per-Category Stability
- Replace `0.97^days` with FSRS power-law: `(1 + 0.2346 * t_days/S_days)^(-0.5)`
- Per-category stability: observations=3d, facts=30d, decisions=180d, pinned=never
- Access-weighted boost: `1 + 0.3 * ln(1 + access_count) * exp(-t_last/168h)`
- `cached_decay_score` column for batch updates

---

## Gap Coverage Matrix

| Gap | Resolution | Phase | Component |
|-----|-----------|-------|-----------|
| No auto-capture hooks | PostToolUse/SessionStart/Stop shell scripts | 1 | Hook scripts + ObservationCaptureService |
| No capture REST endpoint | `POST /api/v1/observations/capture` | 1 | rest-server.ts + ObservationCaptureService |
| No content-hash dedup | SHA-256 truncated hash, 30s time window | 1 | ObservationCaptureService |
| Search returns full values | `compact` mode on context_search + REST search | 2 | ContextToolModule + rest-server.ts |
| Fixed decay for all categories | Per-category stability constants | 3 | RelevanceEngine |
| Exponential decay inaccurate | FSRS power-law formula | 3 | RelevanceEngine |
| No access-weighted boost | Logarithmic access boost with recency weighting | 3 | RelevanceEngine |
| No cached scores | `cached_decay_score` column + batch job | 3 | RelevanceEngine + MaintenanceRunner |

---

## Implementation Phases

### Phase 1: Auto-Capture Hooks + Observation Service (3 files new, 2 files modified)

**Quality Gate**: `POST /api/v1/observations/capture` accepts a PostToolUse payload, stores observation, returns 201. Hook script calls it successfully from a test invocation.

#### Task 1.1: Create ObservationCaptureService

**File**: `src/observation/ObservationCaptureService.ts` (NEW)

```typescript
import { createHash } from "crypto";
import type { EventStore } from "../storage/EventStore.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("ObservationCaptureService");

export interface CaptureInput {
  sessionId: string;
  claudeSessionId: string;
  toolName: string;
  toolUseId: string;
  project: string;
  cwd: string;
  toolInput: Record<string, unknown>;
  toolResponse: Record<string, unknown>;
  hookEvent: "post_tool_use" | "session_start" | "session_stop";
}

export interface CaptureResult {
  captured: boolean;
  observationId?: string;
  deduplicated?: boolean;
  reason?: string;
}

interface ContentHashEntry {
  hash: string;
  timestamp: number;
}

export class ObservationCaptureService {
  private readonly eventStore: EventStore;
  private readonly recentHashes: Map<string, ContentHashEntry> = new Map();
  private readonly DEDUP_WINDOW_MS = 30_000;
  private readonly HASH_LENGTH = 16;

  constructor(eventStore: EventStore) {
    this.eventStore = eventStore;
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    // 1. Build content string for hashing (uses raw input for dedup only — never stored)
    const content = this.buildContentString(input);

    // 2. Content-hash dedup
    const hash = this.computeHash(content);
    if (this.isDuplicate(hash)) {
      return { captured: false, deduplicated: true, reason: "duplicate within 30s window" };
    }

    // 3. Extract files touched (paths only, no content)
    const filesTouched = this.extractFiles(input);

    // 4. Build observation summary — SECURITY: only summary string stored, never raw toolInput/toolResponse
    const summary = this.redactSecrets(this.buildSummary(input));

    // 5. Store as OBSERVATION_CAPTURED event — positional args per EventStore API
    // EventStore.createEvent(sessionId, eventType, payload, metadata?, causedBy?)
    const event = await this.eventStore.createEvent(
      input.sessionId,
      "OBSERVATION_CAPTURED" as EventType,
      {
        toolName: input.toolName,
        toolUseId: input.toolUseId,
        project: input.project,
        summary,            // redacted compact string — NEVER raw tool input/output
        filesTouched,       // file paths only
        contentHash: hash,
        hookEvent: input.hookEvent,
        claudeSessionId: input.claudeSessionId,
      },
    );

    // 6. Record hash for dedup window
    this.recentHashes.set(hash, { hash, timestamp: Date.now() });
    this.cleanupHashes();

    return { captured: true, observationId: event.eventId };
  }

  private computeHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, this.HASH_LENGTH);
  }

  private isDuplicate(hash: string): boolean {
    const entry = this.recentHashes.get(hash);
    if (!entry) return false;
    return Date.now() - entry.timestamp < this.DEDUP_WINDOW_MS;
  }

  private cleanupHashes(): void {
    const cutoff = Date.now() - this.DEDUP_WINDOW_MS;
    for (const [key, entry] of this.recentHashes) {
      if (entry.timestamp < cutoff) this.recentHashes.delete(key);
    }
  }

  private buildContentString(input: CaptureInput): string {
    return JSON.stringify({
      tool: input.toolName,
      input: input.toolInput,
      response: input.toolResponse,
    });
  }

  private extractFiles(input: CaptureInput): string[] {
    const files: string[] = [];
    const filePath = input.toolInput?.file_path;
    if (typeof filePath === "string") files.push(filePath);
    const respPath = input.toolResponse?.filePath;
    if (typeof respPath === "string" && !files.includes(respPath)) files.push(respPath);
    return files;
  }

  private buildSummary(input: CaptureInput): string {
    const { toolName, toolInput, toolResponse } = input;
    switch (toolName) {
      case "Bash": {
        // Store only first word (executable name) + exit code — never full command (may contain secrets)
        const cmd = String(toolInput?.command ?? "");
        const executable = cmd.split(/\s/)[0] || "?";
        const desc = String(toolInput?.description ?? "").slice(0, 100);
        return `Ran: ${executable} (${desc}) → exit ${toolResponse?.exitCode ?? "?"}`;
      }
      case "Write":
        return `Wrote: ${toolInput?.file_path ?? "?"}`;
      case "Edit":
        return `Edited: ${toolInput?.file_path ?? "?"}`;
      case "Read":
        return `Read: ${toolInput?.file_path ?? "?"} (${toolResponse?.numLines ?? "?"} lines)`;
      case "Grep":
        return `Grep: ${toolInput?.pattern ?? "?"} in ${toolInput?.path ?? "."}`;
      default:
        // For MCP and other tools: store only tool name, never payload
        return `${toolName}: (tool call recorded)`;
    }
  }

  // SECURITY: Redact patterns matching secrets from summary strings
  private redactSecrets(text: string): string {
    return text
      .replace(/Bearer\s+[A-Za-z0-9_\-\.]{10,}/gi, "Bearer [REDACTED]")
      .replace(/\b(ghp_|gho_|sk-|sk_live_|pk_live_|xoxb-|xoxp-)[A-Za-z0-9_\-]{10,}/g, "[REDACTED_TOKEN]")
      .replace(/(password|passwd|secret|token|api_key)\s*[=:]\s*\S+/gi, "$1=[REDACTED]");
  }
}
```

#### Task 1.2: Add REST endpoint for observation capture

**File**: `src/http/rest-server.ts` (MODIFY — add route after worklog routes at ~line 2580)

**Integration point**: After existing worklog GET route, before catch-all.

**Wiring — explicit steps**:
1. Add import: `import { ObservationCaptureService } from "../observation/ObservationCaptureService.js";`
2. Add class property: `private observationCaptureService: ObservationCaptureService;`
3. In constructor, after `this.eventStore` is assigned: `this.observationCaptureService = new ObservationCaptureService(this.eventStore);`
4. Add route in `setupRoutes()`:

```typescript
// POST /api/v1/observations/capture — auto-capture from Claude Code hooks
// Rate limit: dedicated higher limit for high-frequency hook traffic
this.app.post("/api/v1/observations/capture", async (c) => {
  const body = await c.req.json();
  const sessionId = c.req.header("X-Session-ID") || body.sessionId;

  if (!sessionId) {
    return c.json({ success: false, error: "Session ID required" }, 400);
  }

  // SECURITY: Validate session exists in SessionManager
  const session = this.sessionManager.getSession(sessionId);
  if (!session) {
    return c.json({ success: false, error: "Invalid or expired session" }, 401);
  }

  const result = await this.observationCaptureService.capture({
    sessionId,
    claudeSessionId: body.claudeSessionId || "",
    toolName: body.payload?.toolName || body.toolName || "",
    toolUseId: body.payload?.toolUseId || body.toolUseId || "",
    project: body.payload?.project || body.project || "",
    cwd: body.payload?.cwd || body.cwd || "",
    toolInput: body.payload?.toolInput || body.toolInput || {},
    toolResponse: body.payload?.toolResponse || body.toolResponse || {},
    hookEvent: body.eventType || body.hookEvent || "post_tool_use",
  });

  return c.json({ success: true, data: result }, result.captured ? 201 : 200);
});
```

**Rate limit note**: The existing `/api/v1/*` rate limiter is 60 req/min per IP. Since hooks fire from localhost on every tool call, add a dedicated higher limit (300 req/min) for `/api/v1/observations/capture` applied before the general limiter.

#### Task 1.3: Create hook shell scripts

**File**: `~/.claude/hooks/ping-mem-capture-post-tool.sh` (NEW)

```bash
#!/bin/bash
# Auto-capture PostToolUse observations to ping-mem
PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "$CWD")
# SECURITY: Truncate tool_input to 500 bytes, strip content/new_string fields (may contain secrets)
TOOL_INPUT=$(echo "$INPUT" | jq -c '(.tool_input // {}) | del(.content, .new_string) | tostring | .[0:500]' | jq -R 'fromjson? // {}')
# SECURITY: Only extract safe metadata from tool_response — never stdout (may contain secrets)
TOOL_RESPONSE=$(echo "$INPUT" | jq -c '{exitCode: (.tool_response.exitCode // null), success: (.tool_response.success // null), numLines: (.tool_response.numLines // null)}')

# Skip MCP tools (they're ping-mem's own tools — avoid infinite loop)
if [[ "$TOOL_NAME" == mcp__ping* ]]; then exit 0; fi

# Read cached ping-mem session
SESSION_CACHE="$HOME/.ping-mem/sync-session-id"
PM_SESSION=""
[ -f "$SESSION_CACHE" ] && PM_SESSION=$(cat "$SESSION_CACHE")
[ -z "$PM_SESSION" ] && exit 0

# Fire-and-forget POST
curl -s -X POST "$PING_MEM_URL/api/v1/observations/capture" \
  -H 'Content-Type: application/json' \
  -H "X-Session-ID: $PM_SESSION" \
  -d "$(jq -n \
    --arg claude_session "$SESSION_ID" \
    --arg tool "$TOOL_NAME" \
    --arg tool_use_id "$TOOL_USE_ID" \
    --arg project "$PROJECT" \
    --arg cwd "$CWD" \
    --argjson tool_input "$TOOL_INPUT" \
    --argjson tool_response "$TOOL_RESPONSE" \
    '{
      eventType: "post_tool_use",
      claudeSessionId: $claude_session,
      toolName: $tool,
      toolUseId: $tool_use_id,
      project: $project,
      cwd: $cwd,
      payload: {
        toolName: $tool,
        toolUseId: $tool_use_id,
        project: $project,
        cwd: $cwd,
        toolInput: $tool_input,
        toolResponse: $tool_response
      }
    }')" \
  --max-time 1 \
  > /dev/null 2>&1 &

exit 0
```

**File**: `~/.claude/hooks/ping-mem-capture-stop.sh` (NEW)

```bash
#!/bin/bash
# Capture session stop summary to ping-mem
PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "$CWD")
# SECURITY: Do NOT send last_assistant_message — LLM output may echo secrets

SESSION_CACHE="$HOME/.ping-mem/sync-session-id"
PM_SESSION=""
[ -f "$SESSION_CACHE" ] && PM_SESSION=$(cat "$SESSION_CACHE")
[ -z "$PM_SESSION" ] && exit 0

curl -s -X POST "$PING_MEM_URL/api/v1/observations/capture" \
  -H 'Content-Type: application/json' \
  -H "X-Session-ID: $PM_SESSION" \
  -d "$(jq -n \
    --arg claude_session "$SESSION_ID" \
    --arg project "$PROJECT" \
    '{
      eventType: "session_stop",
      claudeSessionId: $claude_session,
      project: $project,
      payload: {
        toolName: "session_stop",
        project: $project,
        cwd: "",
        toolInput: {},
        toolResponse: {}
      }
    }')" \
  --max-time 1 \
  > /dev/null 2>&1 &

exit 0
```

#### Task 1.4: Register hooks in settings.json

**File**: `~/.claude/settings.json` (MODIFY — add to existing hooks section)

Add to `PostToolUse` hooks array:
```json
{
  "matcher": "Bash|Write|Edit|Read|Grep|Glob|Agent",
  "hooks": [
    {
      "type": "command",
      "command": "bash ~/.claude/hooks/ping-mem-capture-post-tool.sh",
      "timeout": 5,
      "async": true
    }
  ]
}
```

Add to `Stop` hooks array:
```json
{
  "hooks": [
    {
      "type": "command",
      "command": "bash ~/.claude/hooks/ping-mem-capture-stop.sh",
      "timeout": 5,
      "async": true
    }
  ]
}
```

#### Task 1.5: Verify session cache file population

**File**: `~/.claude/hooks/ping-mem-native-sync.sh` (EXISTING — already writes `~/.ping-mem/sync-session-id`)

The existing `SessionStart` hook `ping-mem-native-sync.sh` already calls `POST /api/v1/session/start` and writes the resulting session ID to `~/.ping-mem/sync-session-id`. Verify this file is populated with `chmod 600` permissions. If the file is not being written, the entire auto-capture chain silently fails (hooks exit 0 when `PM_SESSION` is empty).

**Verification**: `ls -la ~/.ping-mem/sync-session-id` should show mode 600 and a valid UUID content.
**Fix if missing**: Add `chmod 600 "$SESSION_CACHE"` after the `echo "$PING_MEM_SESSION" > "$SESSION_CACHE"` line in `ping-mem-native-sync.sh`.

#### Task 1.6: Register OBSERVATION_CAPTURED event type

**File**: `src/types/index.ts` (MODIFY)

Add `| "OBSERVATION_CAPTURED"` to the `EventType` string union type at `src/types/index.ts:277`.

---

### Phase 2: Progressive Disclosure Search (0 files new, 2 files modified)

**Quality Gate**: `context_search` with `compact: true` returns results with truncated values; `GET /api/v1/search?compact=true` returns snippet-only results. Token savings verified: compact result < 100 tokens vs full result > 400 tokens.

#### Task 2.1: Add compact mode to context_search MCP handler

**File**: `src/mcp/handlers/ContextToolModule.ts` (MODIFY — handleSearch method at ~line 768; dispatch at line 224 unchanged)

Add `compact` boolean to input schema. When `compact: true`, map recall results to:

```typescript
if (args.compact) {
  return {
    count: results.length,
    results: results.map(r => ({
      id: r.id,
      key: r.key,
      category: r.category,
      snippet: r.value.slice(0, 80) + (r.value.length > 80 ? "..." : ""),
      score: r.score,
      createdAt: r.createdAt,
    })),
    hint: "Use context_get with memory key to fetch full value",
  };
}
```

#### Task 2.2: Add compact mode to REST search endpoint

**File**: `src/http/rest-server.ts` (MODIFY — GET /api/v1/search handler ~line 1415)

Add `compact` query parameter. When truthy, truncate `memory.value` to 80 chars in response:

```typescript
const compact = c.req.query("compact") === "true";
// ... existing search logic ...
const responseData = matches.map(({ memory, score }) => ({
  memory: compact
    ? { id: memory.id, key: memory.key, category: memory.category,
        snippet: memory.value.slice(0, 80) + (memory.value.length > 80 ? "..." : ""),
        priority: memory.priority, createdAt: memory.createdAt }
    : memory,
  score: weightedScore,
}));
```

#### Task 2.3: Update context_auto_recall to use compact internally

**File**: `src/mcp/handlers/ContextToolModule.ts` (MODIFY — handleAutoRecall ~line 234)

The auto-recall formatted block already truncates values in the `[1] (82%) key: value` format. Ensure the value is truncated to 100 chars max in the formatted output (it currently may include full values).

---

### Phase 3: FSRS Memory Decay with Per-Category Stability (0 files new, 2 files modified)

**Quality Gate**: `RelevanceEngine.recalculateRelevance()` uses FSRS power-law. Category-based stability verified: a decision memory 30 days old scores higher than an observation 30 days old. `cached_decay_score` column populated by `memory_maintain`.

#### Task 3.1: Upgrade RelevanceEngine scoring formula

**File**: `src/memory/RelevanceEngine.ts` (MODIFY)

Replace the decay formula in `computeRelevance()` method (private, at ~line 714):

**Before** (line ~714):
```typescript
const decayMultiplier = Math.pow(this.config.decayFactor, daysSinceAccess);
```

**After**:
```typescript
// FSRS power-law: R(t,S) = (1 + FACTOR * t_days/S_days)^DECAY
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81; // 0.2346

const stabilityDays = CATEGORY_STABILITY_DAYS[category] ?? 30;
const decayMultiplier = Math.pow(1 + FSRS_FACTOR * (daysSinceAccess / stabilityDays), FSRS_DECAY);

// Access-weighted boost — derive hoursSinceAccess from daysSinceAccess
const hoursSinceAccess = daysSinceAccess * 24;
const accessBoost = 1 + 0.3 * Math.log(1 + accessCount)
  * Math.exp(-hoursSinceAccess / 168);
```

Then where the final score is computed, multiply by `accessBoost`:
```typescript
const score = baseScore * decayMultiplier * accessBoost;
```

Add category stability constants:

```typescript
const CATEGORY_STABILITY_DAYS: Record<string, number> = {
  decision: 180,
  error: 90,
  task: 30,
  warning: 30,
  fact: 30,
  observation: 3,
  progress: 7,
  note: 14,
};
```

#### Task 3.2: Add cached_decay_score to memory_relevance table

**File**: `src/memory/RelevanceEngine.ts` (MODIFY — initializeSchema)

Add column in `initializeSchema()` (at ~line 265), AFTER the existing CREATE TABLE. Use `db.run()` for the ALTER wrapped in try/catch that swallows "duplicate column" errors. Also add a separate prepared statement `stmtUpdateCachedScore` for batch updates, or extend the existing upsert to include `cached_decay_score`.

#### Task 3.3: Update MaintenanceRunner to batch-refresh cached scores

**File**: `src/maintenance/MaintenanceRunner.ts` (MODIFY)

1. Add `refreshedScores: number` to the `MaintenanceResult` interface (~line 20-29).
2. Add step between consolidate and prune with null guard:

```typescript
// Step 2.5: Refresh cached decay scores
const refreshed = this.relevanceEngine ? this.relevanceEngine.recalculateAll() : 0;
log.info(`Refreshed ${refreshed} cached decay scores`);
```

3. Include `refreshedScores: refreshed` in the returned `MaintenanceResult` object.

#### Task 3.4: Update REST search to use cached_decay_score

**File**: `src/http/rest-server.ts` (MODIFY — GET /api/v1/search)

Replace the `relevanceEngine.getRelevanceScore(memory.id)` call with reading `cached_decay_score` from the relevance row when available, falling back to live computation.

---

## Database Schema Definitions

### New Event Type

```sql
-- No new table. OBSERVATION_CAPTURED added to EventType union.
-- Events table already supports arbitrary event types.
-- Payload schema for OBSERVATION_CAPTURED:
-- {
--   toolName: string,
--   toolUseId: string,
--   project: string,
--   summary: string,
--   filesTouched: string[],
--   contentHash: string (16 chars),
--   hookEvent: "post_tool_use" | "session_start" | "session_stop",
--   claudeSessionId: string
-- }
```

### Schema Modification

```sql
-- Add cached_decay_score column to memory_relevance table
-- (migration-safe: uses ALTER TABLE with error handling for existing column)
ALTER TABLE memory_relevance ADD COLUMN cached_decay_score REAL DEFAULT 1.0;
CREATE INDEX IF NOT EXISTS idx_memory_relevance_decay ON memory_relevance(cached_decay_score DESC);
```

---

## Function Signatures

| Function | File | Signature |
|----------|------|-----------|
| `ObservationCaptureService.capture` | `src/observation/ObservationCaptureService.ts` | `async capture(input: CaptureInput): Promise<CaptureResult>` |
| `ObservationCaptureService.computeHash` | same | `private computeHash(content: string): string` |
| `ObservationCaptureService.isDuplicate` | same | `private isDuplicate(hash: string): boolean` |
| `ObservationCaptureService.buildSummary` | same | `private buildSummary(input: CaptureInput): string` |
| `ObservationCaptureService.extractFiles` | same | `private extractFiles(input: CaptureInput): string[]` |

---

## Integration Points

| What | File:Line | Before | After |
|------|-----------|--------|-------|
| REST observation endpoint | `src/http/rest-server.ts:~2580` | No route | `POST /api/v1/observations/capture` |
| Compact search MCP | `src/mcp/handlers/ContextToolModule.ts:768` | Returns full Memory objects | Adds `compact` input param, returns snippets when true |
| Compact search REST | `src/http/rest-server.ts:1415` | Returns full memory.value | Adds `compact` query param, truncates value |
| FSRS decay formula | `src/memory/RelevanceEngine.ts:~714` | `baseScore * 0.97^days` | `baseScore * fsrs_decay * access_boost` |
| Category stability | `src/memory/RelevanceEngine.ts:~50` | Single decay factor | `CATEGORY_STABILITY_DAYS` record |
| cached_decay_score column | `src/memory/RelevanceEngine.ts:initializeSchema` | No column | `ALTER TABLE memory_relevance ADD COLUMN cached_decay_score` |
| Batch score refresh | `src/maintenance/MaintenanceRunner.ts:~step 2-3` | No batch refresh | `recalculateAll()` called during maintenance |
| EventType union | `src/types/index.ts` | No OBSERVATION_CAPTURED | Add `OBSERVATION_CAPTURED` |
| PostToolUse hook | `~/.claude/settings.json` | No capture hook | `ping-mem-capture-post-tool.sh` |
| Stop hook | `~/.claude/settings.json` | No capture hook | `ping-mem-capture-stop.sh` |

---

## Wiring Matrix

| Capability | User Trigger | Call Path | Integration Test |
|------------|-------------|-----------|------------------|
| Auto-capture PostToolUse | Any tool use in Claude Code | Claude Code PostToolUse hook → `ping-mem-capture-post-tool.sh` → `curl POST /api/v1/observations/capture` → `ObservationCaptureService.capture()` → `EventStore.createEvent()` | `curl -X POST localhost:3003/api/v1/observations/capture -d '...' -H 'X-Session-ID: test'` returns 201 |
| Auto-capture Stop | Claude finishes response | Claude Code Stop hook → `ping-mem-capture-stop.sh` → `curl POST /api/v1/observations/capture` → `ObservationCaptureService.capture()` | `curl -X POST localhost:3003/api/v1/observations/capture -d '{eventType: "session_stop", ...}'` returns 201 |
| Content-hash dedup | Rapid duplicate tool calls | `ObservationCaptureService.capture()` → `computeHash()` → `isDuplicate()` → returns `{captured: false, deduplicated: true}` | POST same payload twice within 1s → second returns `deduplicated: true` |
| Compact search (MCP) | Agent calls `context_search` with `compact: true` | `ContextToolModule.handleSearch({compact: true})` → `MemoryManager.recall()` → truncate results | MCP tool call with compact flag returns snippet-only results |
| Compact search (REST) | `GET /api/v1/search?query=x&compact=true` | `rest-server.ts` handler → adds `compact` param → truncates output | `curl 'localhost:3003/api/v1/search?query=test&compact=true'` returns snippets |
| FSRS decay scoring | Any memory retrieval or maintenance | `RelevanceEngine.recalculateRelevance()` uses FSRS formula | Unit test: 30-day-old decision scores > 30-day-old observation |
| Per-category stability | Automatic (built into scoring) | `CATEGORY_STABILITY_DAYS[category]` lookup in `recalculateRelevance()` | Unit test: category lookup returns correct stability |
| Batch score refresh | `memory_maintain` MCP tool call | `MaintenanceRunner.run()` → `RelevanceEngine.recalculateAll()` | `memory_maintain` returns `refreshedScores` count > 0 |

---

## Verification Checklist

| # | Check | Command | Expected | PASS/FAIL |
|---|-------|---------|----------|-----------|
| 1 | ObservationCaptureService file exists | `ls src/observation/ObservationCaptureService.ts` | File exists | |
| 2 | OBSERVATION_CAPTURED in EventType | `grep -r 'OBSERVATION_CAPTURED' src/types/` | Match found | |
| 3 | REST route registered | `grep -r 'observations/capture' src/http/` | Match in rest-server.ts | |
| 4 | Hook script exists | `ls ~/.claude/hooks/ping-mem-capture-post-tool.sh` | File exists | |
| 5 | Hook registered in settings | `grep 'ping-mem-capture-post-tool' ~/.claude/settings.json` | Match found | |
| 6 | compact param in context_search schema | `grep -A5 'compact' src/mcp/handlers/ContextToolModule.ts` | Schema property found | |
| 7 | compact param in REST search | `grep 'compact' src/http/rest-server.ts` | Query param handling found | |
| 8 | FSRS constants in RelevanceEngine | `grep 'FSRS_FACTOR' src/memory/RelevanceEngine.ts` | Constants defined | |
| 9 | CATEGORY_STABILITY_DAYS defined | `grep 'CATEGORY_STABILITY_DAYS' src/memory/RelevanceEngine.ts` | Record defined | |
| 10 | cached_decay_score ALTER | `grep 'cached_decay_score' src/memory/RelevanceEngine.ts` | ALTER TABLE found | |
| 11 | Batch refresh in MaintenanceRunner | `grep 'recalculateAll' src/maintenance/MaintenanceRunner.ts` | Method call found | |
| 12 | Skip ping-mem MCP tools in hook | `grep 'mcp__ping' ~/.claude/hooks/ping-mem-capture-post-tool.sh` | Guard present | |

---

## Functional Tests

| # | Test Name | Command | Expected Output |
|---|-----------|---------|-----------------|
| 1 | Capture endpoint accepts observation | `curl -s -X POST http://localhost:3003/api/v1/observations/capture -H 'Content-Type: application/json' -H 'X-Session-ID: test-session' -d '{"toolName":"Bash","toolUseId":"t1","project":"test","cwd":"/tmp","payload":{"toolName":"Bash","toolInput":{"command":"echo hello"},"toolResponse":{"stdout":"hello","exitCode":0}}}'` | `{"success":true,"data":{"captured":true,"observationId":"..."}}` with HTTP 201 |
| 2 | Capture dedup within 30s | Same curl as #1 run twice within 1s | Second response: `{"success":true,"data":{"captured":false,"deduplicated":true}}` |
| 3 | Compact search returns snippets | `curl -s 'http://localhost:3003/api/v1/search?query=test&compact=true' -H 'X-Session-ID: test-session'` | Results contain `snippet` field (max 83 chars: 80 + "..."), NO full `value` field |
| 4 | Full search still works | `curl -s 'http://localhost:3003/api/v1/search?query=test' -H 'X-Session-ID: test-session'` | Results contain full `memory.value` field |
| 5 | RelevanceEngine FSRS scoring | `bun test src/memory/__tests__/RelevanceEngine.test.ts` | All tests pass including FSRS decay tests |
| 6 | Decision decays slower than observation | Unit test assertion: `score(decision, 30d) > score(observation, 30d)` | Decision score > observation score |
| 7 | Hook script is executable | `bash -n ~/.claude/hooks/ping-mem-capture-post-tool.sh && echo VALID` | `VALID` (no syntax errors) |
| 8 | Hook skips ping-mem MCP tools | `echo '{"tool_name":"mcp__ping_mem__context_save","session_id":"x","cwd":"/tmp"}' \| bash ~/.claude/hooks/ping-mem-capture-post-tool.sh; echo $?` | Exit code 0, no curl called |
| 9 | memory_maintain refreshes scores | `curl -s -X POST http://localhost:3003/api/v1/memory/maintain -H 'Content-Type: application/json' -H 'X-Session-ID: test-session' -d '{"dryRun":false}'` | Response includes `refreshedScores` > 0 |

---

## Acceptance Criteria

### Functional
- [ ] PostToolUse hook automatically captures observations for Bash/Write/Edit/Read/Grep/Glob/Agent tool calls
- [ ] Stop hook captures session summary with last assistant message
- [ ] Duplicate observations within 30s are deduplicated via content hash
- [ ] `context_search` with `compact: true` returns snippet-only results (<100 tokens each)
- [ ] `GET /api/v1/search?compact=true` returns snippet-only results
- [ ] RelevanceEngine uses FSRS power-law decay formula
- [ ] Decisions (S=180d) decay slower than observations (S=3d)
- [ ] `memory_maintain` batch-refreshes cached decay scores

### Non-Functional
- [ ] Hook scripts execute in <50ms (async, fire-and-forget)
- [ ] No Claude Code latency impact (all hooks use `async: true`)
- [ ] Graceful degradation: hooks silently exit 0 when ping-mem is unreachable
- [ ] All existing tests pass: `bun run typecheck && bun run lint && bun test`

---

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Hook flood (rapid tool calls) | Many observations stored | Medium | Content-hash dedup + async fire-and-forget + can add rate-limiting lockfile |
| ping-mem down when hooks fire | Lost observations | Low | Hooks exit 0 silently; observations are supplementary, not critical |
| FSRS formula breaks existing relevance scores | Memories sorted incorrectly | Low | New formula applied on recalculateAll(); old scores overwritten cleanly |
| Large tool_response in payload | Oversized curl POST | Medium | Hook truncates tool_response via jq to first 2KB |
| SQLite ALTER TABLE fails if column exists | Schema error on restart | Low | Wrap in try/catch, ignore "duplicate column" error |

---

## Complete File Structure (post-implementation)

```
src/observation/
  ObservationCaptureService.ts           # NEW
  __tests__/
    ObservationCaptureService.test.ts    # NEW

src/http/rest-server.ts                  # MODIFIED (new route)
src/mcp/handlers/ContextToolModule.ts    # MODIFIED (compact param)
src/memory/RelevanceEngine.ts            # MODIFIED (FSRS + category stability)
src/maintenance/MaintenanceRunner.ts     # MODIFIED (batch refresh step)
src/types/index.ts                       # MODIFIED (OBSERVATION_CAPTURED event)

~/.claude/hooks/
  ping-mem-capture-post-tool.sh          # NEW
  ping-mem-capture-stop.sh               # NEW

~/.claude/settings.json                  # MODIFIED (new hook entries)
```

---

## Dependencies

No new external packages. All implementation uses:
- `crypto` (Node.js built-in) — for SHA-256 hashing
- `bun:sqlite` (existing) — for schema ALTER
- Existing `EventStore`, `MemoryManager`, `RelevanceEngine`

---

## Success Metrics

| Metric | Baseline | Phase 1 Target | Phase 2 Target | Phase 3 Target | Measurement |
|--------|----------|---------------|---------------|---------------|-------------|
| Auto-captured observations/session | 0 | 15-50 | 15-50 | 15-50 | COUNT events WHERE type=OBSERVATION_CAPTURED |
| Tokens per search result | ~500 | ~500 | ~80 (compact) | ~80 | Measure formatted output length |
| Dedup hit rate | N/A | >20% | >20% | >20% | Deduplicated / total capture attempts |
| Decision memory half-life | 23 days | 23 days | 23 days | 125 days (FSRS@S=180d) | RelevanceEngine unit test |
| Observation memory half-life | 23 days | 23 days | 23 days | 2.1 days (FSRS@S=3d) | RelevanceEngine unit test |
| Hook execution latency | N/A | <50ms | <50ms | <50ms | Time from hook start to exit 0 |

---

## EVAL Amendments (iteration 2)

13 findings from 3 parallel EVAL/VERIFY agents. All CRITICAL and HIGH addressed:

| # | Finding | Severity | Amendment |
|---|---------|----------|-----------|
| A | `EventStore.createEvent` takes positional args, not object | CRITICAL | Fixed in Task 1.1 code: `createEvent(sessionId, "OBSERVATION_CAPTURED" as EventType, {...})` |
| B | `ObservationCaptureService` not wired into server | CRITICAL | Added explicit wiring steps in Task 1.2: import, property, constructor init |
| C | `MaintenanceResult` missing `refreshedScores` + null guard | CRITICAL | Fixed in Task 3.3: add field to interface, null guard on `this.relevanceEngine` |
| D | Full tool_response stored (secrets in stdout) | CRITICAL | Fixed: hook strips stdout, service stores only `summary` string, never raw input/response |
| E | Raw toolInput stored in event payload | HIGH | Fixed: payload stores only `summary`, `filesTouched`, `contentHash` — never raw toolInput |
| F | buildSummary leaks Bash commands with secrets | HIGH | Fixed: Bash case stores only executable name + description, not full command |
| G | last_assistant_message may contain secrets | HIGH | Fixed: Stop hook no longer sends last_assistant_message |
| H | No session validation on capture endpoint | HIGH | Fixed: Task 1.2 validates session exists via `sessionManager.getSession()` |
| I | Rate limit too low for hook traffic | MEDIUM | Added note: dedicated 300 req/min limit for `/observations/capture` |
| J | Session cache file population unspecified | HIGH | Added Task 1.5: verify existing hook writes it, add chmod 600 |
| K | Wrong line numbers (decay@95, search@224, route@1500) | HIGH | Fixed: decay@714, handleSearch@768, route@2580 |
| L | ALTER TABLE description contradicts itself | HIGH | Fixed: clarified try/catch approach, removed CREATE TABLE confusion |
| M | Observations are events not memories — not in context_search | MEDIUM | Noted: observations are queryable via event API; adding to context_search is future scope |
