# Universal Memory Layer: Multi-Project + Multi-Domain Support

**Date**: 2026-02-01
**Version**: 1.0.0
**Status**: Design Complete, Ready for Implementation

---

## What We're Building

**ping-mem as a Universal Memory Service** - a single memory layer that serves ALL types of projects and domains, not just software development.

### Current State (v1.4.0)
- ✅ Architecture supports multi-project (projectId isolation in Neo4j/Qdrant)
- ✅ Code ingestion works correctly for multiple projects
- ❌ Documentation doesn't emphasize multi-project workflows
- ❌ Missing tools to discover/manage ingested projects
- ❌ No session-scoped "active project" concept

### Vision (Universal Memory)
ping-mem serves:
1. **Software Development** (current focus):
   - Code ingestion with git history
   - Diagnostics tracking across tools
   - Worklog events for CI/CD

2. **Personal Finance** (future):
   - Transaction ingestion from bank APIs
   - Budget tracking per account
   - Spending pattern analysis

3. **Research & Notes** (future):
   - Paper/article ingestion
   - Cross-reference tracking
   - Citation graphs

4. **Any Domain** (future):
   - Domain-specific ingestion modules
   - Shared memory core (context_save, context_search)
   - Session isolation across domains

---

## Why This Approach

### Design Principle: Domain-Agnostic Core + Pluggable Domains

**Core Memory Layer** (universal):
```
context_save()     → Store ANY data with metadata
context_get()      → Retrieve by key/filter
context_search()   → Semantic search across ALL data
context_session_*  → Isolate sessions/projects
```

**Domain Extensions** (pluggable):
```
codebase_*        → Software development domain
diagnostics_*     → Code quality domain
worklog_*         → Event tracking domain
finance_*         → (Future) Personal finance domain
research_*        → (Future) Research notes domain
```

### Why Code First?
Software development is the **hardest domain**:
- Complex data model (files, chunks, commits, symbols)
- Temporal requirements (git history, "what changed when?")
- Deterministic verification (tests, type checks, lints)

If ping-mem works for code, it works for ANY domain.

---

## Key Decisions

### Decision 1: Multi-Project via projectId (Not Separate Instances)

**Architecture**: One ping-mem instance serves multiple projects via `projectId` isolation

**Rationale**:
- Serena MCP proves this model works
- Simplifies deployment (one server, not N)
- Enables cross-project queries when useful
- Neo4j/Qdrant already filter by projectId

**Trade-off**: Requires explicit projectId in queries (vs implicit "current project")

**Mitigation**: Add session-scoped `activeProjectId` for convenience

---

### Decision 2: Session-Scoped Active Project (Implicit Default)

**Design**: `context_session_start` sets `activeProjectId`, tools auto-populate if not provided

**Example**:
```typescript
// Session start
context_session_start({
  projectDir: "/Users/umasankr/Projects/sn-assist",
  autoIngest: true
})
// → Sets session.activeProjectId = "abc123..."

// Later query (projectId optional)
codebase_search({query: "auth"})
// → Uses session.activeProjectId implicitly
```

**Rationale**:
- Reduces cognitive load for agents
- Matches "current working directory" mental model
- Explicit projectId still allowed (overrides session default)

**Trade-off**: Adds implicit state (less explicit than always passing projectId)

**Mitigation**: Log warning if both projectId and activeProjectId are missing

---

### Decision 3: New MCP Tools for Project Discovery

**Tools to Add**:

1. **`codebase_list_projects`**
   - Lists all ingested projects
   - Returns: `[{projectId, rootPath, lastIngestedAt, filesCount}]`
   - Use case: "What projects do I have indexed?"

2. **`codebase_get_project_info`**
   - Get metadata for specific projectId
   - Returns: `{projectId, rootPath, treeHash, filesCount, chunksCount, commitsCount}`
   - Use case: "How many files in sn-assist?"

**Rationale**: Agents currently have no way to discover ingested projects

---

### Decision 4: Documentation First, Then Code

**Priority**:
1. **P0**: Update agent workflow docs (immediate fix for agent confusion)
2. **P1**: Add new MCP tools (enable discovery)
3. **P2**: Implement session activeProjectId (convenience)

**Rationale**: Documentation prevents future mistakes, code enables new workflows

---

## Open Questions

### Q1: Should we support cross-domain queries?

**Scenario**: Search for "authentication" across code AND research notes?

**Options**:
- **Option A**: Separate search tools per domain (`codebase_search`, `research_search`)
- **Option B**: Universal `context_search` that queries all domains
- **Option C**: Both (domain-specific + universal)

**Decision**: Start with Option A (domain-specific), add Option B when multiple domains exist

---

### Q2: How to handle projectId collisions across domains?

**Scenario**: Code project "finances" vs personal finance project "finances"

**Current Design**: projectId = sha256(gitRoot + remoteUrl + path)
- Only works for git repos
- Personal finance may not be git-based

**Solution**: Add domain prefix to projectId?
```
projectId = sha256(domain + gitIdentity)
// code:abc123...
// finance:def456...
```

**Decision**: Defer until we add non-code domains (not urgent for v1.5.0)

---

### Q3: Should we add `context_switch_project(projectId)`?

**Alternative to**: Manually calling `codebase_search({projectId: "..."})`

**Example**:
```typescript
context_switch_project({projectId: "abc123"})
// → Updates session.activeProjectId
// All subsequent codebase queries use new projectId
```

**Decision**: Not needed if we implement Decision 2 (session activeProjectId)

---

## Implementation Plan

### Phase 1: Documentation (P0 - Immediate)
**Timeline**: 1 hour

**Tasks**:
- [x] Task #1: Update `~/.claude/ping-mem-agent-workflow.md`
  - Add "Multi-Project Workflow" section
  - Show how to capture projectId from ingestion
  - Examples of querying multiple projects

- [x] Task #5: Update `CLAUDE.md`
  - Add "Multi-Project Usage Patterns" section
  - Update MCP tools table with new tools
  - Add "Universal Memory Vision" section

- [x] Task #6: Update `README.md`
  - Add "Multi-Project Scenarios" section
  - Update integration examples to show projectId usage

**Success Criteria**: Future agents know to capture and use projectId

---

### Phase 2: Project Discovery Tools (P1 - Next PR)
**Timeline**: 2-3 hours

**Tasks**:
- [x] Task #2: Implement `codebase_list_projects`
  - Add MCP tool schema
  - Add handler in PingMemServer.ts
  - Query Neo4j for all Project nodes
  - Tests: Verify multi-project listing

- [x] Task #3: Implement `codebase_get_project_info`
  - Add MCP tool schema
  - Add handler + Neo4j query
  - Return full project metadata
  - Tests: Verify counts are accurate

**Success Criteria**:
- Agents can list all ingested projects
- Agents can query project metadata (filesCount, etc.)

---

### Phase 3: Session Active Project (P2 - Nice-to-Have)
**Timeline**: 2-3 hours

**Tasks**:
- [x] Task #4: Implement session-scoped activeProjectId
  - Update SessionConfig with activeProjectId field
  - Auto-set in context_session_start after ingestion
  - Auto-populate in codebase_search/timeline if projectId not provided
  - Tests: Verify implicit projectId resolution

**Success Criteria**:
- Agents don't need to pass projectId on every query
- Explicit projectId still works (overrides session default)

---

## Success Metrics

### Agent Usability
- ✅ Agent can discover ingested projects via `codebase_list_projects`
- ✅ Agent captures projectId from ingestion response
- ✅ Agent uses projectId in subsequent queries (or relies on session default)
- ✅ Agent can search across all projects (omit projectId filter)

### Multi-Domain Readiness
- ✅ Core memory layer (context_*) is domain-agnostic
- ✅ Domain extensions (codebase_*, diagnostics_*) are isolated
- ✅ Future domains can add their own tools without changing core

### Documentation Quality
- ✅ Agent workflow docs show multi-project examples
- ✅ CLAUDE.md explains universal memory vision
- ✅ README.md has multi-project scenarios

---

## Future Enhancements (Post-v1.5.0)

### Multi-Domain Support
1. **Finance Domain**:
   - `finance_ingest_transactions` (from bank API or CSV)
   - `finance_search_spending` (semantic search on categories)
   - `finance_budget_status` (current vs planned spending)

2. **Research Domain**:
   - `research_ingest_paper` (PDF parsing, citation extraction)
   - `research_search_citations` (citation graph queries)
   - `research_timeline` (paper publication dates)

3. **Universal Search**:
   - `context_search_all_domains` (query code + finance + research)
   - Domain-specific ranking (code snippets vs transactions vs papers)

### Cross-Domain Insights
- "What was I working on when I made this financial decision?"
- "Which code commits relate to this research paper?"
- Link worklog events to financial transactions (e.g., consulting hours → invoices)

---

## Appendix: Current Architecture Validation

### ✅ Multi-Project Support Already Exists

**Evidence from code**:

1. **ProjectId Generation** (ProjectScanner.ts:119-149):
   ```typescript
   projectId = sha256(gitRoot + remoteUrl + normalizedProjectPath)
   ```
   - Deterministic
   - Unique per project
   - Content-addressable

2. **Neo4j Isolation** (TemporalCodeGraph.ts):
   ```cypher
   MATCH (p:Project { projectId: $projectId })-[:HAS_FILE]->(f:File)
   ```
   - Every query filters by projectId
   - No cross-project data leakage

3. **Qdrant Isolation** (CodeIndexer.ts:83-87):
   ```typescript
   if (options.projectId) {
     mustConditions.push({
       key: "projectId",
       match: { value: options.projectId }
     });
   }
   ```
   - Filters by projectId in payload
   - Can search single project or all projects

4. **MCP Tools Support projectId** (PingMemServer.ts:2115-2116):
   ```typescript
   if (args.projectId !== undefined) {
     options.projectId = args.projectId as string;
   }
   ```
   - Optional parameter in codebase_search
   - If omitted, searches all projects

### ❌ What's Missing

1. **Documentation**: Examples don't show projectId capture/usage
2. **Discovery**: No way to list ingested projects
3. **Convenience**: Manual projectId passing on every query
4. **Agent Workflow**: No guidance on multi-project sessions

---

**Next Steps**: Proceed to implementation (see Phase 1-3 above)
