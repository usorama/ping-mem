# ping-mem Agent Instructions

**Universal Memory Layer for AI Agents**

> **Canonical Reference**: [`docs/AGENT_INTEGRATION_GUIDE.md`](docs/AGENT_INTEGRATION_GUIDE.md)
>
> This file is a quick-start summary. For the complete guide including REST API reference,
> all 30+ MCP tools, Docker integration, performance tuning, and troubleshooting,
> see the canonical guide above.

This document is quarantined during the 2026-04-29 local trust rebuild.
It is not an approved agent onboarding path and must not be used to configure
Claude Code, Codex, Cursor, OpenCode, or other agents until S015 explicitly
re-adopts an integration.

---

## Core Principle

Use direct repo evidence first: files, `rg`, tests, runtime output, and the
approved REST-only CLI proof commands. ping-mem MCP tools and codebase
grounding remain untrusted until their local proof slices pass.

---

## Mandatory Workflow

### Phase 1: Approved Status Proof

On every new session or conversation:

```bash
bun run src/cli/index.ts agent status --json
bun run src/cli/index.ts agent proof memory-lifecycle --agent codex-local --project /path/to/project --json
```

### Phase 2: Code Understanding

For ANY question about code, structure, or implementation before S007/S008 pass:

```
# DO THIS:
rg "exact pattern" .
sed -n '1,160p' path/to/file
bun test <targeted-tests>

# DO NOT:
- use codebase_ingest/codebase_verify/codebase_search as grounding proof
- rely on MCP output for acceptance
- edit user-level agent configs before S015
```

### Phase 3: History Understanding

For ANY question about "why", "when", or "who":

```
# DO THIS:
codebase_timeline({
  projectId: "...",
  filePath: "optional/file/path",
  limit: 50
})

# DO NOT:
- git log
- git blame
- git show
```

### Phase 4: Decision Recording

When making architectural, design, or implementation decisions:

```
context_save({
  key: "unique-decision-key",
  value: "Description of decision and reasoning",
  category: "decision",  // or "task", "progress", "note"
  priority: "high",      // or "normal", "low"
  extractEntities: true  // ALWAYS true for decisions
})
```

### Phase 5: Diagnostics Tracking

After running linters, type checkers, or tests:

```
diagnostics_ingest({
  projectId: "...",
  treeHash: "...",
  toolName: "tsc",
  toolVersion: "5.3.3",
  configHash: "...",
  sarif: sarifPayload  // SARIF 2.1.0 format
})
```

---

## Tool Reference

### Codebase Tools

| Tool | When to Use |
|------|-------------|
| `codebase_ingest` | First time or when `codebase_verify` returns `valid: false` |
| `codebase_verify` | Start of every session to check if re-ingestion needed |
| `codebase_search` | Finding code, understanding implementation, locating features |
| `codebase_timeline` | Understanding history, why changes were made, who changed what |

### Context Tools

| Tool | When to Use |
|------|-------------|
| `context_session_start` | Start of every new conversation/task |
| `context_session_end` | End of conversation (optional) |
| `context_save` | Recording decisions, progress, notes |
| `context_get` | Retrieving specific saved context |
| `context_search` | Finding relevant past context |
| `context_checkpoint` | Creating restore points |

### Diagnostics Tools

| Tool | When to Use |
|------|-------------|
| `diagnostics_ingest` | After running linters/type checkers |
| `diagnostics_latest` | Checking current diagnostic state |
| `diagnostics_list` | Listing all findings for an analysis |
| `diagnostics_diff` | Comparing before/after a change |

### Worklog Tools

| Tool | When to Use |
|------|-------------|
| `worklog_record` | Recording tool runs, git operations, task phases |
| `worklog_list` | Reviewing session activity |

---

## Anti-Patterns (NEVER DO)

1. **grep/ripgrep for code search**
   - Wrong: `rg "function authenticate"`
   - Right: `codebase_search({ query: "authentication function" })`

2. **git log for history**
   - Wrong: `git log --oneline src/auth.ts`
   - Right: `codebase_timeline({ projectId: "...", filePath: "src/auth.ts" })`

3. **Unrecorded decisions**
   - Wrong: Making architectural decisions without saving them
   - Right: Always `context_save` with `category: "decision"`

4. **Skipping verification**
   - Wrong: Starting work without `codebase_verify`
   - Right: Always verify manifest is current before searching

---

## Environment Configuration

### Required Environment Variables

```bash
# Neo4j (temporal graph)
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password

# Qdrant (vector search)
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION_NAME=ping-mem-vectors
QDRANT_VECTOR_DIMENSIONS=768

# SQLite (memory storage)
PING_MEM_DB_PATH=/path/to/ping-mem.db
```

### MCP Configuration (Claude Code)

Do not add ping-mem to `~/.claude/mcp.json` from this document. MCP
configuration is blocked until S015/S016.

```json
{
  "status": "blocked until S015 re-adoption proof"
}
```

### HTTP Configuration (Cursor, OpenCode, etc.)

Start ping-mem HTTP server:
```bash
docker compose up -d
# Or
bun run start
```

Use REST API:
```bash
curl http://localhost:3003/api/v1/codebase/search?query=authentication
```

---

## Verification Checklist

Before starting any task, verify:

- [ ] `context_session_start` called
- [ ] `codebase_verify` returned `valid: true` (or `codebase_ingest` completed)
- [ ] Using `codebase_search` for code questions (not grep)
- [ ] Using `codebase_timeline` for history questions (not git log)
- [ ] Recording decisions with `context_save`

---

## Example Session

```typescript
// 1. Start session
await pingMem.callTool("context_session_start", {
  name: "implement-oauth",
  projectDir: "/Users/me/myproject"
});

// 2. Verify/ingest
const verify = await pingMem.callTool("codebase_verify", {
  projectDir: "/Users/me/myproject"
});
if (!verify.valid) {
  await pingMem.callTool("codebase_ingest", {
    projectDir: "/Users/me/myproject"
  });
}

// 3. Search for relevant code
const authCode = await pingMem.callTool("codebase_search", {
  query: "authentication middleware express",
  type: "code",
  limit: 10
});

// 4. Understand history
const authHistory = await pingMem.callTool("codebase_timeline", {
  projectId: verify.projectId,
  filePath: "src/middleware/auth.ts"
});

// 5. Record decision
await pingMem.callTool("context_save", {
  key: "oauth-provider-choice",
  value: "Using Auth0 for OAuth because of existing enterprise SSO integration",
  category: "decision",
  priority: "high",
  extractEntities: true
});

// 6. After making changes, run diagnostics
await pingMem.callTool("diagnostics_ingest", {
  projectId: verify.projectId,
  treeHash: newTreeHash,
  toolName: "tsc",
  toolVersion: "5.3.3",
  configHash: configHash,
  sarif: tscSarifOutput
});
```

---

## Related Documentation

- `CLAUDE.md` - Comprehensive project documentation
- `.cursorrules` - Cursor IDE specific rules
- `docs/AGENT_WORKFLOW.md` - Detailed workflow patterns
- `src/client/README.md` - Client SDK documentation
