# Serena Quick Reference Card

**Status**: Active | **Projects**: ping-mem, livekit-tutor | **Indexed Files**: 387 total

---

## ⚡ Quick Commands

### Activation Check
```bash
# Verify Serena is loaded (check for serena_* tools in Claude Code)
# If missing: Restart Claude Code
```

### Re-index Projects
```bash
# ping-mem
cd ~/Projects/ping-mem && uvx --from git+https://github.com/oraios/serena serena project index .

# livekit-tutor
cd ~/Projects/livekit-gemini-voice-tutor-prototype && uvx --from git+https://github.com/oraios/serena serena project index .
```

---

## 🔍 Common Queries

### Find Symbol Definition
```typescript
// Serena
serena_find_symbol({
  query: "DiagnosticsStore",
  symbol_types: ["class"]
})

// Verify
grep -r "class DiagnosticsStore" src/ --include="*.ts"
```

### Find All References
```typescript
// Serena
serena_find_referencing_symbols({
  file_path: "src/ingest/IngestionService.ts",
  line: 10,
  character: 0
})

// Verify
grep -r "IngestionService" src/ --include="*.ts"
```

### Get File Overview
```typescript
// Serena
serena_get_symbols_overview({
  file_path: "src/diagnostics/DiagnosticsStore.ts"
})

// Verify
grep "^export class\\|^export function\\|^export const" src/diagnostics/DiagnosticsStore.ts
```

### Search Pattern
```typescript
// Serena
serena_search_for_pattern({
  query: "async.*ingest",
  use_regex: true
})

// Verify (PREFERRED)
grep -rE "async.*ingest" src/
```

---

## ✅ Verification Protocol (MANDATORY)

```
1. Query Serena → 2. Verify with Local Tools → 3. Cross-check → 4. Proceed
```

### Example Workflow

```bash
# 1. Serena query (semantic)
serena_find_symbol({query: "EventStore", symbol_types: ["class"]})
# → Returns: src/storage/EventStore.ts:15

# 2. Local verification (ground truth)
grep -r "class EventStore" src/ --include="*.ts"
# → Returns: src/storage/EventStore.ts:15:export class EventStore {

# 3. Cross-check
# ✅ Same file: src/storage/EventStore.ts
# ✅ Same line: 15
# ✅ Match confirmed

# 4. Proceed with confidence
```

---

## ⚠️ Risk Checklist

### Before Using Serena Results

- [ ] Verified with Grep/Glob/Read
- [ ] Checked file paths exist (`ls`)
- [ ] Confirmed line numbers match
- [ ] Reviewed .gitignore exclusions

### After Serena Edits

- [ ] Ran `git diff` (review changes)
- [ ] Ran `bun run typecheck` (0 errors)
- [ ] Ran `bun test` (all pass)
- [ ] Manual code review

---

## 🚨 Troubleshooting

| Issue | Solution |
|-------|----------|
| **Tools missing** | Restart Claude Code |
| **No results** | Re-index project |
| **Old content** | Restart LSP: `serena_restart_language_server()` |
| **Wrong results** | Verify with Grep, check .gitignore |

---

## 📚 Full Documentation

See `docs/SERENA_INTEGRATION.md` for complete guide.

**Resources**:
- [Serena Docs](https://oraios.github.io/serena/)
- [MCP Guide](https://oraios.github.io/serena/02-usage/030_clients.html)
- [Config Reference](https://oraios.github.io/serena/02-usage/050_configuration.html)
