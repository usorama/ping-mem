# Institutional Learnings Search Results for ping-mem Production Issues

## Search Context
- **Feature/Task**: Fix 10 production issues (Neo4j corruption, Qdrant empty content, timeline empty arrays, execSync vs SafeGit, worktree pollution, test coverage, version mismatches, etc.)
- **Keywords Used**: Neo4j, Qdrant, session management, git safety, test patterns, documentation, ingestion pipeline
- **Files Scanned**: 350+ files across docs, learnings, and source code
- **Relevant Matches**: 47 files found with directly applicable learnings

---

## Key Institutional Learnings

### 1. Neo4j Session Management & Data Corruption (CRITICAL)
**Module**: TemporalCodeGraph, Neo4jClient
**Severity**: critical | **Problem Type**: database_issue, resource_leak

**Reference Implementation** (TemporalCodeGraph.ts lines 60-101):
```typescript
async persistIngestion(result: IngestionResult): Promise<void> {
  const session = this.neo4j.getSession();
  try {
    // All persistence operations here
  } finally {
    await session.close();  // ✅ ALWAYS cleanup
  }
}
```

**Root Cause of NULL Nodes**: Session not closed → connection pool exhaustion → orphaned connections → partial writes

**Fix**: Audit all graph classes for missing try-finally:
```bash
grep -rn "getSession()" src/graph --include="*.ts" | grep -v finally
```

**All Neo4j sessions must use this pattern**.

---

### 2. Git Command Safety (execSync vs SafeGit) (CRITICAL)
**Module**: ProjectScanner, GitHistoryReader
**Severity**: critical | **Problem Type**: security_issue

**SafeGit Already Exists** - Use it instead of execSync:
- File: `src/ingest/SafeGit.ts`
- Uses execFile API (no shell)
- Validates commit hashes with regex
- Tests: `src/ingest/__tests__/SafeGit.*.test.ts`

**Migration**: Replace execSync calls with SafeGit methods:
- `execSync("git rev-parse --show-toplevel")` → `await safeGit.getRoot()`
- `execSync("git rev-parse HEAD")` → `await safeGit.getHead()`
- `execSync("git log ...")` → `await safeGit.getLog()`
- `execSync("git show ...")` → `await safeGit.getDiff()`

---

### 3. Project ID Uniqueness (FIXED)
**Module**: ProjectScanner
**Status**: ✅ Fixed in commit f727bfe8 (2026-01-29)

**Bug**: ProjectId from gitRoot + remoteUrl only → collisions in subdirectories
**Fix Applied**: Include normalizedProjectPath in computation

**Verify with**:
```bash
grep -A 5 "getGitIdentity" src/ingest/ProjectScanner.ts | grep "normalizedProjectPath"
```

---

### 4. Qdrant Payload Storage & Empty Content (HIGH)
**Module**: CodeIndexer, DeterministicVectorizer
**Severity**: high | **Problem Type**: database_issue

**Required Payload Fields**:
```typescript
{
  projectId: string,
  filePath: string,
  chunkId: string,
  sha256: string,
  type: "code" | "comment" | "docstring",
  content: string,          // ← THIS IS THE PROBLEM!
  start: number,
  end: number,
  ingestedAt: timestamp
}
```

**Root Cause**: Content computed for vector but NOT stored in payload

**Fix Location**: `src/search/CodeIndexer.ts`
- Verify `indexIngestion()` stores chunk.content in payload
- Verify search retrieves payloads
- Add integration test

---

### 5. Timeline Queries Returning Empty Arrays (HIGH)
**Module**: TemporalCodeGraph, GitHistoryReader
**Severity**: high | **Problem Type**: database_issue

**Root Causes**:
1. No commits ingested → GitHistoryReader not extracting properly
2. Wrong projectId → commits persisted with different ID
3. Session leak → partial persistence (see Lesson #1)
4. Stale manifest → delete `.ping-mem/manifest.json` to force re-ingest

**Fix Sequence**:
1. Verify GitHistoryReader.parseLog() works
2. Check Neo4j: `MATCH (c:Commit) WHERE c.projectId = $id RETURN count(c)`
3. Verify queryCommitHistory() uses correct projectId
4. Ensure try-finally cleanup

---

### 6. Worktree Code Pollution in Search Index (HIGH)
**Module**: ProjectScanner, CodeChunker, CodeIndexer
**Severity**: high | **Problem Type**: logic_error, data_integrity

**Problem**: .worktrees/ files indexed into Neo4j/Qdrant

**Fix**:
1. Add `.worktrees/` to excluded patterns in ProjectScanner
2. Delete `.ping-mem/manifest.json` for re-ingest
3. Add test case for exclusion

---

### 7. Missing Test Coverage (HIGH)
**Severity**: high | **Problem Type**: test_failure, best_practice

**Coverage Gaps**:
- HTTP REST: 1 test file (poor)
- HTTP Admin: 0 test files (missing)
- Ingest Pipeline: 1 test file (poor)

**Reference Pattern** (Neo4jClient.test.ts):
```typescript
describe("Neo4jClient", () => {
  let client: Neo4jClient;

  beforeAll(async () => {
    client = new Neo4jClient(config);
  });

  afterAll(async () => {
    await client.disconnect();
  });

  it("should execute queries", async () => {
    const session = client.getSession();
    try {
      const result = await session.run(query, params);
      expect(result.records).toHaveLength(expected);
    } finally {
      await session.close();
    }
  });
});
```

---

### 8. Version Mismatches in Documentation (MEDIUM)
**Severity**: medium | **Problem Type**: documentation_gap

**Issues**:
- package.json: "1.0.0"
- CLAUDE.md: "v2.0.0"
- Docs: "v1.3.0", "v1.4.0"

**Fix**: Single source of truth - package.json is authoritative

---

## Action Items by Priority

### 🔴 P0 Critical
1. Audit Neo4j session leaks (grep command provided)
2. Migrate ProjectScanner to SafeGit
3. Verify Qdrant payloads include content
4. Confirm ProjectId fix applied

### 🟡 P1 High
1. Debug timeline query root cause
2. Add .worktrees exclusion
3. Improve test coverage

### 🟠 P2 Medium
1. Synchronize versions
2. Auto-generate docs from code

---

## References

**Bug Fixes**: `/Users/umasankr/Projects/ping-mem/docs/BUG_FIXES_2026-01-29.md`
**Verification**: `/Users/umasankr/Projects/ping-mem/docs/VERIFICATION_2026-01-29.md`
**Implementation**: `/Users/umasankr/Projects/ping-mem/docs/IMPLEMENTATION_SUMMARY.md`

---

**Report Generated**: 2026-03-08 | **Status**: Complete
