# Serena MCP Integration for ping-mem

**Version**: 1.0.0
**Last Updated**: 2026-02-01
**Status**: Active

---

## Overview

Serena is an AI-powered coding assistant that provides semantic code navigation, symbol search, and intelligent editing capabilities through MCP (Model Context Protocol). This document outlines how to use Serena **deterministically** with local codebase verification.

## What is Serena?

Serena provides:
- **Semantic Code Search**: Find symbols, references, and definitions across the codebase
- **LSP Integration**: Language Server Protocol support for TypeScript, Python, and more
- **Project Memory**: Store and recall project-specific context
- **Smart Editing**: Symbol-aware code modifications

**Key Resources**:
- [Serena Documentation](https://oraios.github.io/serena/)
- [GitHub Repository](https://github.com/oraios/serena)
- [MCP Server Guide](https://oraios.github.io/serena/02-usage/030_clients.html)
- [Configuration Reference](https://oraios.github.io/serena/02-usage/050_configuration.html)

---

## Installation Status

### Configured Projects

| Project | Path | Status | Languages | Indexed Files |
|---------|------|--------|-----------|---------------|
| **ping-mem** | `/Users/umasankr/Projects/ping-mem` | ✅ Active | TypeScript, Python | 108 |
| **livekit-tutor** | `/Users/umasankr/Projects/livekit-gemini-voice-tutor-prototype` | ✅ Active | TypeScript | 279 |

### MCP Server Configuration

Located in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "serena": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/oraios/serena",
        "serena",
        "start-mcp-server",
        "--project",
        "."
      ]
    }
  }
}
```

**Note**: Serena MCP server is configured but requires **Claude Code restart** to activate tools.

---

## Deterministic Usage Protocol

### 1. Verification Workflow

**ALWAYS follow this pattern when using Serena**:

```
┌─────────────────────────────────────────────────────────────┐
│  SERENA VERIFICATION PROTOCOL                               │
│                                                             │
│  Step 1: Query Serena (semantic search)                    │
│          ↓                                                  │
│  Step 2: Verify with Local Tools (Grep/Glob/Read)          │
│          ↓                                                  │
│  Step 3: Cross-check Results                               │
│          ↓                                                  │
│  Step 4: Document Discrepancies                            │
└─────────────────────────────────────────────────────────────┘
```

### 2. Example: Finding Symbol References

**Task**: Find all references to `IngestionService`

**Step 1: Query Serena**
```typescript
// Use Serena MCP tool
serena_find_referencing_symbols({
  file_path: "src/ingest/IngestionService.ts",
  line: 10,
  character: 0,
  symbol_types: ["class"]
})
```

**Step 2: Verify with Grep**
```bash
# Cross-check with local tools
grep -r "IngestionService" src/ --include="*.ts"
```

**Step 3: Compare Results**
- **Serena Found**: 15 references
- **Grep Found**: 17 references
- **Discrepancy**: 2 files (check if in `.gitignore` or `node_modules`)

**Step 4: Document**
```markdown
## Verification Results
- Serena: 15 references (excludes ignored files)
- Grep: 17 references (includes all files)
- Conclusion: ✅ Results match when accounting for ignored paths
```

### 3. Symbol Search Verification

**Serena Query**:
```typescript
serena_find_symbol({
  query: "DiagnosticsStore",
  symbol_types: ["class"],
  local_search: false
})
```

**Local Verification**:
```bash
# Find class definitions
grep -r "class DiagnosticsStore" src/ --include="*.ts"

# Find all references
grep -r "DiagnosticsStore" src/ --include="*.ts" | wc -l
```

**Cross-Check Criteria**:
- ✅ Same file locations
- ✅ Same line numbers
- ✅ Same symbol types
- ⚠️ Different counts (check for ignored paths)

### 4. File Reading Verification

**Serena Query**:
```typescript
serena_read_file({
  file_path: "src/diagnostics/DiagnosticsStore.ts"
})
```

**Local Verification**:
```bash
# Read same file
cat src/diagnostics/DiagnosticsStore.ts | wc -l

# Compare hashes
sha256sum src/diagnostics/DiagnosticsStore.ts
```

**Cross-Check**:
- ✅ Same line count
- ✅ Same file hash
- ✅ Same content

---

## Available Serena Tools (MCP)

### Core Tools

| Tool | Purpose | Local Equivalent |
|------|---------|------------------|
| `serena_find_symbol` | Global symbol search | `grep -r "pattern" src/` |
| `serena_find_referencing_symbols` | Find symbol references | `grep -r "SymbolName" src/` |
| `serena_find_referencing_code_snippets` | Find code using symbol | `grep -A5 -B5 "pattern" src/` |
| `serena_get_symbols_overview` | List file symbols | `grep "^class\\|^function\\|^const" file.ts` |
| `serena_read_file` | Read project file | `cat file.ts` |
| `serena_list_dir` | List directory | `ls -la dir/` |
| `serena_search_for_pattern` | Regex search | `grep -E "pattern" src/` |

### Editing Tools (Use with Caution)

| Tool | Purpose | Verification Required |
|------|---------|----------------------|
| `serena_create_text_file` | Create file | ✅ Check with `ls` |
| `serena_replace_lines` | Replace lines | ✅ Check with `git diff` |
| `serena_insert_at_line` | Insert content | ✅ Check with `git diff` |
| `serena_delete_lines` | Delete lines | ✅ Check with `git diff` |
| `serena_replace_symbol_body` | Replace symbol | ✅ Check with `git diff` |

**IMPORTANT**: Always verify edits with `git diff` and `bun run typecheck` before committing.

### Memory Tools

| Tool | Purpose |
|------|---------|
| `serena_write_memory` | Store project context |
| `serena_read_memory` | Retrieve stored context |
| `serena_list_memories` | List all memories |
| `serena_delete_memory` | Remove memory |

---

## Risk Mitigation

### 1. Symbol Search Risks

**Risk**: Serena might miss symbols in ignored files or incorrectly indexed files

**Mitigation**:
```bash
# Always verify with Grep
grep -r "SymbolName" src/ --include="*.ts" --include="*.py"

# Check .gitignore exclusions
git check-ignore -v src/path/to/file.ts
```

### 2. File Modification Risks

**Risk**: Serena edits might introduce type errors or break tests

**Mitigation**:
```bash
# Before accepting Serena edits:
git diff                # Review changes
bun run typecheck       # Check for type errors
bun test                # Run tests
```

### 3. Stale Index Risks

**Risk**: Serena's LSP cache might be outdated after external edits

**Mitigation**:
```bash
# Restart language server after external changes
serena_restart_language_server()

# Or re-index project
cd ~/Projects/ping-mem
uvx --from git+https://github.com/oraios/serena serena project index .
```

### 4. Configuration Drift Risks

**Risk**: Serena config might diverge from project reality

**Mitigation**:
```bash
# Check current config
cat .serena/project.yml

# Verify languages match project
grep "languages:" .serena/project.yml

# Re-create config if needed
uvx --from git+https://github.com/oraios/serena serena project create --name ping-mem --index --language typescript --language python .
```

---

## Activation Checklist

### Pre-Use Checklist

Before using Serena in a session:

- [ ] Claude Code has been restarted (MCP server loaded)
- [ ] Serena tools appear in tool list (`serena_*` prefix)
- [ ] Project is indexed (`.serena/project.yml` exists)
- [ ] LSP is running (no timeout warnings)

### Post-Query Checklist

After each Serena query:

- [ ] Results verified with local tools (Grep/Glob/Read)
- [ ] Discrepancies investigated and documented
- [ ] File paths are valid (`ls` check)
- [ ] Line numbers are accurate (Read check)

### Post-Edit Checklist

After Serena makes any edits:

- [ ] Changes reviewed with `git diff`
- [ ] Type check passed (`bun run typecheck`)
- [ ] Tests passed (`bun test`)
- [ ] Changes match intent (manual review)

---

## Troubleshooting

### Issue: Serena tools not available

**Symptom**: `serena_*` tools missing from tool list

**Solution**:
```bash
# 1. Restart Claude Code
# 2. Verify MCP config
cat ~/.claude/settings.json | jq '.mcpServers.serena'

# 3. Test Serena manually
cd ~/Projects/ping-mem
uvx --from git+https://github.com/oraios/serena serena --help
```

### Issue: Symbol search returns no results

**Symptom**: Serena returns empty array for known symbols

**Solution**:
```bash
# 1. Re-index project
cd ~/Projects/ping-mem
uvx --from git+https://github.com/oraios/serena serena project index .

# 2. Check LSP status
tail -f ~/.serena/logs/*.log

# 3. Verify with Grep
grep -r "SymbolName" src/
```

### Issue: File reads return old content

**Symptom**: Serena returns outdated file content

**Solution**:
```bash
# 1. Restart language server
serena_restart_language_server()

# 2. Verify file timestamp
stat src/path/to/file.ts

# 3. Compare with local read
cat src/path/to/file.ts
```

---

## Best Practices

### 1. Query Patterns

**DO**:
- Use specific symbol names (e.g., `DiagnosticsStore`)
- Filter by symbol type (class, function, variable)
- Verify results with local tools
- Document verification steps

**DON'T**:
- Use vague queries (e.g., "store")
- Trust results without verification
- Skip cross-checking with Grep/Glob
- Make edits without running type checks

### 2. Verification Workflow

**Always follow this order**:
1. Serena query (semantic intelligence)
2. Local tool verification (ground truth)
3. Cross-check results
4. Document discrepancies
5. Proceed with high-confidence results

### 3. Edit Safety

**Before any Serena edit**:
```bash
# 1. Create checkpoint
git stash push -m "before-serena-edit"

# 2. Make edit via Serena
serena_replace_lines(...)

# 3. Verify changes
git diff
bun run typecheck
bun test

# 4. If good: commit
git add .
git commit -m "refactor: Serena-assisted edit"

# 5. If bad: revert
git stash pop
```

---

## Integration with CLAUDE.md Workflow

### When to Use Serena

| Scenario | Use Serena? | Verification Tool |
|----------|-------------|-------------------|
| Find symbol definitions | ✅ Yes | Grep + Read |
| Find all references | ✅ Yes | Grep |
| Get file overview | ✅ Yes | Read |
| Search for pattern | ⚠️ Maybe | Grep (preferred) |
| Edit code | ⚠️ Caution | git diff + typecheck |
| Create files | ❌ No | Write tool (preferred) |

### Serena + Local Tools Matrix

| Task | Primary Tool | Verification Tool |
|------|-------------|-------------------|
| Symbol search | Serena | Grep |
| File read | Serena | Read |
| Pattern search | Grep | Serena (secondary) |
| File creation | Write | Serena (check) |
| Code editing | Edit | Serena (check symbols) |

---

## Maintenance

### Re-indexing Projects

When to re-index:
- After large refactors
- After external file changes (outside Claude Code)
- After changing git branches
- Monthly (preventive)

**Re-index Command**:
```bash
# ping-mem
cd ~/Projects/ping-mem
uvx --from git+https://github.com/oraios/serena serena project index .

# livekit-tutor
cd ~/Projects/livekit-gemini-voice-tutor-prototype
uvx --from git+https://github.com/oraios/serena serena project index .
```

### Health Checks

**Monthly Health Check**:
```bash
# 1. Verify projects are active
uvx --from git+https://github.com/oraios/serena serena config print

# 2. Check index freshness
ls -la ~/Projects/ping-mem/.serena/
ls -la ~/Projects/livekit-gemini-voice-tutor-prototype/.serena/

# 3. Test symbol search
cd ~/Projects/ping-mem
uvx --from git+https://github.com/oraios/serena serena project health-check .
```

---

## Next Steps

1. **Restart Claude Code** to activate Serena MCP tools
2. **Test Serena** with a simple symbol search
3. **Verify results** with local Grep
4. **Document workflow** in session notes
5. **Update CLAUDE.md** if needed

---

**License**: MIT
**Related**: CLAUDE.md, IMPLEMENTATION_SUMMARY.md
**Resources**:
- [Serena MCP Server Guide](https://apidog.com/blog/serena-mcp-server-2/)
- [Serena Configuration Reference](https://oraios.github.io/serena/02-usage/050_configuration.html)
- [Awesome MCP Servers - Serena](https://mcpservers.org/servers/oraios/serena)
