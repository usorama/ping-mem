---
title: "feat: Conversation Mining Pipeline + Dreaming Engine"
type: feat
date: 2026-03-22
status: ready
github_issues: []
github_pr: null
research: docs/dreaming-research/ (4 documents)
synthesis: docs/dreaming-research/04-synthesis.md
eval_iteration: 0
review_iteration: 1
review_method: multi-llm (Opus 4.6 + Gemini 2.5 Pro + GPT-4o + GPT-4o-mini)
review_report: docs/plans/2026-03-22-feat-conversation-mining-dreaming-engine-plan-review.md
amendments_applied: 16
verification_iteration: 0
verification_method: null
scope: Phases 1+2+3 (all phases, no deferrals)
---

# Conversation Mining Pipeline + Dreaming Engine

## Problem Statement

ping-mem stores memories explicitly saved via `context_save` and auto-captured observations (PR #65). But it has no way to:

1. **Mine historical conversations** — 251 main Claude Code sessions (3.4GB) contain months of user corrections, preferences, workflow patterns, and project decisions that are trapped in `.jsonl` files
2. **Reason about existing memories** — ping-mem stores but doesn't think. It can't derive new facts from existing ones ("user stopped mentioning project X → project X is done") or generalize patterns ("user always corrects about testing → prefers TDD")
3. **Build a user persona automatically** — UserProfile exists but is manually populated. No automatic trait extraction from conversation history

**Evidence**: Honcho (https://github.com/plastic-labs/honcho) demonstrates that "dreaming" — periodic LLM reasoning over stored facts — is the key differentiator for memory systems. ping-mem has 6/8 Honcho capabilities but lacks dreaming and historical mining.

## Proposed Solution

Two new services + UI updates, built on existing infrastructure:

```
┌─────────────────────────────────────────────────┐
│                 Phase 1: Mining                  │
│  TranscriptMiner → Claude CLI → MemoryManager    │
│  (~/.claude/projects/*.jsonl → extracted facts)  │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Phase 2: Dreaming                   │
│  DreamingEngine (in MaintenanceRunner)           │
│  Deduction → Generalization → Profile Update     │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Phase 3: UI                         │
│  /ui/insights + /ui/mining + /ui/profile         │
└─────────────────────────────────────────────────┘
```

### Components

| Component | Type | Purpose |
|-----------|------|---------|
| `TranscriptMiner` | New service | Scan .jsonl files, extract user messages via Claude CLI, save as memories |
| `DreamingEngine` | New service | LLM reasoning over memory clusters for deduction + generalization |
| `MiningProgressStore` | New SQLite table | Track which sessions have been mined |
| REST endpoints | New routes | `POST /api/v1/mining/start`, `GET /api/v1/mining/status`, `GET /api/v1/insights` (all behind existing API key auth middleware) |
| MCP tools | New tools | `transcript_mine`, `dreaming_run`, `insights_list` |
| UI pages | New routes | `/ui/insights`, `/ui/mining`, `/ui/profile` |

## Critical Questions — Answers

| Question | Decision | Source |
|----------|----------|--------|
| LLM cost strategy | Full LLM extraction via Claude Max OAuth ($0 incremental). Primary: Haiku 4.5 (mining), Sonnet 4.6 (dreaming). Fallback 1: Gemini 3.1 Pro API. Fallback 2: GPT-4o API. | User-selected |
| Dreaming trigger | During maintenance only (MaintenanceRunner step) | User-selected |
| Insight storage model | Regular memories with category='derived_insight' | User-selected |
| Auto-update UserProfile | Yes, mining + dreaming auto-update profile fields | User-selected |
| LLM model hierarchy | 1) Claude Haiku 4.5 via CLI/OAuth (mining), 2) Claude Sonnet 4.6 via CLI/OAuth (dreaming), 3) Gemini 3.1 Pro API (fallback 1), 4) GPT-4o API (fallback 2) | User-selected |

## Gap Coverage Matrix

| Gap | Resolution | Phase |
|-----|-----------|-------|
| No transcript ingestion | TranscriptMiner service | Phase 1 |
| No fact derivation | DreamingEngine.deduce() | Phase 2 |
| No pattern generalization | DreamingEngine.generalize() | Phase 2 |
| No stale fact detection | DreamingEngine uses ContradictionDetector | Phase 2 |
| No mining progress tracking | MiningProgressStore table | Phase 1 |
| UserProfile not auto-updated | Mining + Dreaming update profile | Phase 1+2 |
| No UI for insights | /ui/insights, /ui/mining, /ui/profile | Phase 3 |

## Implementation Phases

### Phase 1: Conversation Mining Pipeline

**Scope**: TranscriptMiner service, REST endpoint, MCP tool, mining progress tracking, UserProfile auto-update

**Tasks**:
1. **Build** `TranscriptMiner` service (`src/mining/TranscriptMiner.ts`)
2. **Build** mining progress SQLite table (in EventStore or standalone)
3. **Wire** REST endpoint `POST /api/v1/mining/start` + `GET /api/v1/mining/status`
4. **Wire** MCP tool `transcript_mine`
5. **Wire** UserProfile auto-update from extracted facts
6. **Test** End-to-end: mine a session → facts stored → profile updated

**Quality gate**: `bun test` passes, mining 1 session produces ≥3 facts, profile updated

### Phase 2: Dreaming Engine

**Scope**: DreamingEngine service, integration into MaintenanceRunner, deduction + generalization

**Tasks**:
1. **Build** `DreamingEngine` service (`src/dreaming/DreamingEngine.ts`)
2. **Wire** into MaintenanceRunner between consolidate and prune
3. **Build** deduction phase (compare memory clusters, derive implicit facts)
4. **Build** generalization phase (find patterns, form personality traits)
5. **Wire** ContradictionDetector for stale insight detection
6. **Test** End-to-end: maintenance run → dreams generated → stale insights caught

**Quality gate**: Maintenance produces ≥1 derived insight, stale detection works

### Phase 3: UI Updates

**Scope**: New web UI pages for insights, mining status, user profile

**Tasks**:
1. **Build** `/ui/insights` page — browse derived insights with source links
2. **Build** `/ui/mining` page — mining status, sessions processed, facts extracted
3. **Build** `/ui/profile` page — auto-populated user persona (peer card)
4. **Test** Pages render, data loads correctly

**Quality gate**: All 3 pages render with real data

## Database Schema Definitions

```sql
-- Mining progress tracking (in EventStore's ~/.ping-mem/events.db — Amendment #13)
CREATE TABLE IF NOT EXISTS mining_progress (
  session_file TEXT PRIMARY KEY,           -- .jsonl file path
  session_id TEXT,                         -- Claude Code session UUID
  project TEXT,                            -- project name extracted from path
  status TEXT CHECK(status IS NULL OR status IN ('pending', 'processing', 'completed', 'failed')) DEFAULT 'pending',
  user_messages_count INTEGER DEFAULT 0,
  facts_extracted INTEGER DEFAULT 0,
  started_at TEXT,                         -- ISO 8601
  completed_at TEXT,                       -- ISO 8601
  error TEXT,                              -- failure reason if status='failed'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mining_status ON mining_progress(status);
CREATE INDEX IF NOT EXISTS idx_mining_project ON mining_progress(project);
```

No new tables for insights — stored as regular memories with `category = 'derived_insight'` per user decision.

## Function Signatures

### TranscriptMiner (`src/mining/TranscriptMiner.ts`)

```typescript
export interface MiningConfig {
  transcriptDir: string;          // default: ~/.claude/projects/
  batchSize: number;              // sessions per batch, default: 10
  skipSubagents: boolean;         // default: true
  maxSessionAge?: number;         // days, default: undefined (all)
}

export interface MiningResult {
  sessionsScanned: number;
  sessionsProcessed: number;
  factsExtracted: number;
  profileUpdates: number;
  errors: string[];
  durationMs: number;
  costEstimate?: { inputTokens: number; outputTokens: number };
}

export class TranscriptMiner {
  private miningLock = false;  // Amendment #8: singleton mining lock

  constructor(
    private readonly db: Database,
    private readonly memoryManager: MemoryManager,
    private readonly userProfile: UserProfileStore,
    private readonly config: MiningConfig
  ) {}
  // NOTE: SemanticCompressor removed (Amendment #2) — uses Claude CLI directly for fact extraction.
  // Claude CLI called via async Bun.spawn (Amendment #4), not Bun.spawnSync.

  /** Scan transcript dir, find unmined sessions, process them. Serialized via miningLock. */
  async mine(options?: { limit?: number; project?: string }): Promise<MiningResult> {}

  /** Extract user messages from a single .jsonl file (streamed line-by-line, Amendment #9) */
  async extractUserMessages(filePath: string): Promise<string[]> {}

  /** Extract facts from messages via Claude CLI and store as memories */
  async processMessages(messages: string[], sessionFile: string): Promise<number> {}

  /** Call Claude CLI asynchronously with timeout (Amendment #4) */
  private async callClaude(prompt: string, model: string, system?: string): Promise<string> {}

  /** Reset stale 'processing' entries on startup (Amendment #10) */
  async recoverStaleEntries(): Promise<number> {}
}
```

### DreamingEngine (`src/dreaming/DreamingEngine.ts`)

```typescript
export interface DreamConfig {
  maxMemoriesPerCycle: number;    // default: 200
  minMemoriesForDreaming: number; // default: 20
  deductionEnabled: boolean;      // default: true
  generalizationEnabled: boolean; // default: true
}

export interface DreamResult {
  deductions: number;             // new facts derived
  generalizations: number;        // personality traits formed
  contradictions: number;         // stale insights invalidated
  profileUpdates: number;         // UserProfile fields updated
  durationMs: number;
  costEstimate?: { inputTokens: number; outputTokens: number };
}

export class DreamingEngine {
  constructor(
    private readonly memoryManager: MemoryManager,
    private readonly contradictionDetector: ContradictionDetector | null, // nullable — requires OPENAI_API_KEY (Amendment #3)
    private readonly userProfile: UserProfileStore,
    private readonly eventStore: EventStore,
    private readonly config: DreamConfig
  ) {}
  // NOTE: SemanticCompressor removed (Amendment #2) — uses Claude CLI directly.
  // ContradictionDetector is nullable — requires OPENAI_API_KEY, not Claude CLI (Amendment #3).
  // Input memories EXCLUDE category='derived_insight' to prevent circular reasoning (Amendment #12).

  /** Run full dreaming cycle: deduce → generalize → clean → profile update */
  async dream(sessionId: SessionId): Promise<DreamResult> {}

  /** Phase 1: Compare memory clusters to derive implicit facts (excludes derived_insight) */
  async deduce(memories: Memory[]): Promise<string[]> {}

  /** Phase 2: Find patterns across memories to form personality traits + update UserProfile */
  async generalize(memories: Memory[]): Promise<string[]> {}

  /** Check existing derived insights for staleness via ContradictionDetector (skipped if no OPENAI_API_KEY) */
  async cleanStaleInsights(insights: Memory[]): Promise<number> {}

  /** Call Claude CLI asynchronously with timeout (Amendment #4) */
  private async callClaude(prompt: string, model: string, system?: string): Promise<string> {}
}
```

## Integration Points

### Phase 1 Integration

| File | Line | Change |
|------|------|--------|
| `src/types/index.ts` | ~298 (EventType union) | Add `\| "TRANSCRIPT_MINED" \| "INSIGHT_DERIVED" \| "INSIGHT_INVALIDATED"` |
| `src/http/rest-server.ts` | ~2580 (after observation routes) | Add `POST /api/v1/mining/start` and `GET /api/v1/mining/status` |
| `src/mcp/handlers/MiningToolModule.ts` | NEW file | New `MiningToolModule` with `MINING_TOOLS` array for `transcript_mine` tool (Amendment #6) |
| `src/mcp/PingMemServer.ts` | TOOLS array + constructor | Spread `MINING_TOOLS` into TOOLS aggregate, instantiate MiningToolModule |
| `src/http/rest-server.ts` | constructor | Instantiate TranscriptMiner with deps |

### Phase 2 Integration

| File | Line | Change |
|------|------|--------|
| `src/maintenance/MaintenanceRunner.ts` | constructor options (line ~60) | Add `dreamingEngine?: DreamingEngine \| null` to inline constructor options type (Amendment #7) |
| `src/maintenance/MaintenanceRunner.ts` | ~83 (between consolidate and prune) | Insert opt-in `dreaming` step: only runs when `options.dream === true` (Amendment #11) |
| `src/maintenance/MaintenanceRunner.ts` | MaintenanceResult interface (line ~20) | Add `dreamResult?: DreamResult` |
| `src/maintenance/MaintenanceRunner.ts` | MaintenanceOptions interface (line ~32) | Add `dream?: boolean` (default: false) |
| `src/http/rest-server.ts` | constructor | Instantiate DreamingEngine with deps |

### Phase 3 Integration

| File | Line | Change |
|------|------|--------|
| `src/http/rest-server.ts` | UI routes section | Add `/ui/insights`, `/ui/mining`, `/ui/profile` |
| `src/http/ui-templates/` | New files | `insights.html`, `mining.html`, `profile.html` |

## Wiring Matrix

| Capability | User Trigger | Call Path | Integration Test |
|-----------|-------------|-----------|-----------------|
| Mine transcripts | `POST /api/v1/mining/start` | rest-server → TranscriptMiner.mine() → Claude CLI → MemoryManager.save() | curl POST → check facts stored |
| Mining status | `GET /api/v1/mining/status` | rest-server → SQLite mining_progress query | curl GET → check JSON response |
| MCP transcript_mine | MCP tool call | MiningToolModule → TranscriptMiner.mine() | MCP call → check result |
| Dreaming during maintenance | `memory_maintain` MCP tool | MaintenanceRunner.run() → DreamingEngine.dream() → MemoryManager.save() | maintenance run → check INSIGHT_DERIVED events |
| View insights | `GET /ui/insights` | rest-server → query memories where category='derived_insight' | curl → HTML with insights |
| View mining status | `GET /ui/mining` | rest-server → query mining_progress table | curl → HTML with progress |
| View profile | `GET /ui/profile` | rest-server → UserProfile.getProfile() | curl → HTML with profile |
| Auto-profile update | Triggered by mining + dreaming | TranscriptMiner.updateProfileFromFacts() / DreamingEngine → UserProfile.updateProfile() | mine → check profile fields updated |

## Verification Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | TranscriptMiner file exists | `ls src/mining/TranscriptMiner.ts` | File exists |
| 2 | DreamingEngine file exists | `ls src/dreaming/DreamingEngine.ts` | File exists |
| 3 | New EventTypes added | `grep "TRANSCRIPT_MINED" src/types/index.ts` | Match found |
| 4 | Mining routes wired | `grep "mining/start" src/http/rest-server.ts` | Match found |
| 5 | Dreaming in MaintenanceRunner | `grep "dream" src/maintenance/MaintenanceRunner.ts` | Match found |
| 6 | mining_progress table created | `grep "mining_progress" src/` | Match found |
| 7 | MCP tool registered | `grep "transcript_mine" src/mcp/` | Match found |
| 8 | MiningToolModule exists | `ls src/mcp/handlers/MiningToolModule.ts` | File exists |
| 9 | Tests exist | `ls src/mining/__tests__/ src/dreaming/__tests__/` | Files exist |
| 10 | No TODO/FIXME in new files | `grep -r "TODO\|FIXME" src/mining/ src/dreaming/` | No matches |

## Functional Tests

| # | Test Name | Command | Expected Output |
|---|-----------|---------|-----------------|
| 1 | Mine single session | `curl -s -X POST localhost:3003/api/v1/mining/start -H 'Content-Type: application/json' -d '{"limit":1}'` | `{"data":{"sessionsProcessed":1,"factsExtracted":>0}}` |
| 2 | Mining status | `curl -s localhost:3003/api/v1/mining/status` | `{"data":{"total":N,"completed":N}}` |
| 3 | Maintenance with dreaming | `curl -s -X POST localhost:3003/api/v1/maintenance/run -d '{}'` (via MCP) | Result includes `dreamResult` |
| 4 | Insights queryable | `curl -s 'localhost:3003/api/v1/search?query=derived+insight'` | Results with category=derived_insight |
| 5 | Profile auto-updated | `curl -s localhost:3003/api/v1/profile` | Profile has expertise/focus from mining |
| 6 | Insights UI page | `curl -s localhost:3003/ui/insights` | HTML 200 with insights table |
| 7 | Mining UI page | `curl -s localhost:3003/ui/mining` | HTML 200 with progress table |
| 8 | Profile UI page | `curl -s localhost:3003/ui/profile` | HTML 200 with profile card |

## Acceptance Criteria

### Functional
- [ ] Mining pipeline processes 251 main sessions and extracts facts into memories
- [ ] Each mined session produces ≥3 extracted facts on average
- [ ] Dreaming engine produces ≥1 derived insight per maintenance cycle (when sufficient memories exist)
- [ ] ContradictionDetector catches stale derived insights
- [ ] UserProfile automatically updated with expertise, projects, and focus from mining
- [ ] MCP `transcript_mine` tool works from Claude Code
- [ ] All 3 UI pages render with real data (/ui/insights, /ui/mining, /ui/profile)

### Non-Functional
- [ ] Mining a single session takes <30s
- [ ] Full corpus mining completes in <2 hours
- [ ] Dreaming adds <10s to maintenance cycle
- [ ] LLM cost for full corpus <$20
- [ ] No data loss — mining is idempotent (re-running skips completed sessions)
- [ ] Graceful degradation — mining/dreaming work without OpenAI key (heuristic fallback)

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Claude CLI hangs or crashes | High | Medium | 2-minute timeout per call, kill process, fallback to Gemini/OpenAI API (Amendment #4) |
| Claude CLI unavailable (not installed, auth expired) | High | Low | Detect on startup, warn user, fallback to API providers |
| LLM produces low-quality facts | High | Medium | Quality scoring on extracted facts, discard low-confidence |
| Mining takes too long | Medium | Low | Configurable batch size, progress tracking, streaming JSONL (Amendment #9) |
| Dreaming produces hallucinated insights | High | Medium | Source linking (which memories produced the insight), exclude derived_insight input (Amendment #12) |
| Corrupted .jsonl files | Low | Low | Try/catch per file, skip on error, log failures |
| Memory pressure from large JSONL files | Medium | Medium | Stream line-by-line via node:readline, never load entire file (Amendment #9) |
| PII/sensitive data in transcripts | Medium | Medium | Warning in docs, API keys/passwords may appear in mined conversations (Amendment #16) |
| Circular reasoning in dreaming | Medium | Low | Filter derived_insight category from dreaming input (Amendment #12) |
| Concurrent mining requests corrupt state | Medium | Low | Singleton miningLock prevents concurrent mining (Amendment #8) |
| Stale processing entries after crash | Medium | Medium | recoverStaleEntries() resets entries >1hr old on startup (Amendment #10) |

## Complete File Structure

```
src/
├── mining/
│   ├── TranscriptMiner.ts           # NEW — conversation mining pipeline
│   └── __tests__/
│       └── TranscriptMiner.test.ts   # NEW
├── dreaming/
│   ├── DreamingEngine.ts             # NEW — dreaming/reasoning engine
│   └── __tests__/
│       └── DreamingEngine.test.ts    # NEW
├── types/index.ts                    # MODIFIED — new EventTypes
├── http/
│   ├── rest-server.ts                # MODIFIED — new routes
│   └── ui-templates/
│       ├── insights.html             # NEW
│       ├── mining.html               # NEW
│       └── profile.html              # NEW
├── maintenance/
│   └── MaintenanceRunner.ts          # MODIFIED — dreaming step
└── mcp/
    ├── handlers/
    │   └── MiningToolModule.ts       # NEW — transcript_mine MCP tool (Amendment #6)
    └── PingMemServer.ts              # MODIFIED — register MINING_TOOLS
```

## Dependencies

| Package | Version | Purpose | License |
|---------|---------|---------|---------|
| (none new) | — | All existing deps sufficient | — |

Uses existing: `bun:sqlite` (storage), `hono` (REST), `node:readline` (JSONL streaming), `node:fs/promises` (file scanning), `node:child_process` (Claude CLI subprocess).

**LLM Access Strategy — Claude Max OAuth (no API key)**:

Claude Max $200/month plan uses OAuth via `claude` CLI, not API keys. Pattern from u-os `model_router.py`:
```typescript
// Call Claude via CLI subprocess — ASYNC with timeout (Amendment #4)
async function callClaude(prompt: string, model: string, system?: string): Promise<string> {
  const cmd = ["claude", "-p", "--output-format", "json", "--model", model,
    "--no-session-persistence", "--max-turns", "1", "--dangerously-skip-permissions"];
  const proc = Bun.spawn(cmd, {
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 120_000); // 2min timeout
  const stdout = await new Response(proc.stdout).text();
  clearTimeout(timeout);
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Claude CLI exited with ${exitCode}`);
  return JSON.parse(stdout).result;
}
```

**LLM Model Hierarchy**:
| Task | Primary (Claude Max OAuth) | Fallback 1 (Gemini API) | Fallback 2 (OpenAI API) |
|------|---------------------------|------------------------|------------------------|
| Fact extraction (mining) | Claude Haiku 4.5 via CLI | Gemini 3.1 Pro via API | GPT-4o via API |
| Dreaming (deduction) | Claude Sonnet 4.6 via CLI | Gemini 3.1 Pro via API | GPT-4o via API |
| Dreaming (generalization) | Claude Sonnet 4.6 via CLI | Gemini 3.1 Pro via API | GPT-4o via API |
| Contradiction detection | Claude Haiku 4.5 via CLI | Gemini 3.1 Pro via API | GPT-4o-mini via API |

**Cost**: $0 incremental (included in Max plan). Fallbacks only if `claude` CLI unavailable.
**Gemini key**: `~/Projects/.creds/gemini_api_key.json`
**OpenAI key**: `~/Projects/.creds/openai-creds-ping-trade.md`

## Success Metrics

| Metric | Baseline | Phase 1 Target | Phase 2 Target | Phase 3 Target |
|--------|----------|---------------|---------------|---------------|
| Mined sessions | 0 | 251 | 251 | 251 |
| Extracted facts | ~5 manual | 500-1000 | 500-1000 | 500-1000 |
| Derived insights | 0 | 0 | 20-50 | 20-50 |
| UserProfile fields auto-populated | 0 | 3+ (expertise, projects, focus) | 5+ (add traits) | 5+ |
| UI pages for intelligence | 0 | 0 | 0 | 3 |
| Auto-recall relevance improvement | baseline | +10% (more facts) | +20% (derived insights) | +20% |
