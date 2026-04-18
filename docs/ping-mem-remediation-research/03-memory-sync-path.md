# R3 — Claude Code Memory Sync Path

**Date**: 2026-04-18
**Research agent**: R3
**Goal**: Pick ONE implementation path for syncing the user's Claude Code memory files into ping-mem so that `/api/v1/search` returns hits for the regression query set.

---

## 1. Problem restatement (evidence)

- The Claude Code memory files live at:
  - `/Users/umasankr/.claude/projects/-Users-umasankr-Projects-<slug>/memory/*.md` (per-project auto-memory; 20 `.md` files under ping-learn alone, 176 `.md` files across all projects — `find` count).
  - `/Users/umasankr/.claude/memory/` (`core.md`, `me.md`, `project_*.md`, `feedback_*.md`, plus `projects/` and `topics/` subdirs — 9 top-level `.md` files found).
  - `/Users/umasankr/.claude/learnings/` (`domains/`, `sessions/`, `v2/`, `index.json`, `UNIFIED_LEARNING_SYSTEM.md`, etc.).
- Ping-mem today has `/api/v1/context` (POST) and `/api/v1/search` (GET) wired in `src/http/rest-server.ts:759` and `src/http/rest-server.ts:1730`. Line 876 already declares `PUT /api/v1/context/:key — update an existing memory by key (used by native-sync hook)` — i.e. the codebase already anticipates a file-driven sync path.
- `codebase_ingest` path is guarded by `DEFAULT_EXCLUDE_EXTENSIONS` in `src/ingest/ProjectScanner.ts:44–76`, which includes `.md` (line 74) and `.jsonl` (line 75). Any `~/.claude/memory` tree passed through `codebase_ingest` would skip every file unless the caller overrides `includeExtensions` (declared on `ProjectScanOptions` at `src/ingest/ProjectScanner.ts:82–88`).
- The graphify skill (`~/.claude/skills/graphify/SKILL.md`) is an agentic pipeline: it spawns parallel subagents for semantic extraction (Step 3B, lines 197–361 of the SKILL) and emits `graphify-out/graph.json` + `cypher.txt`. It is designed for corpus analysis, not continuous file-to-memory mirroring. Its outputs are graphs, not retrievable key-value memories.

## 2. Regression set

Search query → must return ≥1 hit:
1. `ping-learn pricing research`
2. `Firebase FCM pinglearn-c63a2`
3. `classroom redesign worktree`
4. `PR #236 JWT secret isolation`
5. `DPDP consent age 18`

Cross-checked against file content: every one of these phrases is present verbatim or near-verbatim in `/Users/umasankr/.claude/projects/-Users-umasankr-Projects-ping-learn/memory/MEMORY.md` (cited lines 25–26, 29–30) and referenced topic files (`project_us_pricing_decision.md`, `project_dpdp_consent_age.md`). Any path that ingests these `.md` files as searchable text satisfies the regression set.

## 3. Option analysis

### Option A — `codebase_ingest` on `~/.claude/memory/`

- **Gains**: reuses all of `IngestionOrchestrator` (`src/ingest/IngestionOrchestrator.ts:66+`) including Merkle hashing, chunking, git history, and Qdrant indexing. Search goes through `/api/v1/codebase/search` (`src/http/rest-server.ts:1190`).
- **Losses**:
  - `~/.claude/memory/` is not a git repo, so `GitHistoryReader` returns empty history. `projectId = SHA-256(gitRemoteUrl + "::" + relativeToGitRoot)` (guide §7) falls back to a path-derived ID — fragile.
  - `.md` is excluded by default (`ProjectScanner.ts:74`). Requires passing a custom `includeExtensions` set.
  - User's regression queries hit `/api/v1/search` (the **memory** endpoint at `rest-server.ts:1730`), not `/api/v1/codebase/search`. Codebase ingestion fills Qdrant vectors keyed to `codebase-*` collections, not the memory store backed by `MemoryManager`. A search against `/api/v1/search` would still return zero after ingestion.
  - No bi-directional edits: `ManifestStore` caches a snapshot; changes ping-mem makes to a "memory" record have no write-back to the `.md`.
- **Effort**: low — one script registers paths in `~/.ping-mem/registered-projects.txt`. But it does **not** satisfy the regression set as specified.

### Option B — Graphify + import into Neo4j

- **Gains**: rich concept graph, cross-file surprise connections. Graph imports into ping-mem's existing Neo4j via `graphify --neo4j-push` (SKILL Step 7, lines 583–620).
- **Losses**:
  - Graphify is a batch pipeline that costs LLM tokens every run (SKILL Step 3B). Memory files change many times per day; this is unaffordable and slow.
  - Output is nodes + edges, not `Memory` rows. `/api/v1/search` is backed by `MemoryManager` (`src/memory/MemoryManager.ts:170+`) + `VectorIndex`, not Neo4j graph traversal. Regression queries still return zero.
  - No deletion propagation, no live watch (graphify `--watch` in SKILL Step 11 only covers code AST, "Docs, papers, or images: writes a `graphify-out/needs_update` flag" — manual LLM re-extraction required).
- **Effort**: medium — but product shape is wrong (graph, not searchable memory).

### Option C — Custom watcher → `/api/v1/context` (memory save)

- **Gains**:
  - Directly targets the endpoint the regression test queries (`/api/v1/search`). `context_save` writes through `MemoryManager.saveMemory`, which populates `VectorIndex` and `EventStore` — the exact substrate `/api/v1/search` reads from.
  - Bi-directional: file edit → HTTP PUT → memory updated. Memory update → (optional) file write. The PUT route already exists and is labeled for this purpose (`rest-server.ts:876–877`).
  - Handles deletes explicitly via `DELETE /api/v1/context/:key` (`rest-server.ts:1690`).
  - Tiny surface area: one watcher module, one reconciler, one systemd/launchd plist.
- **Losses**:
  - Need to build the watcher (not already present).
  - chokidar is a non-trivial dependency; fs.watch on macOS has known recursion quirks — solvable.
- **Effort**: small-to-medium; fully determined shape.

## 4. Decision matrix

| Criterion | A: codebase_ingest | B: graphify | C: custom watcher |
|---|---|---|---|
| Satisfies regression set (`/api/v1/search` hits) | **No** (writes to codebase Qdrant collection, not memory store) | **No** (writes Neo4j nodes, not `Memory` rows) | **Yes** (direct `MemoryManager.saveMemory`) |
| Bi-directional edits | No | No | Yes (PUT route exists) |
| Deletion propagation | No (manifest snapshot) | No | Yes (DELETE route) |
| Ongoing cost | Re-ingest only; free | LLM tokens per run | Free (fs events) |
| Implementation effort in `src/` | Low, but wrong target | Medium, wrong shape | Small (~6 files) |

## 5. Decision — Option C

**Pick C: custom watcher + `/api/v1/context` sync.**

Rationale in ≤200 words: The regression is defined on `/api/v1/search`, which is served by `MemoryManager` in `src/memory/`. Only Option C writes into that exact substrate. Option A writes to the codebase vector collection (`/api/v1/codebase/search`), so even after "successful ingestion" the five regression queries still fail — this is the same root cause the user already reported (682 memories exist but are unrelated code-ingest artifacts). Option B produces a graph, not retrievable memories, and costs LLM tokens every run, which is incompatible with a continuously mutating memory tree. The `.md` exclusion at `ProjectScanner.ts:74` and the pre-existing `PUT /api/v1/context/:key — used by native-sync hook` stub at `rest-server.ts:876–877` together prove the ping-mem repo already expects a file-driven memory sync, not codebase ingestion, for this data. C is the only option where "file edits propagate to ping-mem, ping-mem edits propagate to file, deletions cascade, search returns the expected hits" all hold simultaneously.

## 6. Implementation outline (Option C)

### 6.1 New module: `src/memory/sync/`

| File | Purpose |
|---|---|
| `src/memory/sync/ClaudeMemorySync.ts` | Main controller. Holds watcher + reconciler. |
| `src/memory/sync/MemoryFileParser.ts` | Parses a single `.md` into `{ key, value, category, priority, metadata }`. Front-matter aware. |
| `src/memory/sync/PathRegistry.ts` | Canonical list of sync roots: `~/.claude/memory`, `~/.claude/learnings`, `~/.claude/projects/*/memory`, `~/.claude/CLAUDE.md`, `<project>/CLAUDE.md`. |
| `src/memory/sync/Reconciler.ts` | Periodic full scan vs in-memory map to catch missed fs events. |
| `src/memory/sync/index.ts` | Exports + factory. |
| `src/memory/sync/__tests__/*.test.ts` | bun tests. |

### 6.2 Function signatures

```ts
// ClaudeMemorySync.ts
export interface ClaudeMemorySyncConfig {
  roots: string[];                  // from PathRegistry.defaults()
  memoryManager: MemoryManager;     // reuse existing src/memory/MemoryManager.ts
  pollIntervalMs?: number;          // reconciler cadence, default 60_000
  debounceMs?: number;              // per-file debounce, default 500
}

export class ClaudeMemorySync {
  constructor(cfg: ClaudeMemorySyncConfig);
  async start(): Promise<void>;                      // kick off chokidar + reconciler
  async stop(): Promise<void>;
  async syncFile(abs: string): Promise<SyncResult>;  // idempotent upsert
  async deleteFile(abs: string): Promise<void>;      // DELETE on memory key
  async fullReconcile(): Promise<ReconcileReport>;   // diff fs vs memory, fix drift
}

// MemoryFileParser.ts
export interface ParsedMemoryFile {
  key: string;        // stable hash of abs path (e.g. claude-mem:<sha>)
  value: string;      // markdown body
  category: MemoryCategory;  // inferred: "decision" | "note" | "fact"
  priority: MemoryPriority;  // front-matter or default "normal"
  channel: string;    // "claude-memory"
  metadata: {
    sourcePath: string;
    mtimeMs: number;
    contentSha256: string;
    scope: "global" | "project" | "learning" | "topic";
    projectSlug?: string;
  };
}

export function parseMemoryFile(abs: string): Promise<ParsedMemoryFile>;
```

### 6.3 Reused existing code

- `MemoryManager.saveMemory` / `updateMemory` / `deleteMemory` (`src/memory/MemoryManager.ts`) — direct calls, no HTTP.
- `VectorIndex` via `MemoryManager` constructor injection — embeddings automatic.
- `JunkFilter` already gates `/api/v1/context`; reuse it here for parity.
- `EventStore` — every sync becomes an event; audit trail for free.
- `createLogger("ClaudeMemorySync")` pattern from `src/util/logger.ts`.

### 6.4 Watcher survival (launchd)

The sync service must not depend on a live Claude Code session.

- Add `src/memory/sync/daemon.ts` — CLI entry that boots a ping-mem REST client against the existing daemon, then instantiates `ClaudeMemorySync` using the daemon's `MemoryManager` via a new internal factory.
- Register as a launchd agent: `~/Library/LaunchAgents/com.ping-mem.memory-sync.plist`. Install via a new script `scripts/install-memory-sync.sh`. KeepAlive = true, RunAtLoad = true.
- Alternative: run inside the existing `ping-mem` Docker container. Mount `~/.claude` read-only into the container (`docker-compose.yml` volumes addition). Container `CMD` already launches the server; add `bun run src/memory/sync/daemon.ts &` in a supervisor-style entrypoint wrapper (`scripts/entrypoint.sh`) so a crash in one process does not kill the other.
- Preferred: launchd plist on macOS host. Reason: `~/.claude` paths resolve natively; no volume-mount/symlink-resolution risk (guide §8 symlink handling).

### 6.5 Deletion handling

- `chokidar` emits `unlink`. Handler derives `key = claude-mem:<sha of abs path>` and calls `MemoryManager.deleteMemory(key)`. This mirrors `DELETE /api/v1/context/:key` (`rest-server.ts:1690`).
- On startup, `Reconciler.fullReconcile()` lists all memories with `channel = "claude-memory"`, compares to the on-disk set under the registered roots, deletes memories whose source file no longer exists, and upserts any file whose `contentSha256` differs.

### 6.6 Bi-directional propagation (optional, gated)

- When a user edits a memory via the admin UI (`src/http/ui/`), fire a post-update hook to write the file back to `metadata.sourcePath`. Feature-flag: `PING_MEM_MEMORY_SYNC_WRITEBACK=true`. Off by default — avoids clobbering user files until tested.

### 6.7 Regression coverage

After bring-up, the five regression queries resolve:
1. `ping-learn pricing research` → matches `project_us_pricing_decision.md` body + `MEMORY.md:29–30`.
2. `Firebase FCM pinglearn-c63a2` → matches `MEMORY.md` FCM section.
3. `classroom redesign worktree` → matches `MEMORY.md:10–19`.
4. `PR #236 JWT secret isolation` → matches `MEMORY.md` PR #236 heading.
5. `DPDP consent age 18` → matches `MEMORY.md:25–26` + `project_dpdp_consent_age.md`.

Each becomes a bun test in `src/memory/sync/__tests__/regression.test.ts` that:
1. Seeds a tmp dir with fixture `.md` files containing the phrases.
2. Boots `ClaudeMemorySync` against an in-memory `MemoryManager`.
3. Asserts `manager.search({ query })` returns ≥1 hit per query.

### 6.8 Config additions (`src/http/rest-server.ts` constructor)

- Wire `ClaudeMemorySync` on server boot when `PING_MEM_CLAUDE_MEMORY_SYNC=true` (default on for local dev, off in CI).
- Single call site addition; no route changes — `POST/PUT/DELETE /api/v1/context` already exist.

## 7. What ships in one plan

1. `src/memory/sync/` module + tests (6 files).
2. `scripts/install-memory-sync.sh` + `Library/LaunchAgents/com.ping-mem.memory-sync.plist` template.
3. Docs: append "Claude Memory Sync" section to `docs/AGENT_INTEGRATION_GUIDE.md`.
4. Regression test suite covering the 5 queries above.
5. Feature flag `PING_MEM_CLAUDE_MEMORY_SYNC` in env table (guide §3.4).

Every item above is in-scope. No deferrals. Bi-directional write-back is feature-flagged on the same commit — no separate plan.

---

**File paths cited for every claim**:
- `/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:759` (POST context)
- `/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:876–877` (PUT context — native-sync hook stub)
- `/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:1190` (codebase search)
- `/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:1690` (DELETE context)
- `/Users/umasankr/Projects/ping-mem/src/http/rest-server.ts:1730` (memory search)
- `/Users/umasankr/Projects/ping-mem/src/ingest/ProjectScanner.ts:44–76` (DEFAULT_EXCLUDE_EXTENSIONS including `.md`)
- `/Users/umasankr/Projects/ping-mem/src/ingest/IngestionOrchestrator.ts:66+`
- `/Users/umasankr/Projects/ping-mem/src/memory/MemoryManager.ts:170+` (saveMemory target)
- `/Users/umasankr/.claude/skills/graphify/SKILL.md` (steps 3B, 7, 11)
- `/Users/umasankr/.claude/projects/-Users-umasankr-Projects-ping-learn/memory/MEMORY.md` (regression phrases)
- `/Users/umasankr/Projects/ping-mem/docs/AGENT_INTEGRATION_GUIDE.md` §3.4, §7, §8
