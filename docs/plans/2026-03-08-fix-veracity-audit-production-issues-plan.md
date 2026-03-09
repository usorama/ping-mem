---
title: "Fix All Veracity Audit Production Issues"
type: fix
date: 2026-03-08
issues: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
status: ready
---

# Fix All Veracity Audit Production Issues (#12-#22)

## Overview

A veracity audit comparing ping-mem's self-knowledge (API queries) against actual codebase truth uncovered 10 issues spanning the ingestion pipeline, documentation, security, and test coverage. Three of these are **cascading P0 failures** that render codebase search, timeline queries, and knowledge search non-functional in production.

This plan fixes all 10 issues in 5 phases with strict dependency ordering, no deferrals, and end-to-end verification on a fresh Dev environment.

## Problem Statement

### Cascading Failure Chain (P0)

```
Bug #12: TemporalCodeGraph.persistIngestion() passes undefined to Neo4j
    |    -> Neo4j MERGE creates Project nodes with NULL projectId/name/path
    |
    |---> Bug #14: queryCommitHistory() MATCH on NULL projectId -> 0 rows
    |     -> Timeline endpoint returns empty arrays
    |
    +---> Bug #13: CodeIndexer.buildIndexPoints() excludes content from payload
          -> search() expects payload.content -> always returns ""
          -> Codebase search returns empty content (independent of #12)
```

### Additional Issues

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 15 | Knowledge store empty -- no data ingested | High | Data |
| 16 | Version mismatch (README 2.0.0, package.json 1.0.0, CLAUDE.md 1.4.1) | Medium | Docs |
| 17 | CLAUDE.md stale roadmap -- fixed items listed as "Pending" | Medium | Docs |
| 18 | Worktree code pollution in Qdrant index | Medium | Ingestion |
| 19 | 5 console.* calls in production code | Low | Quality |
| 20 | ProjectScanner uses execSync instead of SafeGit | Low | Security |
| 21 | Conformance tests have 6 TODO stubs | Low | Tests |
| 22 | Missing test coverage for client/, config/, types/ | Low | Tests |

---

## Technical Approach

### Architecture Context

```
Ingestion Pipeline Data Flow:

  ProjectScanner.scanProject()          [SYNC -> must go ASYNC]
       |
       +-- getGitIdentity()             [execSync -> SafeGit]
       |     +-- git rev-parse          [SafeGit.getRoot()]
       |     +-- git config --get       [SafeGit.getRemoteUrl() -- NEW]
       |
       +-- collectFiles() + computeHashes()
              +-- DEFAULT_IGNORE_DIRS   [add .worktrees,.claude]

  IngestionOrchestrator.ingest()        [await scanProject()]
       |
       +-- CodeChunker.chunkFile()
       +-- SymbolExtractor.extractFromFile()
       +-- GitHistoryReader.readHistory()
       +-- ManifestStore.save()

  IngestionService.ingestProject()
       |
       +-- TemporalCodeGraph.persistIngestion()  [FIX: #12]
       |     +-- MERGE Project { projectId }     [null guard]
       |
       +-- CodeIndexer.indexIngestion()           [FIX: #13]
             +-- buildIndexPoints()               [add content]

  IngestionService.queryTimeline()                [FIX: #14]
       +-- TemporalCodeGraph.queryCommitHistory() [validate]
```

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Null handling in persistIngestion | **Throw immediately** | Matches SafeGit fail-fast pattern; silent skip would hide data loss |
| Content in Qdrant payload | **Include, truncated to 2000 chars** | String.substring(0, 2000) is safe for JS strings; oversized payload risk mitigated by reducing batch size from 500 to 200 |
| SafeGit async cascade | **Convert scanProject() to async** | Required since SafeGit uses promisify(execFile); affects IngestionOrchestrator and callers |
| Stale vector cleanup | **Full wipe + re-ingest** | Simpler than targeted deletion; safe since we backup first |
| Knowledge seeding | **Manual manifest of entries** | Automated markdown parsing produces inconsistent results; 10-15 curated entries from docs/ |
| Conformance test stubs | **Replace with GraphManager/LineageEngine tests** | Methods already exist; implementing TemporalStore.queryRelationships is unnecessary abstraction |
| Version jump 1.0.0 -> 2.0.0 | **Intentional** | Multi-agent orchestration is a breaking API change; semver correct |
| SSE client logger migration | **Keep console.error** | SSE client is browser-compatible; createLogger import path won't resolve in browser bundles |

---

## Implementation Phases

### Dependency Graph

```
Phase 1: Foundation (SafeGit + Worktree + Logger)
    |     Issues: #18, #19, #20
    |     Files: ProjectScanner.ts, SafeGit.ts, admin.ts, cli.ts, .gitignore
    |
    v
Phase 2: Ingestion Pipeline Fix (Core P0 bugs)
    |     Issues: #12, #13, #14
    |     Files: TemporalCodeGraph.ts, CodeIndexer.ts, IngestionService.ts,
    |            IngestionOrchestrator.ts
    |
    v
Phase 3: Documentation + Tests (Parallel)
    |     Issues: #16, #17, #21, #22
    |     Files: package.json, CLAUDE.md, conformance.test.ts, new test files
    |
    v
Phase 4: Knowledge Seeding + Data Verification
    |     Issues: #15
    |     Files: scripts/seed-knowledge.ts (new)
    |
    v
Phase 5: End-to-End Verification
          Fresh Docker, self-ingest, verify all flows
```

---

### Phase 1: Foundation (SafeGit + Worktree + Logger)

**Issues**: #18, #19, #20
**Risk Level**: Low -- isolated changes, no cascading effects
**Quality Gate**: `bun run typecheck && bun test`

#### 1A. SafeGit Migration (#20)

**File**: `src/ingest/SafeGit.ts`

**Add `getRemoteUrl()` method** (after getHead(), line 79):

```typescript
async getRemoteUrl(): Promise<string | null> {
  try {
    const result = await this.exec(["config", "--get", "remote.origin.url"]);
    return result.trim() || null;
  } catch {
    return null; // No remote configured
  }
}
```

**File**: `src/ingest/ProjectScanner.ts`

**Convert `getGitIdentity()` from sync to async:**

Current (lines 127-156) uses execSync. Replace with:

```typescript
private async getGitIdentity(rootPath: string): Promise<string | null> {
  try {
    const safeGit = createSafeGit(rootPath);
    const gitRoot = await safeGit.getRoot();
    const remoteUrl = await safeGit.getRemoteUrl();
    if (!remoteUrl) return null;
    const relativePath = path.relative(gitRoot, rootPath);
    return `${remoteUrl}::${relativePath || "."}`;
  } catch {
    return null;
  }
}
```

**Cascade: Convert `computeProjectId()` to async:**

```typescript
private async computeProjectId(rootPath: string): Promise<string> {
  const gitKey = await this.getGitIdentity(rootPath);
  const input = gitKey ?? this.normalizePath(rootPath);
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
```

**Cascade: Convert `scanProject()` to async:**

```typescript
async scanProject(rootPath: string, options?: ProjectScanOptions): Promise<ProjectScanResult> {
  const projectId = await this.computeProjectId(rootPath);
  // ... rest unchanged
}
```

**Cascade: Update callers** in `IngestionOrchestrator.ingest()` (already async, just add `await`):
```typescript
// src/ingest/IngestionOrchestrator.ts line ~73
const scanResult = await this.scanner.scanProject(rootPath, scanOptions);
```

**Remove `execSync` import** from ProjectScanner.ts. Add `createSafeGit` import instead.

**Tests to update**: `src/ingest/__tests__/ProjectScanner.test.ts` -- update to use `await scanner.scanProject()`.

**Risks**:
- Breaking change to scanProject() signature (sync -> async). All callers verified async: IngestionOrchestrator.ingest(), IngestionService.ingestProject(), UnifiedIngestionOrchestrator.ingest().
- SafeGit must be initialized with correct cwd. Verify SafeGit constructor passes cwd to execFile.

#### 1B. Worktree Exclusion (#18)

**File**: `src/ingest/ProjectScanner.ts` (lines 7-20)

Add to `DEFAULT_IGNORE_DIRS`:
```typescript
const DEFAULT_IGNORE_DIRS = new Set([
  ".git", ".svn", ".hg", "node_modules", "dist", "build",
  ".next", ".cache", ".venv", "venv", "__pycache__", ".ping-mem",
  ".worktrees", ".claude",  // Prevent worktree/claude code from polluting index
]);
```

Note: collectFiles() at line 71 already skips entries starting with `.` (except `.env`). Adding to DEFAULT_IGNORE_DIRS is defense-in-depth and makes the exclusion explicit/documented.

**File**: `.gitignore` -- append:
```
# Development worktrees
.worktrees/
```

**Risks**: None -- additive change, no behavioral impact on existing scans.

#### 1C. Logger Migration (#19)

**Files to modify** (5 actual production console.* calls):

| File | Line | Current | New |
|------|------|---------|-----|
| `src/http/admin.ts` | 590 | `refreshKeys().catch(console.error)` | `refreshKeys().catch(e => log.error("refreshKeys failed", { error: e instanceof Error ? e.message : String(e) }))` |
| `src/http/admin.ts` | 591 | `refreshProjects().catch(console.error)` | `refreshProjects().catch(e => log.error("refreshProjects failed", { error: e instanceof Error ? e.message : String(e) }))` |
| `src/http/admin.ts` | 592 | `loadLLMConfig().catch(console.error)` | `loadLLMConfig().catch(e => log.error("loadLLMConfig failed", { error: e instanceof Error ? e.message : String(e) }))` |
| `src/cli.ts` | 55 | `console.log(banner)` | `log.info("Server starting", { ... })` |
| `src/client/sse-client.ts` | 352 | `console.error("[SSE Client]...")` | **KEEP** -- browser-compatible client, logger import path won't resolve in browser bundles |

Add logger import to `admin.ts` and `cli.ts`:
```typescript
import { createLogger } from "../util/logger.js";
const log = createLogger("Admin"); // or "CLI"
```

**Verification**: grep should return only sse-client.ts (intentionally kept) and doc-comment references.

**Risks**: None -- structural change only, no behavioral impact.

---

### Phase 2: Ingestion Pipeline Fix (P0)

**Issues**: #12, #13, #14
**Risk Level**: HIGH -- core data pipeline, cascading changes
**Quality Gate**: `bun run typecheck && bun test`
**Dependencies**: Phase 1 complete (ProjectScanner now async, worktree exclusion in place)

#### 2A. Fix Neo4j NULL Project Nodes (#12)

**File**: `src/graph/TemporalCodeGraph.ts`

**Add null validation before MERGE** (lines 59-76):

```typescript
async persistIngestion(result: IngestionResult): Promise<void> {
  // Fail-fast: validate required fields
  if (!result.projectId) {
    throw new Error(`persistIngestion: projectId is required but got "${result.projectId}"`);
  }
  if (!result.projectManifest?.rootPath) {
    throw new Error(`persistIngestion: rootPath is required but got "${result.projectManifest?.rootPath}"`);
  }
  if (!result.projectManifest?.treeHash) {
    throw new Error(`persistIngestion: treeHash is required but got "${result.projectManifest?.treeHash}"`);
  }

  const session = this.client.getSession();
  try {
    // MERGE Project node (now guaranteed non-null)
    await session.run(
      `MERGE (p:Project { projectId: $projectId })
       SET p.name = $name,
           p.rootPath = $rootPath,
           p.treeHash = $treeHash,
           p.lastIngestedAt = $ingestedAt`,
      {
        projectId: result.projectId,
        name: result.projectManifest.rootPath.split("/").pop() || result.projectId,
        rootPath: result.projectManifest.rootPath,
        treeHash: result.projectManifest.treeHash,
        ingestedAt: result.ingestedAt,
      }
    );
    // ... rest of persist logic (files, chunks, symbols, commits)
  } finally {
    await session.close();
  }
}
```

**Key fix**: SET `p.name` to the directory basename (e.g., "ping-mem"). The original code NEVER set `name`, causing all Project nodes to have NULL name.

**Add Neo4j constraints** -- new `ensureConstraints()` method:

```typescript
async ensureConstraints(): Promise<void> {
  const session = this.client.getSession();
  try {
    await session.run(
      "CREATE CONSTRAINT project_id_not_null IF NOT EXISTS FOR (p:Project) REQUIRE p.projectId IS NOT NULL"
    );
    await session.run(
      "CREATE CONSTRAINT project_id_unique IF NOT EXISTS FOR (p:Project) REQUIRE p.projectId IS UNIQUE"
    );
    log.info("Neo4j constraints ensured");
  } finally {
    await session.close();
  }
}
```

Call `ensureConstraints()` from IngestionService constructor or first `ingestProject()` call.

**Risks**:
- If constraint is applied before wiping NULL nodes, it will fail. Mitigation: IF NOT EXISTS clause handles this gracefully; wipe happens in Phase 5 before re-ingestion.
- The `name` field derivation (basename of rootPath) may not be unique across projects. Mitigated by using `projectId` (SHA-256 hash) as the unique key, not `name`.

#### 2B. Fix Qdrant Empty Content (#13)

**File**: `src/search/CodeIndexer.ts`

**Add content to payload** in `buildIndexPoints()` (lines 158-194):

```typescript
// Inside the chunk mapping, add content field:
payload: {
  projectId: result.projectId,
  filePath: fileResult.filePath,
  chunkId: chunk.chunkId,
  sha256: fileResult.sha256,
  type: chunk.type,
  content: chunk.content.substring(0, 2000),  // Truncated to prevent oversized payloads
  start: chunk.start,
  end: chunk.end,
  lineStart: chunk.lineStart,
  lineEnd: chunk.lineEnd,
  ingestedAt: result.ingestedAt,
}
```

**Reduce batch size** to prevent Qdrant 400 errors with larger payloads:

```typescript
const BATCH_SIZE = 200; // Reduced from 500 to accommodate content payloads
```

**Verify search() result mapping** (line 123-135) -- already reads `payload?.content`, will now get actual data instead of `""`.

**Risks**:
- Qdrant request body size. With 200 points at ~2KB content each = ~400KB per request. Qdrant default max is 256MB. Safe.
- Existing Qdrant points (without content) will still return `""` from search. Mitigated by full wipe-and-reingest in Phase 5.

#### 2C. Fix Empty Timeline (#14)

**File**: `src/graph/TemporalCodeGraph.ts`

**Add Project existence validation** in `queryCommitHistory()`:

```typescript
async queryCommitHistory(projectId: string, limit: number = 50): Promise<CommitRecord[]> {
  const session = this.client.getSession();
  try {
    // First verify the project exists
    const projectCheck = await session.run(
      "MATCH (p:Project { projectId: $projectId }) RETURN p.name AS name",
      { projectId }
    );
    if (projectCheck.records.length === 0) {
      log.warn("queryCommitHistory: project not found", { projectId });
      return [];
    }

    const result = await session.run(
      `MATCH (p:Project { projectId: $projectId })-[:HAS_COMMIT]->(c:Commit)
       RETURN c.hash AS hash, c.shortHash AS shortHash,
              c.authorName AS authorName, c.authorEmail AS authorEmail,
              c.message AS message, c.date AS date
       ORDER BY c.date DESC
       LIMIT $limit`,
      { projectId, limit: neo4j.int(limit) }
    );
    return result.records.map(/* ... existing mapping ... */);
  } finally {
    await session.close();
  }
}
```

**File**: `src/ingest/IngestionService.ts`

**Add validation in queryTimeline()** (lines 157-200):

```typescript
async queryTimeline(options: TimelineOptions): Promise<TimelineEntry[]> {
  if (!options.projectId) {
    throw new Error("queryTimeline requires a projectId");
  }
  // ... existing logic, now with project existence check in TemporalCodeGraph
}
```

**Risks**:
- Double-query (project check + commit query) adds latency. Mitigated by Neo4j in-memory cache.
- Empty results after fix still possible if no commits were ingested. This is correct behavior (project with no git history), not a bug.

#### 2D. Integration Tests for Pipeline Fixes

**New file**: `src/ingest/__tests__/IngestionPipeline.integration.test.ts`

Test cases (minimum 9):

1. persistIngestion throws on null projectId
2. persistIngestion throws on null rootPath
3. persistIngestion throws on null treeHash
4. persistIngestion sets Project.name from rootPath basename
5. CodeIndexer includes content field in Qdrant payload
6. CodeIndexer truncates content at 2000 characters
7. CodeIndexer search returns non-empty content
8. queryCommitHistory returns empty array for non-existent project
9. queryCommitHistory logs warning for missing project

---

### Phase 3: Documentation + Tests (Parallel)

**Issues**: #16, #17, #21, #22
**Risk Level**: Low -- docs and tests, no production code changes
**Quality Gate**: `bun run typecheck && bun test`
**Dependencies**: None (can run parallel with Phase 2 if agents work on different files)

#### 3A. Version Sync (#16)

| File | Current | New |
|------|---------|-----|
| `package.json` line 3 | `"version": "1.0.0"` | `"version": "2.0.0"` |
| `CLAUDE.md` line 3 | `**Version**: 1.4.1` | `**Version**: 2.0.0` |
| `README.md` | Already 2.0.0 | No change |

#### 3B. CLAUDE.md Roadmap Cleanup (#17)

**Remove** the entire "Pending: Security Fixes" section -- all items fixed:
- SQL injection in EventStore.deleteSessions() -- Fixed (parameterized queries)
- Command injection in GitHistoryReader -- Fixed (SafeGit)
- Admin timing attack -- Fixed (timingSafeStringEqual)
- Unvalidated JSON parsing -- Fixed (Zod schemas)

**Remove** the entire "Pending: Quality Improvements" section -- all items fixed:
- Neo4j session leaks -- Fixed (try-finally)
- Race conditions -- Fixed (promise mutex)
- Missing rate limiting -- Fixed (rate-limit.ts)
- CORS too permissive -- Fixed (restricted origins)
- any types -- Fixed (0 in production)
- Missing test coverage -- Fixed (83 test files)
- Resource cleanup -- Fixed (DiagnosticsStore/AdminStore closed)

**Update** "In Progress" section to "Completed".

**Update** "Codebase Audit Summary" section:
- Change "66 findings" to "All 66 findings resolved"
- Remove the "Top Priority Fixes" list (all done)

**Add** v2.0.0 entry to Version History table.

#### 3C. Conformance Test Completion (#21)

**File**: `src/graph/__tests__/conformance.test.ts`

Replace the 6 `it.skip` stubs with real tests:

**CT-004.1-004.3** (queryRelationships -> use GraphManager.findRelationshipsByEntity):
- CT-004.1: queries relationships for an entity (create entity + relationship, query, verify)
- CT-004.2: filters relationships by type (create multiple relationship types, filter, verify)
- CT-004.3: handles entities with no relationships (isolated entity, expect empty array)

**CT-008.1-008.3** (queryLineage -> use LineageEngine):
- CT-008.1: traces multi-ancestor lineage (chain A->B->C, getAncestors(C) = [B,A])
- CT-008.2: respects maxDepth parameter (chain A->B->C->D, maxDepth=2)
- CT-008.3: tracks hop distance (chain A->B->C, verify hop counts)

Remove all 6 `// TODO` comments.

**Risks**: Tests depend on GraphManager and LineageEngine mocks. Follow existing mock patterns in the file (mock Neo4jClient, create real GraphManager/LineageEngine with mocked client).

#### 3D. Test Coverage Expansion (#22)

**New files to create:**

**1. `src/config/__tests__/env-validation.test.ts`** (6+ test cases):
- accepts valid complete config
- accepts minimal config (all optional omitted)
- rejects invalid port (negative)
- rejects admin user without admin pass
- rejects Neo4j URI without password
- rejects invalid transport value

Note: validateEnv() calls process.exit(1). Tests must mock process.exit or refactor to throw.

**2. `src/types/__tests__/agent-errors.test.ts`** (4+ test cases):
- QuotaExhaustedError has correct code and message
- WriteLockConflictError is instanceof PingMemError
- ScopeViolationError preserves cause chain
- AgentNotRegisteredError includes agentId in message

**3. `src/client/__tests__/rest-client.test.ts`** (8+ test cases):
- constructs with default options
- startSession sends POST and returns sessionId
- save sends correct payload
- get retrieves by key
- search sends query params
- includes API key header when configured
- includes session ID header
- handles 401 with descriptive error

Mock fetch globally for REST client tests.

**4. `src/config/__tests__/runtime.test.ts`** (3+ test cases):
- creates services with minimal config
- creates services with full config
- handles missing optional services gracefully

**Total new tests**: 21+ test cases across 4 new files.

---

### Phase 4: Knowledge Seeding

**Issue**: #15
**Risk Level**: Medium -- new script, interacts with running services
**Quality Gate**: `bun run typecheck`
**Dependencies**: Phase 2 complete (ingestion pipeline working)

#### 4A. Create Knowledge Seed Script

**New file**: `scripts/seed-knowledge.ts`

Strategy: Curated manifest of knowledge entries extracted from documentation. Not automated markdown parsing (too fragile).

The script contains ~10 curated entries covering:
1. IngestionService not configured (503) -- troubleshooting
2. Empty codebase search results -- troubleshooting
3. MCP tools not appearing in IDE -- troubleshooting
4. Neo4j connection failed -- troubleshooting
5. Docker deployment on OrbStack -- deployment
6. Backup and restore procedure -- operations
7. Rate limiting returns 429 -- API
8. Multi-agent quota exhausted -- agents
9. ProjectId mismatch between Docker and local -- ingestion
10. Web UI architecture -- architecture

Each entry has: title, solution, symptoms, rootCause, tags.

Script computes projectId using SafeGit (getRoot + getRemoteUrl), accepts `--base-url` parameter, and uses fetch to POST to `/api/v1/knowledge/ingest`.

**Idempotency**: KnowledgeStore upserts by SHA-256(projectId + "::" + title). Running twice is safe.

**Risks**:
- Requires running server. Mitigated by accepting --base-url parameter and health check before seeding.

---

### Phase 5: End-to-End Verification

**Dependencies**: All phases complete
**Risk Level**: Medium -- destructive wipe step

#### 5A. Pre-Wipe Backup

```bash
./scripts/backup.sh /tmp/ping-mem-pre-wipe-backup
```

#### 5B. Fresh Dev Environment

```bash
# Stop and wipe all data volumes
docker compose -f docker-compose.prod.yml down -v

# Rebuild from scratch
docker compose -f docker-compose.prod.yml build --no-cache

# Start with empty databases
docker compose -f docker-compose.prod.yml up -d

# Wait for health
sleep 20
curl -f http://localhost:3000/health
```

#### 5C. Run Neo4j Constraints

```bash
docker exec ping-mem-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "CREATE CONSTRAINT project_id_not_null IF NOT EXISTS FOR (p:Project) REQUIRE p.projectId IS NOT NULL"
docker exec ping-mem-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "CREATE CONSTRAINT project_id_unique IF NOT EXISTS FOR (p:Project) REQUIRE p.projectId IS UNIQUE"
```

#### 5D. Self-Ingest ping-mem

```bash
curl -X POST http://localhost:3000/api/v1/codebase/ingest \
  -H "Content-Type: application/json" \
  -d '{"projectDir": "/projects/ping-mem"}'
```

Wait for ingestion to complete (check logs: `docker logs -f ping-mem`).

#### 5E. Seed Knowledge

```bash
cd /Users/umasankr/Projects/ping-mem
bun run scripts/seed-knowledge.ts --base-url http://localhost:3000
```

#### 5F. Verify All Flows

| Verification | Command | Expected |
|-------------|---------|----------|
| Health | `curl http://localhost:3000/health` | `{"status":"ok","components":{...}}` |
| Search content | `curl "http://localhost:3000/api/v1/codebase/search?query=MemoryManager&limit=1"` | Results with non-empty `content` field |
| Timeline | `curl "http://localhost:3000/api/v1/codebase/timeline?projectId=<id>&limit=5"` | Non-empty array with commit data |
| Knowledge | `curl -X POST http://localhost:3000/api/v1/knowledge/search -H "Content-Type: application/json" -d '{"query":"deployment"}'` | Results from seeded entries |
| Neo4j integrity | `docker exec ping-mem-neo4j cypher-shell ... "MATCH (p:Project) WHERE p.name IS NULL RETURN count(p)"` | `0` |
| Qdrant content | `curl http://localhost:6333/collections/ping-mem-vectors/points/scroll -X POST -H "Content-Type: application/json" -d '{"limit":1,"with_payload":true}'` | Points have `content` field |
| All 9 UI views | Visit each /ui/* route | 200, no errors in console |

#### 5G. Quality Gates

```bash
bun run typecheck    # 0 errors
bun run lint         # 0 errors
bun test             # 100% pass
```

#### 5H. Final TODO/FIXME Scan

```bash
grep -rn "TODO\|FIXME\|HACK\|STUB" src/ --include="*.ts" | grep -v __tests__ | grep -v EntityExtractor.ts
# Expected: 0 lines
```

---

## Risk Analysis & Mitigation

### High Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| SafeGit async cascade breaks callers | Build fails, pipeline down | Medium | Phase 1 runs first; `bun run typecheck` catches all callers |
| Qdrant batch size too large with content | 400 errors on re-ingest | Low | Reduced from 500 to 200; content capped at 2KB |
| Neo4j constraint fails on existing data | Constraint creation errors | Low | Wipe data first, then apply constraints; IF NOT EXISTS clause |
| Re-ingestion fails after data wipe | Zero data, no rollback | Medium | Pre-wipe backup via ./scripts/backup.sh |
| Knowledge seeding hits missing server | Script fails | Low | Health check before seeding; --base-url param |

### Low Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Version bump breaks consumers | Import paths change | Very Low | Only package.json version field; no path changes |
| Conformance tests fail with real GraphManager | Test errors | Low | Follow existing mock patterns in the file |
| env-validation tests can't mock process.exit | Test framework limitation | Low | Refactor to throw if needed |

### Deployment Risks

| Risk | Mitigation |
|------|------------|
| Prod deployment with unfixed ingestion pipeline | Phase 5 verifies on Dev (OrbStack) FIRST; Prod requires explicit user approval |
| Docker image stale after code changes | --no-cache build in Phase 5 |
| Neo4j memory exhaustion during re-ingestion | Memory limit 4G in docker-compose.prod.yml; ping-mem repo is small (~33K files) |

---

## Service-Level Impact Analysis

### Component Level

| Component | Issues | Changes | Risk |
|-----------|--------|---------|------|
| ProjectScanner | #18, #20 | async migration, ignore dirs | Medium (API signature change) |
| SafeGit | #20 | add getRemoteUrl() | Low (additive) |
| TemporalCodeGraph | #12, #14 | null validation, constraints, project check | High (data integrity) |
| CodeIndexer | #13 | add content payload, reduce batch | Medium (payload size change) |
| IngestionService | #14 | timeline validation | Low (error handling) |
| KnowledgeStore | #15 | no code changes, data seeding only | Low |
| Admin routes | #19 | logger migration | Low |

### Service Level

| Service | Impact | Verification |
|---------|--------|-------------|
| Neo4j | Constraints added, data wiped, re-ingested | cypher-shell queries for NULL projects = 0 |
| Qdrant | Payload schema change (content added), re-indexed | Points have content field in payload |
| SQLite | No changes | Existing tests pass |
| HTTP/REST | No endpoint changes | Health check passes |
| MCP | No tool signature changes | Existing MCP tests pass |

### Feature Level

| Feature | Status Before | Status After | Verification |
|---------|--------------|-------------|-------------|
| Codebase search | Returns empty content | Returns code snippets (up to 2000 chars) | API returns non-empty content field |
| Timeline queries | Returns empty arrays | Returns commit history | API returns commit data |
| Knowledge search | Empty store, no results | 10+ curated entries | FTS search returns results |
| Web UI | All views render | All views render with real data | Visit all 9 routes |
| Multi-agent memory | Working | Working (unchanged) | Existing tests pass |
| Diagnostics | Working | Working (unchanged) | Existing tests pass |
| Admin panel | Working | Working (logger migrated) | Admin routes respond |

### App Level

| Quality Dimension | Before | After |
|-------------------|--------|-------|
| Data integrity | NULL project nodes in Neo4j, empty Qdrant content | All Project nodes have name/path, content in payload |
| Documentation accuracy | 3 different version numbers, stale roadmap | All 2.0.0, roadmap reflects reality |
| Security | ProjectScanner uses execSync | All git ops via SafeGit (execFile, no shell) |
| Code quality | 5 console.* in prod, 6 TODO stubs | 1 console.* (intentional), 0 TODOs |
| Test coverage | 83 test files, 3 dirs uncovered | 87+ test files, all dirs covered |
| Observability | Structured logging (50 files) | Structured logging (52 files) |

---

## Success Metrics

| Metric | Before | After |
|--------|--------|-------|
| Codebase search content | Empty ("") | Non-empty code snippets |
| Timeline query results | Empty ([]) | Commit history with messages |
| Knowledge entries | 0 | 10+ curated entries |
| Production console.* calls | 5 | 1 (sse-client.ts, intentional) |
| execSync in ProjectScanner | 2 calls | 0 calls |
| TODO/FIXME in src/ (non-test) | 6 stubs | 0 |
| Test files | 83 | 87+ |
| Version consistency | 3 different versions | All 2.0.0 |
| Worktree dirs in ignore list | Not excluded | Excluded |
| GitHub issues open | 10 (#12-#22) | 0 |

---

## Execution Strategy

Each phase maps to one sub-agent. The orchestrator supervises, verifies quality gates after each phase, and ensures no regressions.

| Phase | Agent | Files Modified | Quality Gate |
|-------|-------|---------------|-------------|
| 1 | Foundation Agent | ProjectScanner.ts, SafeGit.ts, admin.ts, cli.ts, .gitignore | typecheck + test |
| 2 | Pipeline Agent | TemporalCodeGraph.ts, CodeIndexer.ts, IngestionService.ts | typecheck + test |
| 3 | Docs+Tests Agent | package.json, CLAUDE.md, conformance.test.ts, 4 new test files | typecheck + test |
| 4 | Knowledge Agent | scripts/seed-knowledge.ts (new) | typecheck |
| 5 | Orchestrator | Docker, curl, verify all flows | Full E2E |

Phases 1 and 3 can run in parallel (different files). Phase 2 depends on Phase 1. Phase 4 depends on Phase 2. Phase 5 depends on all.

---

## References

### Internal

- `src/graph/TemporalCodeGraph.ts:59-76` -- persistIngestion (Bug #12)
- `src/search/CodeIndexer.ts:158-194` -- buildIndexPoints (Bug #13)
- `src/search/CodeIndexer.ts:123-135` -- search result mapping
- `src/ingest/IngestionService.ts:157-200` -- queryTimeline (Bug #14)
- `src/ingest/ProjectScanner.ts:127-156` -- getGitIdentity (execSync)
- `src/ingest/SafeGit.ts:74-77` -- getRoot() method
- `src/graph/__tests__/conformance.test.ts:274-321` -- TODO stubs
- `src/http/admin.ts:590-592` -- console.error calls
- `src/util/logger.ts` -- structured logger

### GitHub Issues

- #12: Neo4j data corruption (NULL Project nodes)
- #13: Qdrant empty content
- #14: Empty timeline
- #15: Knowledge store empty
- #16: Version mismatch
- #17: CLAUDE.md stale roadmap
- #18: Worktree pollution
- #19: Console.* in production
- #20: ProjectScanner execSync
- #21: Conformance test TODOs
- #22: Missing test coverage
