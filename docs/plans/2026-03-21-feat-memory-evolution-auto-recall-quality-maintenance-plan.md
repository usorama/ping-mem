---
title: "feat: Memory Evolution — Bidirectional Hooks, Quality Gates, Self-Maintenance"
type: feat
date: 2026-03-21
status: ready
github_issues: [51, 52, 53, 54, 55, 56, 57, 58, "understory#21"]
github_pr: null
research: docs/memory-evolution-research/ (1 synthesis, external ~/Projects/research/AGENT-MEMORY-SYSTEMS-COMPARISON.md)
synthesis: docs/memory-evolution-research/1-synthesis.md
eval_iteration: 0
review_iteration: 0
verification_iteration: 0
verification_method: "5-agent codebase verification against actual source"
revision: 2
revision_reason: "v1 relied on CLAUDE.md instruction for auto-recall (voluntary). v2 uses UserPromptSubmit hook (deterministic). Added Stop hook for automatic write capture. Both directions are now hook-driven."
---

# Memory Evolution: Bidirectional Hooks, Quality Gates, Self-Maintenance

## Problem Statement

ping-mem has strong infrastructure (Neo4j, Qdrant, SQLite, 19 MCP tools) but the memory system fails bidirectionally:

### READ failure: Agent must decide to recall
`context_search` exists but the agent must voluntarily call it. Under context pressure, complex tasks, or when skills/plugins inject competing instructions, the agent skips recall and hallucinates. External systems (OpenClaw GigaBrain) solve this with pre-prompt injection — zero agent decision required.

### WRITE failure: Agent must decide to save
`context_save` exists but the agent must voluntarily call it. Valuable insights, corrections, decisions, and user preferences from conversations are lost because the agent doesn't decide to persist them. u-os solves this with a Stop hook → `auto_capture.py` that extracts facts after every conversation.

### QUALITY failure: No gates on what gets saved
`MemoryManager.save()` writes anything that passes quota checks. No junk filter, no contradiction check, no dedup on write. Existing capabilities (LLMEntityExtractor 309 LOC, ContradictionDetector 109 LOC) are implemented but not wired into the save path.

### MAINTENANCE failure: No self-cleaning
EventStore grows unbounded. `RelevanceEngine.consolidate()` and `SemanticCompressor` exist but aren't orchestrated into a maintenance cycle.

**Evidence**:
- `MemoryManager.save()` (src/memory/MemoryManager.ts:388-639): No quality validation before EventStore write
- `LLMEntityExtractor` (src/graph/LLMEntityExtractor.ts): 309 lines, only called when `extractEntities=true`
- `ContradictionDetector` (src/graph/ContradictionDetector.ts): 109 lines, only used in graph entity updates
- 19 registered tools: none named `context_auto_recall`, `memory_maintain`, or `memory_conflicts`
- Memory type (src/types/index.ts:199-228): No `status` field, no supersession tracking
- `~/.claude/settings.json`: No `UserPromptSubmit` hook configured (READ gap)
- `~/.claude/hooks/memory-persist-stop.sh`: Only writes session-end markers, no fact extraction (WRITE gap)

## Why v1 Plan Failed (Instruction-Based Auto-Recall)

The v1 plan added a "NON-NEGOTIABLE" CLAUDE.md instruction telling the agent to call `context_auto_recall` before every response. This is fundamentally the same as hoping the agent calls `context_search` — it depends on voluntary compliance.

**Why instructions fail under load**:
1. Claude reads the instruction at session start
2. For the first few messages, it probably complies
3. As context fills with skills, plugins, task complexity — the instruction gets deprioritized
4. Under context compaction, the instruction may be summarized or lost
5. Result: inconsistent recall — exactly the current failure mode

**What v2 changes**: Claude Code supports `UserPromptSubmit` hooks that fire on EVERY user prompt, BEFORE Claude processes it, and inject `additionalContext` deterministically. No agent decision. No instruction to forget. This is the GigaBrain equivalent.

Source: https://code.claude.com/docs/en/hooks — UserPromptSubmit receives `{ prompt, session_id, cwd }` and returns `{ additionalContext }` or plain text stdout.

## Proposed Solution: Hook-Driven Bidirectional Memory

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    DETERMINISTIC READ PATH                       │
│                                                                  │
│  User types message                                              │
│       │                                                          │
│       ▼                                                          │
│  UserPromptSubmit hook fires (BEFORE Claude sees anything)       │
│       │                                                          │
│       ▼                                                          │
│  ~/.claude/hooks/ping-mem-auto-recall.sh                        │
│       │  1. Read user prompt from stdin (jq -r '.prompt')       │
│       │  2. Extract keywords (lightweight, no LLM)              │
│       │  3. curl ping-mem REST: GET /context/search?query=...   │
│       │  4. Format top-5 memories as additionalContext           │
│       │  5. Output JSON: { additionalContext: "..." }           │
│       │                                                          │
│       ▼                                                          │
│  Claude receives: user message + injected memory context        │
│  (deterministic — zero agent decision)                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    DETERMINISTIC WRITE PATH                      │
│                                                                  │
│  Claude finishes responding                                      │
│       │                                                          │
│       ▼                                                          │
│  Stop hook fires (AFTER every Claude response)                  │
│       │                                                          │
│       ▼                                                          │
│  ~/.claude/hooks/ping-mem-auto-capture.sh                       │
│       │  1. Read transcript from $TRANSCRIPT_PATH               │
│       │  2. Extract last exchange (user message + Claude reply)  │
│       │  3. POST to ping-mem REST: /api/v1/memory/extract       │
│       │     ping-mem uses LLM (Haiku) to extract:               │
│       │     - decisions, corrections, preferences, facts         │
│       │  4. Each extracted fact → context_save with metadata     │
│       │     → JunkFilter checks (Phase 2)                       │
│       │     → ContradictionDetector checks (Phase 2)            │
│       │     → LLMEntityExtractor async (Phase 2)                │
│       │                                                          │
│  Existing write hooks (already working):                        │
│  - PostToolUse[Bash] → memory-persist-pr-merge.sh (PR events)  │
│  - Stop → memory-persist-stop.sh (session markers)              │
│  - PostToolUse[Write/Edit] → memory-update-posttooluse.py       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    QUALITY GATES (on every write)                │
│                                                                  │
│  Any save (hook-triggered or agent-triggered)                   │
│       │                                                          │
│       ├─ JunkFilter.check(value) → reject garbage               │
│       ├─ ContradictionDetector.detect() → flag conflicts        │
│       ├─ Supersede semantics → mark old versions                │
│       └─ [async] LLMEntityExtractor → enrich knowledge graph    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    SELF-MAINTENANCE (cron/manual)                │
│                                                                  │
│  memory_maintain tool or cron                                    │
│       │                                                          │
│       ├─ Dedup (cosine > 0.95 → supersede)                     │
│       ├─ Consolidate (RelevanceEngine, existing)                │
│       ├─ Prune (low quality + low access + old → archive)       │
│       ├─ Vacuum (WAL checkpoint)                                │
│       └─ CcMemoryBridge export (high-relevance → topics/)      │
└─────────────────────────────────────────────────────────────────┘
```

### What Makes This Definitive (vs. Previous Rounds)

| Previous Approach | Why It Failed | This Plan |
|---|---|---|
| CLAUDE.md instruction: "call context_search" | Agent decides whether to comply | UserPromptSubmit hook: fires before agent sees prompt, no decision |
| Agent voluntarily calls context_save | Agent forgets to save | Stop hook: extracts facts from every exchange automatically |
| memory-persist-stop.sh writes session markers | Only records session-end events, no fact extraction | ping-mem-auto-capture.sh: LLM-powered fact extraction from transcript |
| Manual memory_maintain calls | Nobody remembers to run maintenance | Cron + MCP tool: scheduled self-cleaning |
| CLAUDE.md "NON-NEGOTIABLE" labels | Labels don't enforce behavior | Hooks are OS-level — they fire regardless of Claude's attention |

### Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Recall mechanism | `UserPromptSubmit` hook (not CLAUDE.md instruction) | Hooks fire deterministically; instructions are voluntarily followed. This is the #1 change from v1. |
| Write capture mechanism | `Stop` hook + REST endpoint | Stop fires after every response. REST endpoint does LLM extraction server-side (keeps hook fast). |
| Extraction model | Haiku 4.5 ($0.25/1M tokens) | Cheap enough for every-response extraction. ~$0.04/month at typical usage. |
| Recall search strategy | REST GET /context/search (semantic + keyword, skip graph) | Graph traversal adds latency. Semantic + keyword is fast enough for pre-prompt injection. |
| Junk filter | Heuristic first, no LLM on hot path | Fast string checks are O(1). LLM check adds latency to every save. |
| Contradiction detection | Wire existing ContradictionDetector | 109 LOC already implemented, just needs to be called from save path. |
| Maintenance | Single MCP tool + cron | Orchestrate existing subsystems (RelevanceEngine, SemanticCompressor), don't rebuild. |
| Supersede implementation | Metadata convention (not interface change) | `metadata.status` avoids breaking Memory interface. |

---

## Phase 1: Deterministic Bidirectional Hooks (Foundation)

**Quality Gate**: UserPromptSubmit hook injects memories on every prompt. Stop hook extracts facts from every exchange. `context_auto_recall` MCP tool works for non-hook consumers (understory). REST extraction endpoint responds. `bun test` passes.

### Task 1.1: Create `context_auto_recall` MCP Tool

**Repo**: ping-mem
**File**: `src/mcp/handlers/ContextToolModule.ts`
**Type**: Build + Wire + Test

The MCP tool exists for two reasons:
1. Non-hook consumers (understory, other agents) need programmatic auto-recall
2. The UserPromptSubmit hook calls the REST equivalent of this tool

**Function Signature**:
```typescript
{
  name: "context_auto_recall",
  description: "Fast pre-prompt recall — searches memory for context relevant to incoming message. Optimized for speed (<500ms). Returns top-K memories formatted for injection.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The user's incoming message text" },
      limit: { type: "number", description: "Max results (default 5)", default: 5 },
      maxTokens: { type: "number", description: "Max total tokens in response (default 1000)", default: 1000 }
    },
    required: ["message"]
  }
}
```

**Implementation** (add to ContextToolModule.handle()):
```typescript
case "context_auto_recall": {
  const message = args.message as string;
  const limit = (args.limit as number) ?? 5;
  const maxTokens = (args.maxTokens as number) ?? 1000;

  // 1. Get active memory manager (or search across sessions if none active)
  // 2. Run HybridSearchEngine.search() with semantic + keyword only (skip graph for speed)
  // 3. Truncate results to fit within maxTokens budget
  // 4. Format as compact injection-ready text
  // 5. Return { count, memories: [...], tokens_used }
}
```

**Test**: `src/mcp/__tests__/context-auto-recall.test.ts`

### Task 1.2: Create REST Extraction Endpoint

**Repo**: ping-mem
**File**: `src/http/rest-server.ts`
**Type**: Build + Wire + Test

The Stop hook calls this endpoint to extract facts from conversation exchanges.

**Endpoint**: `POST /api/v1/memory/extract`

```typescript
// Request body
{
  projectDir: string;          // Current project directory
  exchange: string;            // Last user message + Claude response
  sessionId?: string;          // Optional session ID
}

// Response
{
  extracted: Array<{
    key: string;               // Generated key (e.g., "decision:use-postgres")
    value: string;             // The extracted fact
    category: string;          // decision | correction | preference | fact | learning
    confidence: number;        // 0.0-1.0
  }>;
  saved: number;               // How many passed quality gates and were saved
  rejected: number;            // How many failed JunkFilter/dedup
}
```

**Implementation**:
1. Receive exchange text
2. Call Haiku 4.5 with extraction prompt (structured output: list of facts with category + confidence)
3. For each extracted fact with confidence >= 0.7:
   - Run through JunkFilter (Phase 2, or skip if not yet built)
   - Call MemoryManager.save() with appropriate metadata
4. Return summary

**Extraction prompt** (compact, structured):
```
Extract facts, decisions, corrections, and preferences from this conversation exchange.
Return JSON array: [{"key": "category:topic", "value": "the fact", "category": "decision|correction|preference|fact|learning", "confidence": 0.0-1.0}]
Rules:
- Only extract NON-OBVIOUS information (skip greetings, acknowledgments, routine actions)
- Corrections (user said "no, do X instead") are highest value — always extract
- Decisions ("let's use X", "we'll go with Y") are high value
- Skip anything that's just restating code or file contents
- confidence < 0.7 = don't bother
Exchange:
{exchange}
```

**Test**: `src/http/__tests__/memory-extract.test.ts`

### Task 1.3: Create UserPromptSubmit Hook (READ path)

**Repo**: claude-code (~/.claude/)
**File**: `~/.claude/hooks/ping-mem-auto-recall.sh` (NEW)
**Config**: `~/.claude/settings.json` (ADD UserPromptSubmit hook)
**Type**: Build + Wire

**Hook script**:
```bash
#!/bin/bash
# ping-mem-auto-recall.sh — Deterministic memory recall on every user prompt
# Fires via UserPromptSubmit hook BEFORE Claude processes the message.
# Searches ping-mem REST API and injects relevant memories as additionalContext.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

# Skip for trivial inputs (< 10 chars, slash commands, empty)
if [ -z "$PROMPT" ] || [ ${#PROMPT} -lt 10 ] || [[ "$PROMPT" == /* ]]; then
  exit 0
fi

# Check ping-mem REST availability (fast fail)
if ! curl -sf --max-time 1 http://localhost:3003/health > /dev/null 2>&1; then
  # ping-mem not running — silent skip, don't block user
  exit 0
fi

# URL-encode the query (basic encoding for common chars)
ENCODED_QUERY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PROMPT'[:200]))" 2>/dev/null || echo "")
if [ -z "$ENCODED_QUERY" ]; then
  exit 0
fi

# Search ping-mem for relevant memories (timeout 3s, limit 5)
RESULTS=$(curl -sf --max-time 3 \
  "http://localhost:3003/context/search?query=${ENCODED_QUERY}&limit=5" \
  2>/dev/null || echo "")

if [ -z "$RESULTS" ] || [ "$RESULTS" = "[]" ] || [ "$RESULTS" = "null" ]; then
  exit 0
fi

# Format memories for injection (compact, ~1000 token budget)
CONTEXT=$(echo "$RESULTS" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if not data or not isinstance(data, (list, dict)):
        sys.exit(0)
    # Handle both array and {results: [...]} formats
    items = data if isinstance(data, list) else data.get('results', data.get('memories', []))
    if not items:
        sys.exit(0)
    lines = ['[ping-mem recall]']
    token_budget = 1000
    chars_used = 0
    for item in items[:5]:
        mem = item if isinstance(item, dict) else {}
        key = mem.get('key', mem.get('id', '?'))
        value = mem.get('value', mem.get('content', str(mem)))
        score = mem.get('score', mem.get('relevance', 0))
        # Truncate individual values to ~200 chars
        if len(value) > 200:
            value = value[:197] + '...'
        line = f'- {key}: {value} (relevance: {score:.2f})'
        if chars_used + len(line) > 4000:  # ~1000 tokens
            break
        lines.append(line)
        chars_used += len(line)
    if len(lines) > 1:
        print('\n'.join(lines))
except Exception:
    sys.exit(0)
" 2>/dev/null || echo "")

if [ -z "$CONTEXT" ]; then
  exit 0
fi

# Return as additionalContext (Claude sees this before processing the prompt)
jq -n --arg ctx "$CONTEXT" '{
  additionalContext: $ctx
}'
```

**settings.json addition**:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/ping-mem-auto-recall.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Task 1.4: Create Stop Hook (WRITE path)

**Repo**: claude-code (~/.claude/)
**File**: `~/.claude/hooks/ping-mem-auto-capture.sh` (NEW)
**Config**: `~/.claude/settings.json` (ADD to existing Stop hooks)
**Type**: Build + Wire

**Hook script**:
```bash
#!/bin/bash
# ping-mem-auto-capture.sh — Automatic fact extraction on every session stop
# Fires via Stop hook AFTER Claude finishes responding.
# Reads last exchange from transcript, sends to ping-mem for LLM extraction.
# Async: does not block Claude from continuing.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# Check ping-mem REST availability
if ! curl -sf --max-time 1 http://localhost:3003/health > /dev/null 2>&1; then
  exit 0
fi

# Extract last exchange from transcript (last user + assistant messages)
EXCHANGE=$(python3 -c "
import json, sys

try:
    messages = []
    with open('$TRANSCRIPT_PATH', 'r') as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    msg = json.loads(line)
                    if msg.get('role') in ('user', 'assistant'):
                        messages.append(msg)
                except json.JSONDecodeError:
                    continue

    if len(messages) < 2:
        sys.exit(0)

    # Get last user + assistant pair
    last_msgs = messages[-2:]
    exchange_parts = []
    for msg in last_msgs:
        role = msg.get('role', '?')
        content = msg.get('content', '')
        if isinstance(content, list):
            # Handle structured content (text blocks)
            text_parts = [p.get('text', '') for p in content if isinstance(p, dict) and p.get('type') == 'text']
            content = ' '.join(text_parts)
        # Truncate to keep extraction prompt reasonable
        if len(content) > 2000:
            content = content[:1997] + '...'
        exchange_parts.append(f'{role}: {content}')

    print('\n'.join(exchange_parts))
except Exception:
    sys.exit(0)
" 2>/dev/null || echo "")

if [ -z "$EXCHANGE" ] || [ ${#EXCHANGE} -lt 50 ]; then
  exit 0
fi

# Send to ping-mem for extraction (async, fire-and-forget, 10s timeout)
curl -sf --max-time 10 -X POST "http://localhost:3003/api/v1/memory/extract" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg exchange "$EXCHANGE" --arg projectDir "$CWD" --arg sessionId "$SESSION_ID" '{
    exchange: $exchange,
    projectDir: $projectDir,
    sessionId: $sessionId
  }')" > /dev/null 2>&1 &

# Don't wait for extraction to complete — fire and forget
exit 0
```

**settings.json addition** (add to existing Stop hooks array):
```json
{
  "type": "command",
  "command": "bash ~/.claude/hooks/ping-mem-auto-capture.sh",
  "timeout": 10
}
```

### Task 1.5: Keep CLAUDE.md Recall Protocol (Belt + Suspenders)

**Repo**: claude-code (~/.claude/)
**File**: `~/.claude/CLAUDE.md`
**Type**: Keep existing

The Memory Recall Protocol in CLAUDE.md stays as a fallback instruction. It's not the primary recall mechanism (the hook is), but it provides defense-in-depth:
- Hook handles 95% of cases (fires on every prompt)
- CLAUDE.md instruction catches edge cases where the hook fails (ping-mem down, timeout, etc.)
- Agent can still manually call `context_auto_recall` when it needs targeted recall

**No change needed** — CLAUDE.md v5.1 already has this section.

---

## Phase 2: Quality Gates on Write

**Quality Gate**: Junk filter rejects known-bad inputs, contradictions detected, LLM extraction fires async, supersede events emitted. `bun test` passes, `bun run typecheck` clean.

**Depends on**: Phase 1 (auto-recall enables testing of full save→recall cycle)

### Task 2.1: Create JunkFilter

**Repo**: ping-mem
**File**: `src/memory/JunkFilter.ts` (NEW)
**Type**: Build

```typescript
export interface JunkFilterResult {
  pass: boolean;
  reason?: string;
}

export class JunkFilter {
  /**
   * Fast heuristic check — no LLM, no network. O(1).
   * Rejects: too short, too vague, exact duplicates, gibberish.
   */
  check(value: string, existingKeys?: Set<string>): JunkFilterResult;
}
```

**Heuristic checks**:
1. Length < 10 chars → reject ("too short")
2. Vagueness patterns: `/^(stuff|things|the thing|it|this|that|something|idk|todo)$/i` → reject ("too vague")
3. Exact match in existingKeys → reject ("exact duplicate")
4. Entropy check: if character diversity < 3 unique chars → reject ("gibberish")
5. All checks pass → `{ pass: true }`

**Test**: `src/memory/__tests__/JunkFilter.test.ts`

### Task 2.2: Wire JunkFilter into MemoryManager.save()

**Repo**: ping-mem
**File**: `src/memory/MemoryManager.ts`
**Type**: Wire

**Integration Point**: Line 388 (save method), insert BEFORE quota check at line 402:

```typescript
if (this.junkFilter) {
  const filterResult = this.junkFilter.check(value, new Set(this.memories.keys()));
  if (!filterResult.pass) {
    throw new MemoryQualityError(`Memory rejected: ${filterResult.reason}`);
  }
}
```

**Constructor change**: Accept optional `junkFilter: JunkFilter` in config, default to `new JunkFilter()`.

**New error type**: Add `MemoryQualityError` to `src/types/agent-errors.ts` (where QuotaExhaustedError lives)

### Task 2.3: Wire ContradictionDetector into save() path

**Repo**: ping-mem
**File**: `src/mcp/handlers/ContextToolModule.ts`
**Type**: Wire existing

**Current state**: ContradictionDetector at `src/graph/ContradictionDetector.ts` (109 lines) — only called from graph entity updates.

**Integration Point**: `ContextToolModule.ts` handleSave(), after evidence gate check, before calling memoryManager.save():

```typescript
if (state.vectorIndex && state.llmEntityExtractor) {
  const similar = await memoryManager.recall({
    semanticQuery: value,
    limit: 3,
    minSimilarity: 0.8
  });

  if (similar.length > 0) {
    const detector = new ContradictionDetector(/* openai config */);
    const result = await detector.detect(value, similar[0].memory.value);

    if (result.isContradiction && result.confidence >= 0.7) {
      options.metadata = {
        ...options.metadata,
        contradicts: similar[0].memory.id,
        contradictionConfidence: result.confidence,
        contradictionDescription: result.conflict
      };
    }
    if (similar[0].score > 0.95 && !result.isContradiction) {
      if (state.relevanceEngine) {
        await state.relevanceEngine.trackAccess(similar[0].memory.id);
      }
      return { success: true, deduplicated: true, existingMemoryId: similar[0].memory.id };
    }
  }
}
```

**Test**: `src/mcp/__tests__/context-save-contradiction.test.ts`

### Task 2.4: Wire LLMEntityExtractor as default async post-save

**Repo**: ping-mem
**File**: `src/mcp/handlers/ContextToolModule.ts`
**Type**: Wire existing

**Change**: In handleSave(), change extraction default from opt-in to opt-out:

```typescript
// Current: if (args.extractEntities) { ... }
// Changed: Always extract if LLM extractor available, unless explicitly skipped
const shouldExtract = args.extractEntities !== false; // default: true (was: false)
if (shouldExtract && state.llmEntityExtractor) {
  state.llmEntityExtractor.extract(value).then(entities => {
    // ... existing entity storage logic
  }).catch(err => {
    console.warn("Async entity extraction failed:", err.message);
  });
}
```

**Test**: `src/mcp/__tests__/context-save-entity-extraction.test.ts`

### Task 2.5: Add Supersede Semantics

**Repo**: ping-mem
**Type**: Build + Wire

**2.5a**: Add `"MEMORY_SUPERSEDED"` to EventType union in `src/types/index.ts`

**2.5b**: Metadata convention (no interface change):
```typescript
// Convention: memory.metadata.status = "active" | "superseded"
// Convention: memory.metadata.supersededBy = MemoryId
// Convention: memory.metadata.supersedes = MemoryId
```

**2.5c**: Wire into MemoryManager.update() — emit MEMORY_SUPERSEDED, set metadata chain

**2.5d**: Filter superseded from recall() — default exclude, `includeSuperseded: boolean` option

**Test**: `src/memory/__tests__/MemoryManager-supersede.test.ts`

---

## Phase 3: Self-Maintenance

**Quality Gate**: `memory_maintain` tool runs successfully, dedup/prune/vacuum work, `memory_conflicts` lists flagged contradictions. `bun test` passes.

**Depends on**: Phase 2 (contradiction metadata must exist for memory_conflicts to query)

### Task 3.1: Create MaintenanceRunner

**Repo**: ping-mem
**File**: `src/maintenance/MaintenanceRunner.ts` (NEW)
**Type**: Build

```typescript
export interface MaintenanceConfig {
  relevanceEngine: RelevanceEngine;
  eventStore: EventStore;
  memoryManagers: Map<SessionId, MemoryManager>;
  vectorIndex: VectorIndex | null;
  maxStaleAge?: number;       // days, default 30
  dedupThreshold?: number;    // cosine similarity, default 0.95
  qualityMinScore?: number;   // minimum quality to keep, default 0.2
  vacuumThreshold?: number;   // WAL size in bytes to trigger VACUUM, default 50MB
}

export interface MaintenanceResult {
  deduplicated: number;
  consolidated: number;
  pruned: number;
  vacuumed: boolean;
  walSizeBefore: number;
  walSizeAfter: number;
  duration: number;
}

export class MaintenanceRunner {
  constructor(config: MaintenanceConfig);
  async run(): Promise<MaintenanceResult>;
  async dedup(): Promise<number>;
  async consolidate(): Promise<number>;
  async prune(): Promise<number>;
  async vacuum(): Promise<boolean>;
}
```

**Implementation**:
1. `dedup()`: Query vector index for pairs with similarity > 0.95. Keep higher relevance, supersede other.
2. `consolidate()`: Call `RelevanceEngine.consolidate()` (existing).
3. `prune()`: Find memories with `relevanceScore < qualityMinScore` AND `access_count = 0` AND `age > maxStaleAge`. Archive to `archived_memories` table.
4. `vacuum()`: Check `EventStore.getWalSizeBytes()`. If > threshold, run `walCheckpoint("TRUNCATE")`.

**Test**: `src/maintenance/__tests__/MaintenanceRunner.test.ts`

### Task 3.2: Create `memory_maintain` MCP Tool

**Repo**: ping-mem
**File**: `src/mcp/handlers/MemoryToolModule.ts`
**Type**: Build + Wire

```typescript
{
  name: "memory_maintain",
  description: "Run maintenance cycle: dedup, consolidate stale memories, prune low-quality, vacuum database. Safe to run anytime.",
  inputSchema: {
    type: "object",
    properties: {
      dryRun: { type: "boolean", description: "Preview what would be changed without modifying", default: false }
    }
  }
}
```

### Task 3.3: Create `memory_conflicts` MCP Tool

**Repo**: ping-mem
**File**: `src/mcp/handlers/MemoryToolModule.ts`
**Type**: Build + Wire

```typescript
{
  name: "memory_conflicts",
  description: "List unresolved contradictions in memory. Returns memories flagged with contradiction metadata.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 20 },
      resolve: { type: "string", description: "Memory ID to mark as resolved" }
    }
  }
}
```

---

## Phase 4: Cross-System Integration

**Quality Gate**: Understory `autoRecall()` method works, CcMemoryBridge exports to ~/.claude/memory/topics/, hooks installed and tested end-to-end. All tests pass across repos.

**Depends on**: Phase 1 (context_auto_recall tool must exist for understory to call it)

### Task 4.1: Add autoRecall to Understory PingMemClient

**Repo**: understory
**File**: `src/memory/ping-mem-client.ts`
**Type**: Build + Wire

```typescript
autoRecall(message: string, limit?: number): Promise<PingMemSearchResult[]>;
```

Wire in forge-init.ts as step 0 in `loadContext()`.

### Task 4.2: Enhance CcMemoryBridge Export

**Repo**: ping-mem
**File**: `src/integration/CcMemoryBridge.ts`
**Type**: Enhance existing

```typescript
async exportToNativeMemory(
  topicsDir: string,  // e.g., ~/.claude/memory/topics/
  minRelevance: number = 0.7
): Promise<{ exported: number; file: string }>;
```

Wire: MaintenanceRunner calls this at end of maintenance cycle.

### Task 4.3: Install and Test Hooks End-to-End

**Repo**: claude-code (~/.claude/)
**Type**: Wire + Verify

**Steps**:
1. Install `ping-mem-auto-recall.sh` to `~/.claude/hooks/`
2. Install `ping-mem-auto-capture.sh` to `~/.claude/hooks/`
3. Add UserPromptSubmit hook to `~/.claude/settings.json`
4. Add Stop hook entry to existing Stop array in `~/.claude/settings.json`
5. End-to-end test: start session → type message → verify recall injection → verify fact extraction

---

## Wiring Matrix

| # | Capability | Trigger | Call Path | Deterministic? |
|---|-----------|---------|-----------|----------------|
| 1 | **Auto-recall** | Every user prompt | UserPromptSubmit hook → curl REST /context/search → additionalContext injection | **YES (hook)** |
| 2 | **Auto-capture** | Every Claude response | Stop hook → curl REST /api/v1/memory/extract → Haiku extraction → save() | **YES (hook)** |
| 3 | **Junk filter** | Every save (hook or agent) | MemoryManager.save() → JunkFilter.check() → reject or pass | **YES (code path)** |
| 4 | **Contradiction detection** | Every save with similar existing | handleSave() → recall similar → ContradictionDetector → flag metadata | **YES (code path)** |
| 5 | **Auto entity extraction** | Every save (default-on) | handleSave() → async LLMEntityExtractor.extract() → GraphManager | **YES (default-on)** |
| 6 | **Supersede tracking** | Every update | MemoryManager.update() → emit MEMORY_SUPERSEDED → metadata chain | **YES (code path)** |
| 7 | **Self-maintenance** | Cron or manual | memory_maintain → MaintenanceRunner → dedup/prune/vacuum | **YES (cron)** |
| 8 | **Conflict surfacing** | Agent calls memory_conflicts | MemoryToolModule → query contradiction metadata | Manual (acceptable — surfacing is a human-review action) |
| 9 | **Understory recall** | Forge init on new issue | forge-init → PingMemClient.autoRecall() → context_auto_recall MCP tool | **YES (wired into forge)** |
| 10 | **CC bridge export** | Maintenance cycle | MaintenanceRunner → CcMemoryBridge.exportToNativeMemory() → topics/ | **YES (maintenance step)** |

**Deterministic count**: 9/10 capabilities are deterministic (hook-driven, code-path, or cron). Only conflict resolution requires manual agent decision (appropriate — humans should resolve contradictions).

---

## Comparison: u-os/Paro vs. This Plan

| Aspect | u-os/Paro | This Plan | Advantage |
|--------|-----------|-----------|-----------|
| **Write capture** | Stop hook → auto_capture.py → mem0/Pinecone | Stop hook → ping-mem-auto-capture.sh → ping-mem REST → Haiku extraction | Equivalent mechanism, but ping-mem has quality gates (junk filter, contradiction detection) |
| **Read recall** | MEMORY.md loaded at session start (manual, static) | UserPromptSubmit hook → dynamic search on every prompt | **This plan wins** — dynamic per-prompt vs. static per-session |
| **Quality gates** | mem0 dedup (ADD/UPDATE/DELETE/NOOP) | JunkFilter + ContradictionDetector + supersede semantics | **This plan wins** — more granular with existing infrastructure |
| **Maintenance** | Manual (mem0_sync_md.py) | MaintenanceRunner (dedup/prune/vacuum) + cron | **This plan wins** — automated |
| **Entity extraction** | mem0 LLM extraction (auto) | LLMEntityExtractor (existing, now default-on) + Neo4j graph | Equivalent, different backends |
| **Storage** | mem0 + Pinecone (cloud vectors) | SQLite + Neo4j + Qdrant (all local) | Trade-off — local is faster but no free cloud tier |
| **Proactive** | Heartbeat every 30min + proactive_scheduler rules | Not in scope (separate concern) | u-os wins here — but that's Paro's job, not ping-mem's |

---

## Implementation Phases — Execution Sequence

### Phase 1: Bidirectional Hooks (Tasks 1.1-1.5)

| Task | Repo | Sequential/Parallel | Depends On | Files |
|------|------|---------------------|------------|-------|
| 1.1 context_auto_recall tool | ping-mem | **Parallel** | — | ContextToolModule.ts, test |
| 1.2 REST extraction endpoint | ping-mem | **Parallel with 1.1** | — | rest-server.ts, test |
| 1.3 UserPromptSubmit hook | claude-code | **Sequential after 1.1** | 1.1 (REST search must work) | hooks/ping-mem-auto-recall.sh, settings.json |
| 1.4 Stop auto-capture hook | claude-code | **Sequential after 1.2** | 1.2 (REST extraction must work) | hooks/ping-mem-auto-capture.sh, settings.json |
| 1.5 CLAUDE.md (no change) | claude-code | — | — | Already done in v5.1 |

### Phase 2: Quality Gates (Tasks 2.1-2.5)

| Task | Repo | Sequential/Parallel | Depends On | Files |
|------|------|---------------------|------------|-------|
| 2.1 JunkFilter class | ping-mem | **Parallel** | — | JunkFilter.ts, test |
| 2.2 Wire JunkFilter into save() | ping-mem | **Sequential after 2.1** | 2.1 | MemoryManager.ts, errors.ts |
| 2.3 Wire ContradictionDetector | ping-mem | **Parallel with 2.1** | — | ContextToolModule.ts, test |
| 2.4 Wire LLMEntityExtractor | ping-mem | **Parallel with 2.1** | — | ContextToolModule.ts, test |
| 2.5 Supersede semantics | ping-mem | **Parallel with 2.1** | — | types/index.ts, MemoryManager.ts, test |

### Phase 3: Self-Maintenance (Tasks 3.1-3.3)

| Task | Repo | Sequential/Parallel | Depends On | Files |
|------|------|---------------------|------------|-------|
| 3.1 MaintenanceRunner | ping-mem | **Parallel** | Phase 2 | maintenance/MaintenanceRunner.ts, test |
| 3.2 memory_maintain tool | ping-mem | **Sequential after 3.1** | 3.1 | MemoryToolModule.ts |
| 3.3 memory_conflicts tool | ping-mem | **Parallel with 3.1** | Phase 2 (contradiction metadata) | MemoryToolModule.ts, test |

### Phase 4: Cross-System Integration (Tasks 4.1-4.3)

| Task | Repo | Sequential/Parallel | Depends On | Files |
|------|------|---------------------|------------|-------|
| 4.1 Understory autoRecall | understory | **Parallel** | Phase 1 (tool exists) | ping-mem-client.ts, forge-init.ts, test |
| 4.2 CcMemoryBridge export | ping-mem | **Parallel with 4.1** | Phase 3 | CcMemoryBridge.ts, test |
| 4.3 Install + test hooks E2E | claude-code | **Sequential after 1.3, 1.4** | All Phase 1 | E2E verification |

---

## Dependency Graph (Critical Path)

```
Phase 1: [1.1 auto_recall tool] ──┐
         [1.2 REST extract]    ──┤
                                  ├──→ [1.3 UserPromptSubmit hook]
                                  └──→ [1.4 Stop capture hook]

Phase 2: [2.1 JunkFilter] → [2.2 Wire into save()]
         [2.3 ContradictionDetector] ──parallel──
         [2.4 LLMEntityExtractor]   ──parallel──
         [2.5 Supersede]            ──parallel──

Phase 3: [3.1 MaintenanceRunner] → [3.2 memory_maintain]
         [3.3 memory_conflicts] ──parallel with 3.1──

Phase 4: [4.1 Understory] ──parallel── [4.2 CcMemoryBridge] ──parallel── [4.3 E2E test]
```

**Critical path**: 1.1 → 1.3 → 4.3 (hook install → E2E verification)

---

## GitHub Issues — Updated Mapping

### ping-mem Issues

| Issue | Title | Phase | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| #51 | `feat: context_auto_recall MCP tool + REST extraction endpoint` | 1 | 1.1, 1.2 | — |
| #52 | `feat: JunkFilter quality gate on memory save` | 2 | 2.1, 2.2 | — |
| #53 | `feat: Wire ContradictionDetector into context_save path` | 2 | 2.3 | — |
| #54 | `feat: Default-on LLM entity extraction for context_save` | 2 | 2.4 | — |
| #55 | `feat: Supersede-never-delete semantics for memory updates` | 2 | 2.5 | — |
| #56 | `feat: MaintenanceRunner + memory_maintain tool` | 3 | 3.1, 3.2 | #52, #55 |
| #57 | `feat: memory_conflicts tool for contradiction management` | 3 | 3.3 | #53 |
| #58 | `feat: CcMemoryBridge exportToNativeMemory` | 4 | 4.2 | #56 |

**Issue #51 scope expanded**: Now includes REST extraction endpoint (Task 1.2) in addition to MCP tool (Task 1.1). The hooks themselves (Tasks 1.3, 1.4) are claude-code config — installed after #51 ships.

### understory Issues

| Issue | Title | Phase | Depends On |
|-------|-------|-------|------------|
| #21 | `feat: autoRecall method + forge-init integration` | 4 | ping-mem #51 |

### claude-code (manual, post-forge)

| Task | What | When |
|------|------|------|
| Install hooks | Copy hook scripts, update settings.json | After ping-mem #51 merged and REST server updated |
| E2E test | Verify recall injection + fact extraction | After hooks installed |

---

## Verification Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | context_auto_recall tool registered | `grep -r "context_auto_recall" src/mcp/` | Match in ContextToolModule.ts |
| 2 | REST extraction endpoint exists | `grep -r "memory/extract" src/http/` | Match in rest-server.ts |
| 3 | JunkFilter class exists | `ls src/memory/JunkFilter.ts` | File exists |
| 4 | JunkFilter wired in save() | `grep "junkFilter" src/memory/MemoryManager.ts` | Match |
| 5 | MEMORY_SUPERSEDED event type | `grep "MEMORY_SUPERSEDED" src/types/index.ts` | Match |
| 6 | ContradictionDetector in ContextToolModule | `grep "ContradictionDetector" src/mcp/handlers/ContextToolModule.ts` | Match |
| 7 | LLM extraction default changed | `grep "extractEntities !== false" src/mcp/handlers/ContextToolModule.ts` | Match |
| 8 | MaintenanceRunner exists | `ls src/maintenance/MaintenanceRunner.ts` | File exists |
| 9 | memory_maintain registered | `grep "memory_maintain" src/mcp/handlers/MemoryToolModule.ts` | Match |
| 10 | memory_conflicts registered | `grep "memory_conflicts" src/mcp/handlers/MemoryToolModule.ts` | Match |
| 11 | UserPromptSubmit hook script exists | `ls ~/.claude/hooks/ping-mem-auto-recall.sh` | File exists |
| 12 | Stop capture hook script exists | `ls ~/.claude/hooks/ping-mem-auto-capture.sh` | File exists |
| 13 | UserPromptSubmit in settings.json | `grep "UserPromptSubmit" ~/.claude/settings.json` | Match |
| 14 | All tests pass | `bun test` | Exit 0 |
| 15 | Typecheck clean | `bun run typecheck` | Exit 0 |

## Acceptance Criteria

### Functional
- [ ] UserPromptSubmit hook injects relevant memories on every prompt (E2E test)
- [ ] Stop hook extracts facts from conversation and saves to ping-mem (E2E test)
- [ ] `context_auto_recall` returns relevant memories given a query (unit test)
- [ ] REST `/api/v1/memory/extract` extracts facts from conversation text (unit test)
- [ ] Junk values rejected on save with clear error (unit test)
- [ ] Contradicting memories flagged with metadata (unit test)
- [ ] Entity extraction runs by default on context_save (unit test)
- [ ] Memory updates emit MEMORY_SUPERSEDED (unit test)
- [ ] `memory_maintain` runs full cycle without error (unit test)
- [ ] `memory_conflicts` returns unresolved contradictions (unit test)
- [ ] Understory autoRecall calls context_auto_recall successfully (unit test)

### Non-Functional
- [ ] UserPromptSubmit hook completes in < 5s (timeout setting)
- [ ] `context_auto_recall` responds in < 500ms
- [ ] Junk filter adds < 1ms to save() hot path
- [ ] Entity extraction is async — does not block save() response
- [ ] Stop hook is fire-and-forget — does not block Claude
- [ ] All existing 111+ tests continue to pass
- [ ] Zero new `any` types
- [ ] `bun run typecheck` reports 0 errors

---

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| UserPromptSubmit hook adds latency to every prompt | HIGH | MEDIUM | 5s timeout, fast-fail health check (1s), skip for short prompts |
| Stop hook extraction produces garbage facts | MEDIUM | MEDIUM | JunkFilter on save path, confidence threshold (0.7), Haiku structured output |
| ping-mem REST not running → hooks silently fail | HIGH | LOW | Hooks check health first, silent skip, CLAUDE.md instruction as fallback |
| JunkFilter too aggressive | HIGH | MEDIUM | Conservative patterns, unit tests, `skipQualityCheck` override |
| Haiku extraction costs add up | LOW | LOW | ~$0.04/month at typical usage (20 exchanges/day × 500 tokens × $0.25/1M) |
| Transcript format changes break capture hook | MEDIUM | LOW | Python parser handles both string and structured content |

## Success Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Recall on every prompt | 0% (voluntary) | 100% (hook-driven) | UserPromptSubmit fires → additionalContext injected |
| Fact capture on every response | 0% (voluntary) | 100% (hook-driven) | Stop fires → extraction endpoint called |
| Junk memories saved | Unknown | < 5% | JunkFilter rejection rate |
| Contradictions detected | 0% | 100% of conflicting saves | Test coverage |
| Memory maintenance | Manual | Automated (cron + tool) | MaintenanceRunner runs scheduled |
| Test count | 111 files | 118+ | `find src -name "*.test.ts" | wc -l` |
