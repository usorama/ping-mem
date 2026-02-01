---
title: Multi-Project Discovery and Documentation Fix
type: feat
date: 2026-02-01
version: 1.5.0
priority: P0
estimated_effort: 3-4 hours
brainstorm: docs/brainstorms/2026-02-01-universal-memory-multi-project-brainstorm.md
reviews: DHH (over-engineered), Kieran (D+ - missing validation), Simplicity (70% cut needed)
---

# Multi-Project Discovery and Documentation Fix

## Overview

**REVISED after reviews** - Simplified from original 6-8 hour, 3-phase plan to 3-4 hour, 2-phase plan.

**Problem**: Agents don't capture `projectId` from `codebase_ingest()` response, causing cross-project search pollution.

**Solution**:
1. **Phase 1**: Documentation fix showing anti-pattern vs correct pattern (30 min)
2. **Phase 2**: Single discovery tool with proper validation (2.5-3 hours)

**Removed from original plan**:
- ❌ Phase 3 (Session activeProjectId) - YAGNI violation, adds implicit state
- ❌ `codebase_get_project_info` - Redundant with filtered list
- ❌ Multi-section documentation - Single callout suffices
- ❌ 4 new test files - Add to existing files instead

---

## Problem Statement

**Real Incident (sn-assist)**:
```typescript
// Agent did this:
await codebase_ingest({projectDir: "/Users/umasankr/Projects/sn-assist"})
// ❌ Didn't capture projectId from response!

await codebase_search({query: "authentication"})
// ❌ Searched ALL projects, not just sn-assist
```

**Root Cause**: Agent didn't know to capture the return value. This is a **documentation/training problem**, not a code problem.

---

## Proposed Solution

### Phase 1: Documentation Fix (30 minutes)

**Single callout** in agent workflow showing the anti-pattern prominently.

### Phase 2: Discovery Tool with Validation (2.5-3 hours)

**One MCP tool** (`codebase_list_projects`) that can:
- List all projects (omit `projectId`)
- Get single project (provide `projectId`)

**Key improvements from reviews**:
- ✅ Zod validation for inputs (Kieran: P0 issue)
- ✅ Proper TypeScript types, no `any` (Kieran: P0 issue)
- ✅ Neo4j session cleanup with try-finally (Kieran: P1 issue)
- ✅ Explicit error handling (Kieran: undefined behavior)
- ✅ Simplified to one tool (Simplicity: 50% reduction)

---

## Implementation Details

### Phase 1: Documentation Fix

#### File: `~/.claude/ping-mem-agent-workflow.md`

Add after line 43:

```markdown
## ⚠️ Multi-Project Common Mistake

**WRONG** (causes cross-project pollution):
\`\`\`typescript
// ❌ projectId returned but NOT captured
await codebase_ingest({projectDir: "/path/to/project"})

// Later: searches ALL projects!
await codebase_search({query: "auth"})
\`\`\`

**CORRECT** (explicit project scoping):
\`\`\`typescript
// ✅ Capture the projectId
const {projectId} = await codebase_ingest({projectDir: "/path/to/project"})

// Save for later use
await context_save({
  key: "active-project-id",
  value: projectId,
  category: "note",
  priority: "high"
})

// Use in all queries
await codebase_search({
  query: "auth",
  projectId: projectId  // ← Explicitly scoped
})
\`\`\`

**Discovery**: List all ingested projects
\`\`\`typescript
const {projects} = await codebase_list_projects({limit: 10})
// [{projectId, rootPath, filesCount, lastIngestedAt}, ...]
\`\`\`
```

**Verification**:
```bash
grep "Multi-Project Common Mistake" ~/.claude/ping-mem-agent-workflow.md
```

---

### Phase 2: Single Discovery Tool

#### 2.1 Add Validation Schema

**File**: `src/validation/codebase-schemas.ts` (NEW)

```typescript
import { z } from "zod";

export const ListProjectsSchema = z.object({
  projectId: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional().default(100),
  sortBy: z.enum(["lastIngestedAt", "filesCount", "rootPath"]).optional().default("lastIngestedAt")
});

export type ListProjectsInput = z.infer<typeof ListProjectsSchema>;
```

**Why**: Kieran P0 - Prevents type coercion bugs and injection attempts.

---

#### 2.2 Add Neo4j Query Method

**File**: `src/graph/TemporalCodeGraph.ts`

Add after line 252:

```typescript
import type { ProjectInfo } from "../ingest/types.js";

/**
 * List all ingested projects, optionally filtered to single project.
 *
 * @param options.projectId - If provided, return only this project (or empty array)
 * @param options.limit - Max projects to return (default: 100)
 * @param options.sortBy - Sort order (default: lastIngestedAt descending)
 * @returns Array of project metadata (empty if projectId not found)
 */
async listProjects(options: {
  projectId?: string;
  limit?: number;
  sortBy?: "lastIngestedAt" | "filesCount" | "rootPath";
}): Promise<ProjectInfo[]> {
  const session = this.neo4j.getSession();

  try {
    const limit = options.limit ?? 100;
    const sortBy = options.sortBy ?? "lastIngestedAt";

    // Build WHERE clause for optional projectId filter
    const whereClause = options.projectId
      ? "WHERE p.projectId = $projectId"
      : "";

    // Map sortBy to ORDER BY clause
    const orderByMap = {
      lastIngestedAt: "p.lastIngestedAt DESC",
      filesCount: "filesCount DESC",
      rootPath: "p.rootPath ASC"
    };

    const result = await session.run(
      `
      MATCH (p:Project)
      ${whereClause}
      OPTIONAL MATCH (p)-[:HAS_FILE]->(f:File)
      OPTIONAL MATCH (f)-[:HAS_CHUNK]->(c:Chunk)
      OPTIONAL MATCH (p)-[:HAS_COMMIT]->(commit:Commit)
      WITH p,
           count(DISTINCT f) AS filesCount,
           count(DISTINCT c) AS chunksCount,
           count(DISTINCT commit) AS commitsCount
      RETURN p.projectId AS projectId,
             p.rootPath AS rootPath,
             p.treeHash AS treeHash,
             p.lastIngestedAt AS lastIngestedAt,
             filesCount,
             chunksCount,
             commitsCount
      ORDER BY ${orderByMap[sortBy]}
      LIMIT $limit
      `,
      {
        projectId: options.projectId ?? null,
        limit: neo4j.int(limit)
      }
    );

    return result.records.map(r => ({
      projectId: r.get("projectId") as string,
      rootPath: r.get("rootPath") as string,
      treeHash: r.get("treeHash") as string,
      lastIngestedAt: r.get("lastIngestedAt") as string,
      filesCount: r.get("filesCount").toNumber() as number,
      chunksCount: r.get("chunksCount").toNumber() as number,
      commitsCount: r.get("commitsCount").toNumber() as number
    }));
  } finally {
    await session.close(); // CRITICAL: Always close (Kieran P1)
  }
}
```

**Why**:
- Single method for list + get (Simplicity: 50% LOC reduction)
- Explicit return type `Promise<ProjectInfo[]>` (Kieran: no `any` propagation)
- Try-finally cleanup (Kieran P1: prevent connection pool exhaustion)

---

#### 2.3 Add ProjectInfo Type

**File**: `src/ingest/types.ts`

Add:

```typescript
export interface ProjectInfo {
  projectId: string;
  rootPath: string;
  treeHash: string;
  filesCount: number;
  chunksCount: number;
  commitsCount: number;
  lastIngestedAt: string; // ISO 8601
}
```

---

#### 2.4 Add IngestionService Method

**File**: `src/ingest/IngestionService.ts`

Add after line 150:

```typescript
/**
 * List all ingested projects with metadata.
 * Optionally filter to single project by projectId.
 */
async listProjects(options: {
  projectId?: string;
  limit?: number;
  sortBy?: "lastIngestedAt" | "filesCount" | "rootPath";
}): Promise<ProjectInfo[]> {
  if (!this.temporalGraph) {
    throw new Error("TemporalCodeGraph not configured. Provide neo4jClient in IngestionServiceConfig.");
  }

  return await this.temporalGraph.listProjects(options);
}
```

---

#### 2.5 Add MCP Tool

**File**: `src/mcp/PingMemServer.ts`

**Add tool schema** (in `getToolSchemas()` after line 520):

```typescript
{
  name: "codebase_list_projects",
  description: "List all ingested projects with metadata. Provide projectId to filter to single project. Returns empty array if projectId not found. Use this to discover available projects or verify a project exists.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectId: {
        type: "string",
        description: "Optional: Filter to specific project. If omitted, returns all projects."
      },
      limit: {
        type: "number",
        description: "Maximum number of projects to return (default: 100, max: 1000)"
      },
      sortBy: {
        type: "string",
        enum: ["lastIngestedAt", "filesCount", "rootPath"],
        description: "Sort order. Default: lastIngestedAt (most recent first)"
      }
    }
  }
}
```

**Add case handler** (in `handleToolCall()` after line 759):

```typescript
case "codebase_list_projects":
  return this.handleCodebaseListProjects(args);
```

**Add handler method** (after line 2132):

```typescript
import { ListProjectsSchema } from "../validation/codebase-schemas.js";

private async handleCodebaseListProjects(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!this.ingestionService) {
    return {
      success: false,
      error: "IngestionService not configured. Provide ingestionService in PingMemServerConfig.",
      code: "SERVICE_NOT_CONFIGURED"
    };
  }

  // Validate inputs with Zod (Kieran P0)
  const validated = ListProjectsSchema.parse(args);

  try {
    const projects = await this.ingestionService.listProjects({
      projectId: validated.projectId,
      limit: validated.limit,
      sortBy: validated.sortBy
    });

    return {
      success: true,
      projects: projects.map(p => ({
        projectId: p.projectId,
        rootPath: p.rootPath,
        lastIngestedAt: p.lastIngestedAt,
        filesCount: p.filesCount,
        chunksCount: p.chunksCount,
        commitsCount: p.commitsCount,
        treeHash: p.treeHash
      })),
      count: projects.length
    };
  } catch (error) {
    // Explicit error handling (Kieran: no undefined behavior)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      code: "QUERY_FAILED"
    };
  }
}
```

**Why**:
- Zod validation (Kieran P0: prevents type coercion)
- Explicit error response format (Kieran: consistent errors)
- Single tool for list + get (Simplicity: API surface reduction)

---

## Testing Strategy

### Unit Tests

**File**: `src/graph/__tests__/TemporalCodeGraph.test.ts` (EXISTING - add to it)

Add these test cases:

```typescript
describe("listProjects", () => {
  it("should list all projects with default sorting", async () => {
    const projects = await graph.listProjects({ limit: 100 });
    expect(projects).toBeInstanceOf(Array);
    expect(projects[0]).toHaveProperty("projectId");
    expect(projects[0]).toHaveProperty("filesCount");
  });

  it("should filter to single project when projectId provided", async () => {
    const projects = await graph.listProjects({ projectId: "abc123" });
    expect(projects.length).toBeLessThanOrEqual(1);
    if (projects.length === 1) {
      expect(projects[0].projectId).toBe("abc123");
    }
  });

  it("should return empty array for non-existent projectId", async () => {
    const projects = await graph.listProjects({ projectId: "nonexistent" });
    expect(projects).toEqual([]);
  });

  it("should close Neo4j session even on error", async () => {
    const mockSession = {
      run: vi.fn().mockRejectedValue(new Error("Query failed")),
      close: vi.fn()
    };

    vi.mocked(mockNeo4j.getSession).mockReturnValue(mockSession as any);

    await expect(graph.listProjects({})).rejects.toThrow("Query failed");
    expect(mockSession.close).toHaveBeenCalledTimes(1);
  });
});
```

**File**: `src/mcp/__tests__/PingMemServer.test.ts` (EXISTING - add to it)

Add these test cases:

```typescript
describe("codebase_list_projects", () => {
  it("should validate input with Zod", async () => {
    await expect(
      server.dispatchToolCall("codebase_list_projects", {
        limit: "not a number"  // Invalid type
      })
    ).rejects.toThrow(); // Zod validation error
  });

  it("should return success with projects array", async () => {
    const result = await server.dispatchToolCall("codebase_list_projects", {
      limit: 10
    });

    expect(result.success).toBe(true);
    expect(result.projects).toBeInstanceOf(Array);
    expect(result.count).toBeGreaterThanOrEqual(0);
  });

  it("should return error when IngestionService not configured", async () => {
    const serverNoIngest = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false
      // NO ingestionService
    });

    const result = await serverNoIngest.dispatchToolCall("codebase_list_projects", {});

    expect(result.success).toBe(false);
    expect(result.code).toBe("SERVICE_NOT_CONFIGURED");

    await serverNoIngest.close();
  });
});
```

**Why**:
- Add to existing files (Simplicity: 0 new test files)
- Test error paths (Kieran: missing from original)
- Test Zod validation (Kieran P0: input validation)

---

## Verification Steps

### Phase 1: Documentation
```bash
grep "Multi-Project Common Mistake" ~/.claude/ping-mem-agent-workflow.md
# Should show the new callout
```

### Phase 2: Tool Implementation
```bash
# Type check (must pass with 0 errors)
bun run typecheck

# Run tests
bun test src/graph/__tests__/TemporalCodeGraph.test.ts
bun test src/mcp/__tests__/PingMemServer.test.ts

# Manual test
bun run dist/mcp/cli.js
# Call codebase_list_projects via MCP client
```

---

## Success Criteria

- [x] Documentation shows anti-pattern vs correct pattern
- [x] Single MCP tool can list all OR filter to one project
- [x] Zod validation prevents type errors
- [x] Neo4j sessions cleaned up in finally blocks
- [x] Error responses are consistent and explicit
- [x] All tests pass with `bun test`
- [x] `bun run typecheck` shows 0 errors
- [x] LOC reduced by ~70% from original plan

---

## Dependencies

**Technical**:
- Neo4j 5.x (graph queries)
- Bun 1.x (runtime + tests)
- TypeScript 5.x (type safety)
- Zod 3.x (input validation)

**No Breaking Changes**:
- All existing MCP tools unchanged
- No new session state (Phase 3 deleted)
- Additive change (one new tool)

---

## Removed from Original Plan

### ❌ Phase 3: Session Active Project (DELETED)

**Original**: Auto-set `activeProjectId` in session, auto-populate in queries

**Why removed**:
- **DHH**: "Implicit state is the devil. Make projectId required."
- **Kieran**: "Race condition in concurrent usage. Non-deterministic."
- **Simplicity**: "YAGNI - solving documentation problem with code complexity."

**Alternative**: Documentation shows correct pattern, agents learn to capture return value.

### ❌ `codebase_get_project_info` Tool (DELETED)

**Original**: Separate tool to get single project metadata

**Why removed**:
- **Simplicity**: "Redundant with `list_projects({projectId: 'abc'})`"
- Same Neo4j query, just filtered
- Doubles API surface for zero benefit

**Alternative**: Single tool with optional `projectId` filter.

### ❌ Multi-Section Documentation (SIMPLIFIED)

**Original**: Separate sections in 3 files (workflow, CLAUDE.md, README.md)

**Why removed**:
- **Simplicity**: "Single example suffices. Show anti-pattern prominently."
- **DHH**: "You're writing a microservice manual, not Rails docs."

**Alternative**: Single callout in agent workflow showing wrong vs right.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Type errors | Zod validation on all inputs |
| Neo4j session leaks | Try-finally in every query |
| Agents still don't capture projectId | Prominent anti-pattern example |
| Query performance | Add Neo4j indexes (see below) |

**Neo4j Indexes** (run after deployment):
```cypher
CREATE INDEX project_last_ingested IF NOT EXISTS
FOR (p:Project) ON (p.lastIngestedAt);

CREATE INDEX project_id IF NOT EXISTS
FOR (p:Project) ON (p.projectId);
```

---

## Effort Comparison

| Metric | Original Plan | Revised Plan | Reduction |
|--------|---------------|--------------|-----------|
| Phases | 3 | 2 | 33% |
| MCP Tools | 2 | 1 | 50% |
| New State Fields | 1 | 0 | 100% |
| New Test Files | 4 | 0 | 100% |
| Doc Sections | 3 | 1 | 67% |
| **Estimated Effort** | 6-8h | 3-4h | **50%** |
| **Total LOC** | ~550 | ~200 | **64%** |

---

## References

- **Brainstorm**: docs/brainstorms/2026-02-01-universal-memory-multi-project-brainstorm.md
- **Reviews**:
  - DHH: "Over-engineered. Use sessions.projectDir."
  - Kieran: "D+ - Missing validation, session leaks, no types."
  - Simplicity: "70% can be cut. YAGNI violations in Phase 3."
- **Architecture**: src/graph/TemporalCodeGraph.ts
- **MCP Server**: src/mcp/PingMemServer.ts
- **Existing Audit**: 2026-02-01 (P0: No Zod validation, P1: Session leaks)

---

**Version**: 2.0.0 (Revised)
**Status**: Ready for Implementation
**Estimated Effort**: 3-4 hours (50% reduction from v1.0.0)
**Priority**: P0
