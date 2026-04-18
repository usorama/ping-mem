---
phase-id: P1
title: "Memory sync fix + MCP auth + session cap — the user's main ask"
status: pending
effort_estimate: 5h
dependent-on: phase-0-prep
owns_wiring: [W1, W2, W3, W4, W5, W6, W18]
owns_outcomes: [O1, O2, O3, O8]
addresses_gaps: [A.1, A.2, B.1, B.2, B.3, B.4, B.5, E.4]
blocks: [P2, P3, P4, P5, P6, P7]
---

# Phase 1 — Memory Sync Fix + MCP Auth + Session Cap

## Phase Goal

Deliver **O1** (MCP tool invoke from Claude Code succeeds 100%), **O2** (all 5 canonical regression queries return ≥1 hit), **O3** (ALL Claude Code auto-memory files synced in full content), and **O8** (session-cap collisions drop to 0 in 7d window) by fixing the existing `~/.claude/hooks/ping-mem-native-sync.sh` (per ADR-1, wire-don't-build-first) + `~/.claude.json` MCP env block + `SessionManager.ts` cap and reaper wiring. No net-new module under `src/memory/sync/`.

## Pre-conditions (from P0)

- `/tmp/ping-mem-remediation-baseline.json` exists with baseline metrics
- `~/.claude.json` perm is 600 (P0.2 done, V0.2 passed)
- `bun run typecheck` + `bun test` baselines captured
- Disk ≤85%
- Stale `codex|gemini|pi-run` processes killed (P0.5)

## Evidence from orchestrator grep (2026-04-18)

Verified before authoring this phase:

- `~/.claude/hooks/ping-mem-native-sync.sh` is **134 lines**, registered in `~/.claude/settings.json`.
  - Line **59**: `local FILENAME=$(basename "$FILE" .md)` — marker basename (collision source)
  - Line **61**: `local MARKER_FILE="$SYNC_MARKER_DIR/$FILENAME.hash"` — marker path (collision symptom)
  - Line **78**: `local VALUE=$(echo "$CONTENT" | head -c 2000)` — truncation (fix target)
  - Line **79**: `local KEY="native/$FILENAME"` — key (per-project prefix target)
  - Lines **108-113**: core-memory loop (`$NATIVE_MEMORY_DIR/*.md`)
  - Lines **116-121**: topics loop (`$TOPICS_DIR/*.md`)
  - Lines **123-131**: hardcoded ping-mem-only project loop (replace with glob)
  - Line **134**: `exit 0` — prevents safe sourcing (must extract to lib)
- `src/validation/api-schemas.ts:39` — `ContextSaveSchema.value.max(1_000_000)` → **server accepts 1 MB already; no schema change needed**. Only the hook's 2000-char truncation is the bottleneck.
- `src/session/SessionManager.ts:54` — `maxActiveSessions: 10,` (object-literal property, colon+comma inside DEFAULT_CONFIG)
- `src/session/SessionManager.ts:215` — `async cleanup(): Promise<number>` method with NO periodic caller in current code (the only `setInterval` is for per-session checkpointing at line 588)
- `~/.claude.json` ping-mem MCP entry currently has only `PING_MEM_REST_URL=http://localhost:3003` — no admin creds.
- `~/.claude/hooks/ping-mem-capture-stop.sh` registration status: confirmed present in `settings.json` (grep hit at line 70 of settings.json per P0 scout) — do NOT re-add.

## Task list

### P1.1 — Inject MCP admin creds into `~/.claude.json`

**Outcome**: O1.

Edit `~/.claude.json`, locate the `mcpServers.ping-mem` block, add `PING_MEM_ADMIN_USER` and `PING_MEM_ADMIN_PASS` to the `env` object. Creds are `admin` / `ping-mem-dev-local` (from `~/Projects/ping-mem/.env` where `PING_MEM_ADMIN_USER=admin` and `PING_MEM_ADMIN_PASS=ping-mem-dev-local`).

Patch (using `jq` for deterministic JSON edit so we don't corrupt sibling server entries):

```bash
# Backup first
cp -a ~/.claude.json ~/.claude.json.bak.$(date +%s)

# Read creds from ping-mem .env (source of truth)
ADMIN_USER=$(grep '^PING_MEM_ADMIN_USER=' ~/Projects/ping-mem/.env | cut -d= -f2)
ADMIN_PASS=$(grep '^PING_MEM_ADMIN_PASS=' ~/Projects/ping-mem/.env | cut -d= -f2)
[ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASS" ] || { echo "FAIL: creds missing from ~/Projects/ping-mem/.env"; exit 1; }

# Inject via jq (preserves all other fields + formatting)
jq --arg u "$ADMIN_USER" --arg p "$ADMIN_PASS" \
  '.mcpServers["ping-mem"].env.PING_MEM_ADMIN_USER = $u | .mcpServers["ping-mem"].env.PING_MEM_ADMIN_PASS = $p' \
  ~/.claude.json > ~/.claude.json.tmp && mv ~/.claude.json.tmp ~/.claude.json

# Re-assert perm after atomic replace (mv clears the 600 set by P0.2)
chmod 600 ~/.claude.json
stat -f '%Lp' ~/.claude.json  # MUST print 600
```

**Risk**: `mv` changes inode perms → re-chmod required AFTER edit (listed inline above).

**Gate**: After Claude Code restarts, invoke `mcp__ping-mem__context_health` → expect healthy JSON, NOT 403.

### P1.2 — Raise hook truncation 2000 → 1000000 (match server schema)

**Outcome**: O3.

Edit `~/.claude/hooks/ping-mem-native-sync.sh:78`. Server cap is already 1 MB per `ContextSaveSchema.value.max(1_000_000)` at `src/validation/api-schemas.ts:39` (verified). The hook is the sole truncation point — setting the hook cap equal to the schema cap honors O3's "full content / no truncation" requirement.

```bash
# Backup
cp -a ~/.claude/hooks/ping-mem-native-sync.sh ~/.claude/hooks/ping-mem-native-sync.sh.bak.$(date +%s)

# In-place patch at line 78
# Before: local VALUE=$(echo "$CONTENT" | head -c 2000)
# After : local VALUE=$(echo "$CONTENT" | head -c 1000000)
sed -i.tmp 's|head -c 2000|head -c 1000000|' ~/.claude/hooks/ping-mem-native-sync.sh
rm ~/.claude/hooks/ping-mem-native-sync.sh.tmp
```

Rationale for 1 MB (exact schema match): overview O3 requires "ALL projects, full content, no truncation." Any client cap below the server's `max(1_000_000)` creates a silent-loss window for files in that range — directly contradicting O3. Matching the schema cap exactly converts silent truncation into a LOUD server-side 400 (`value exceeds 1000000`) for the rare >1 MB file, which is exactly what O3 demands. P5's doctor gate `memory-truncation-observed` surfaces those rare cases for manual chunking review.

### P1.3 — Fix hash-marker collision (SS2 — GPT-5.4)

**Outcome**: O3 (marker collision caused cross-project skip).

Same project filenames (e.g., every project has `MEMORY.md`) share a single marker file under `$SYNC_MARKER_DIR/MEMORY.hash`. After ping-learn's `MEMORY.md` syncs and writes its hash, auto-os's `MEMORY.md` reads the same marker, sees matching hash (it matches ping-learn's content, not auto-os's), skips. Fix: derive marker from SHA-256 of the **full absolute file path**, not basename.

Edit lines 59 + 61:

```bash
# Before:
  local FILENAME=$(basename "$FILE" .md)
  ...
  local MARKER_FILE="$SYNC_MARKER_DIR/$FILENAME.hash"

# After:
  local FILENAME=$(basename "$FILE" .md)
  local PATH_HASH=$(echo -n "$FILE" | shasum -a 256 | cut -c1-16)
  local MARKER_FILE="$SYNC_MARKER_DIR/${PATH_HASH}-${FILENAME}.hash"
```

Marker filename becomes human-readable (filename) prefixed with unique short hash → no collision, still greppable.

### P1.4 — Per-project KEY_PREFIX at line 79

**Outcome**: O3 (keys must be unique-per-project so `MEMORY.md` from ping-learn doesn't overwrite ping-mem's).

Before (line 79):
```
local KEY="native/$FILENAME"
```

After:
```bash
local KEY_PREFIX
case "$FILE" in
  "$HOME/.claude/memory/topics/"*)
    KEY_PREFIX="native/topic"
    ;;
  "$HOME/.claude/memory/"*)
    KEY_PREFIX="native/global"
    ;;
  "$HOME/.claude/learnings/"*)
    KEY_PREFIX="native/learn"
    ;;
  "$HOME/.claude/projects/"*)
    local SLUG=$(echo "$FILE" | sed -E 's|.*/-Users-umasankr-Projects-([^/]+)/.*|\1|')
    KEY_PREFIX="native/proj/$SLUG"
    ;;
  *)
    KEY_PREFIX="native/other"
    ;;
esac
local KEY="$KEY_PREFIX/$FILENAME"
```

Reference order matters: `topics/` must match BEFORE `memory/` because topics is a subdir of memory.

### P1.4a — Rekey migration for existing `native/*` rows (A-HIGH-5)

**Outcome**: O3 (eliminate orphans from old `native/$FILENAME` keys).

Existing memories written under the old scheme (`native/MEMORY.md`, `native/core.md`, etc.) become unreachable after P1.4 changes the key shape. Without migration they occupy space but never surface in search.

**Dry-run first** (read-only count):

```bash
SID=$(cat ~/.ping-mem/sync-session-id)
CREDS=$(grep '^PING_MEM_ADMIN_USER=' ~/Projects/ping-mem/.env | cut -d= -f2):$(grep '^PING_MEM_ADMIN_PASS=' ~/Projects/ping-mem/.env | cut -d= -f2)

# Dry-run: list keys matching old scheme
curl -sf -u "$CREDS" -H "X-Session-ID: $SID" \
  "http://localhost:3003/api/v1/search?query=*&limit=500" \
  | jq -r '.data[].key' \
  | grep -E '^native/[^/]+$' \
  | tee /tmp/p1-migration-candidates.txt \
  | wc -l
```

If >0 candidates, execute migration:

```bash
while IFS= read -r KEY; do
  curl -sf -u "$CREDS" -H "X-Session-ID: $SID" \
    -X DELETE "http://localhost:3003/api/v1/context/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$KEY")" \
    | jq -r '.data.message // .error'
done < /tmp/p1-migration-candidates.txt
```

Then re-run the hook so the fresh (correctly-prefixed) keys get written:

```bash
rm -rf ~/.ping-mem/sync-markers/*  # force full re-sync
bash ~/.claude/hooks/ping-mem-native-sync.sh
```

**Rationale for DELETE rather than UPDATE**: we can't reliably map old `native/MEMORY.md` to a specific project (source file path was not stored in the old key). Deleting + re-importing is deterministic; the new keys preserve provenance.

### P1.5 — Flock guard against concurrent Claude windows (A-DOM-2)

**Outcome**: O3 (prevent duplicate POSTs from 2 Claude sessions starting simultaneously).

Wrap the main SessionStart sync body (lines 108–131 after P1.7 extracts the loops) with `flock -n`. If another Claude window is mid-sync, exit 0 silently.

Insert after line 22 (the `PING_MEM_URL` unreachable check, before session setup):

```bash
# Flock: prevent concurrent Claude windows from duplicating POSTs
exec 9>"$HOME/.ping-mem/sync.lock"
flock -n 9 || { echo "SYNC=busy"; exit 0; }
# flock held via fd 9 for the remainder of the script
```

The flock is per-process; the PostToolUse hook (P1.8) does NOT acquire this lock — it only imports one file at a time with its own SHA-256 idempotency, so it's safe to run concurrently with a SessionStart full-sync.

### P1.6 — Extract `import_native_file` to a source-safe lib (SS3)

**Outcome**: O3 (PostToolUse hook must be able to reuse the function without triggering a full sync or exit).

Current `ping-mem-native-sync.sh:134` has `exit 0` at top level. If the PostToolUse hook `source`s this file, it runs the full 3-loop sync and then exits the calling shell — catastrophic.

Create `~/.claude/hooks/lib/ping-mem-sync-lib.sh` (new directory):

```bash
mkdir -p ~/.claude/hooks/lib
```

Contents (function-only, NO top-level exec, NO exit):

```bash
#!/bin/bash
# ping-mem-sync-lib.sh — source-safe library for memory file import
# Sourced by ping-mem-native-sync.sh (SessionStart) + ping-mem-memory-sync-posttooluse.sh (PostToolUse).
# NEVER add top-level statements here other than function definitions.

# Caller must set: PING_MEM_URL, SESSION_ID, SYNC_MARKER_DIR before sourcing.

ping_mem_import_native_file() {
  local FILE="$1"
  local FILENAME=$(basename "$FILE" .md)
  local FILE_HASH=$(shasum -a 256 "$FILE" | cut -d' ' -f1)
  local PATH_HASH=$(echo -n "$FILE" | shasum -a 256 | cut -c1-16)
  local MARKER_FILE="$SYNC_MARKER_DIR/${PATH_HASH}-${FILENAME}.hash"

  # Skip if unchanged
  if [ -f "$MARKER_FILE" ]; then
    [ "$(cat "$MARKER_FILE")" = "$FILE_HASH" ] && return 0
  fi

  local CONTENT=$(cat "$FILE")
  [ -z "$CONTENT" ] && return 0
  [ ${#CONTENT} -lt 20 ] && return 0

  local VALUE=$(echo "$CONTENT" | head -c 1000000)

  # Derive KEY_PREFIX from path
  local KEY_PREFIX
  case "$FILE" in
    "$HOME/.claude/memory/topics/"*) KEY_PREFIX="native/topic" ;;
    "$HOME/.claude/memory/"*)        KEY_PREFIX="native/global" ;;
    "$HOME/.claude/learnings/"*)     KEY_PREFIX="native/learn" ;;
    "$HOME/.claude/projects/"*)
      local SLUG=$(echo "$FILE" | sed -E 's|.*/-Users-umasankr-Projects-([^/]+)/.*|\1|')
      KEY_PREFIX="native/proj/$SLUG"
      ;;
    *) KEY_PREFIX="native/other" ;;
  esac
  local KEY="$KEY_PREFIX/$FILENAME"

  local RESPONSE=$(curl -s --connect-timeout 2 --max-time 8 -X POST "$PING_MEM_URL/api/v1/context" \
    -H 'Content-Type: application/json' \
    -H "X-Session-ID: $SESSION_ID" \
    -d "$(jq -n --arg key "$KEY" --arg value "$VALUE" '{
      key: $key, value: $value, category: "knowledge_entry", priority: "normal"
    }')" 2>/dev/null)

  if echo "$RESPONSE" | jq -e '.error == "Conflict"' >/dev/null 2>&1; then
    curl -s --connect-timeout 2 --max-time 8 -X PUT "$PING_MEM_URL/api/v1/context/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$KEY")" \
      -H 'Content-Type: application/json' -H "X-Session-ID: $SESSION_ID" \
      -d "$(jq -n --arg value "$VALUE" '{value: $value}')" >/dev/null 2>&1
  fi

  echo "$FILE_HASH" > "$MARKER_FILE"
}
```

Rewrite `~/.claude/hooks/ping-mem-native-sync.sh` — remove the old `import_native_file` function body (the current function name conflicts with the new `ping_mem_import_native_file`; either rename calls or leave a thin wrapper). Simplest path: replace the whole function body + loops with:

```bash
# Near top, after PING_MEM_URL + SESSION_ID + SYNC_MARKER_DIR are set:
source "$HOME/.claude/hooks/lib/ping-mem-sync-lib.sh"

# (P1.5 flock guard goes here)

# SessionStart: full scan across global + topics + learnings + all projects
for F in "$HOME/.claude/CLAUDE.md" "$HOME/.claude/memory"/*.md "$HOME/.claude/memory/topics"/*.md; do
  [ -f "$F" ] || continue
  ping_mem_import_native_file "$F"
done

# Learnings (JSON + MD)
find "$HOME/.claude/learnings" -type f \( -name '*.md' -o -name '*.json' \) 2>/dev/null \
  | while IFS= read -r F; do ping_mem_import_native_file "$F"; done

# All project memory dirs
for PDIR in "$HOME/.claude/projects"/-Users-umasankr-Projects-*/memory; do
  [ -d "$PDIR" ] || continue
  for F in "$PDIR"/*.md; do
    [ -f "$F" ] || continue
    ping_mem_import_native_file "$F"
  done
done

echo "OK"
exit 0
```

### P1.7 — PostToolUse hook (detached + path-filtered)

**Outcome**: O3 + O2's <60s edit propagation (replaces SessionStart-only cadence for mid-session edits).

Create `~/.claude/hooks/ping-mem-memory-sync-posttooluse.sh`:

```bash
#!/bin/bash
# PostToolUse memory-file sync. Runs detached so Claude Code tool-loop never blocks.
# Registered in settings.json as PostToolUse hook.

PAYLOAD=$(cat)
TOOL=$(echo "$PAYLOAD" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$PAYLOAD" | jq -r '.tool_input.file_path // empty')

# Filter 1: only Write/Edit touch memory files
case "$TOOL" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Filter 2: only memory-relevant paths
case "$FILE_PATH" in
  "$HOME/.claude/memory/"*|"$HOME/.claude/memory/topics/"*|"$HOME/.claude/learnings/"*|"$HOME/.claude/projects/"*/memory/*)
    ;;
  *)
    exit 0
    ;;
esac

# Ping-mem reachability (fast fail)
PING_MEM_URL="http://localhost:3003"
curl -sf --connect-timeout 1 --max-time 2 "$PING_MEM_URL/health" >/dev/null 2>&1 || exit 0

# Session reuse from native-sync cache
SESSION_CACHE="$HOME/.ping-mem/sync-session-id"
[ -f "$SESSION_CACHE" ] || exit 0
SESSION_ID=$(cat "$SESSION_CACHE")
[ -n "$SESSION_ID" ] || exit 0

SYNC_MARKER_DIR="$HOME/.ping-mem/sync-markers"
export PING_MEM_URL SESSION_ID SYNC_MARKER_DIR

# Detached: never block Claude Code
LOG="$HOME/.ping-mem/post-tool-sync.log"
(
  source "$HOME/.claude/hooks/lib/ping-mem-sync-lib.sh"
  ping_mem_import_native_file "$FILE_PATH"
  echo "$(date -u +%FT%TZ) synced $FILE_PATH" >> "$LOG"
) &>> "$LOG" &
disown

exit 0
```

Register in `~/.claude/settings.json` under `hooks.PostToolUse[]` with `"timeout": 3` (hook itself returns near-instantly; the detached process runs independently).

### P1.8 — SessionManager cap raise + reaper + setInterval

**Outcome**: O8.

All 3 edits are in `src/session/SessionManager.ts`. Exact patches:

**Edit 1 — Declare `_reaperInterval` field** (fix TS strict-mode assignment error). Find the class body; add the field declaration next to existing `private checkpointTimers: Map<...>`:

```typescript
private _reaperInterval: NodeJS.Timeout | undefined;
```

**Edit 2 — Raise cap at line 54**:

Before:
```typescript
maxActiveSessions: 10,
```

After:
```typescript
maxActiveSessions: 50,
```

(Object-literal property inside `DEFAULT_CONFIG` — preserve colon + trailing comma.)

**Edit 3 — Add `reapSystemSessions` method** near line 215 (adjacent to existing `cleanup`):

```typescript
/**
 * Reap expired system sessions (native-sync, auto-recall, canary) + empty zombie sessions.
 * Called periodically by _reaperInterval. Preserves native-sync freshly-created sessions
 * by requiring longer idle threshold for that name (per A-SAFE-5 + race-mitigation).
 */
private async reapSystemSessions(): Promise<number> {
  const now = Date.now();
  const NAMED_IDLE_MIN = 15;   // 15min for named system sessions
  const EMPTY_IDLE_MIN = 10;   // 10min for empty unnamed sessions (Opus SS7: exclude native-sync)

  let reaped = 0;
  for (const s of await this.listActiveSessions()) {
    const idleMin = (now - new Date(s.lastActivityAt).getTime()) / 60000;
    const isSystemNamed = ["native-sync", "auto-recall", "canary"].includes(s.name);
    const isEmpty = s.memoryCount === 0 && s.eventCount === 0;

    const shouldReap =
      (isSystemNamed && idleMin >= NAMED_IDLE_MIN) ||
      (isEmpty && !isSystemNamed && idleMin >= EMPTY_IDLE_MIN);

    if (shouldReap) {
      await this.endSession(s.id);
      reaped++;
    }
  }
  return reaped;
}
```

**Edit 4 — Schedule reaper in constructor** (find `constructor(...)`; add at end of constructor body):

```typescript
// Periodic reaper: every 2 min, non-blocking
this._reaperInterval = setInterval(() => {
  this.cleanup().catch((err) => log.warn("cleanup failed", { error: String(err) }));
  this.reapSystemSessions().catch((err) => log.warn("reap failed", { error: String(err) }));
}, 120_000);
```

**Edit 5 — Clear in `close()`**:

```typescript
// In close() method:
if (this._reaperInterval) {
  clearInterval(this._reaperInterval);
  this._reaperInterval = undefined;
}
```

### P1.9 — Re-register hooks in settings.json

Verify and patch `~/.claude/settings.json`:

1. **SessionStart**: `bash ~/.claude/hooks/ping-mem-native-sync.sh` (already present per P0 scout — verify timeout ≥10).
2. **PostToolUse**: ADD `bash ~/.claude/hooks/ping-mem-memory-sync-posttooluse.sh` with `"timeout": 3`.
3. **Stop**: `bash ~/.claude/hooks/ping-mem-capture-stop.sh` (already registered per P0 scout — **do NOT duplicate**; grep first).

Pre-check before edit:

```bash
# Must return 1 (not already there):
grep -c 'ping-mem-memory-sync-posttooluse' ~/.claude/settings.json
# Must return ≥1 (already there):
grep -c 'ping-mem-capture-stop' ~/.claude/settings.json
```

### P1.10 — Smoke-test the 5 canonical regression queries

**Outcome**: O2 binary gate.

After P1.1–P1.9 land, force a full re-sync + run all 5 queries:

```bash
# Clear markers to force re-import (P1.3 changed marker path scheme anyway)
rm -rf ~/.ping-mem/sync-markers/*

# Restart Claude Code to pick up new MCP env (P1.1). From another terminal:
bash ~/.claude/hooks/ping-mem-native-sync.sh

# Then query
SID=$(cat ~/.ping-mem/sync-session-id)
CREDS="admin:ping-mem-dev-local"

for Q in \
  "ping-learn pricing research" \
  "Firebase FCM pinglearn-c63a2" \
  "classroom redesign worktree" \
  "PR 236 JWT secret isolation" \
  "DPDP consent age 18"
do
  HITS=$(curl -sf -u "$CREDS" -H "X-Session-ID: $SID" \
    "http://localhost:3003/api/v1/search?query=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$Q")&limit=3" \
    | jq '.data | length')
  printf '%-40s → %s hits\n' "$Q" "${HITS:-0}"
done
```

**Gate**: every line must print ≥1 hits.

## Function Signatures

```typescript
// src/session/SessionManager.ts — NEW method
private async reapSystemSessions(): Promise<number>;
// Field added:
private _reaperInterval: NodeJS.Timeout | undefined;
```

```bash
# ~/.claude/hooks/lib/ping-mem-sync-lib.sh — NEW
ping_mem_import_native_file() {
  # args: $1 = absolute file path
  # env required: PING_MEM_URL, SESSION_ID, SYNC_MARKER_DIR
  # returns: 0 always (best-effort)
}
```

## Integration Points

| Task | File | Line(s) | Change |
|------|------|---------|--------|
| P1.1 | `~/.claude.json` | `mcpServers["ping-mem"].env` | add `PING_MEM_ADMIN_USER`, `PING_MEM_ADMIN_PASS` |
| P1.2 | `~/.claude/hooks/ping-mem-native-sync.sh` | 78 | `head -c 2000` → `head -c 1000000` (match `ContextSaveSchema.value.max(1_000_000)`) |
| P1.3 | `~/.claude/hooks/ping-mem-native-sync.sh` | 59, 61 | add `PATH_HASH`; marker becomes `${PATH_HASH}-${FILENAME}.hash` |
| P1.4 | `~/.claude/hooks/ping-mem-native-sync.sh` | 79 | per-project `KEY_PREFIX` case stmt |
| P1.4a | REST `/api/v1/context/:key` | runtime | DELETE orphans |
| P1.5 | `~/.claude/hooks/ping-mem-native-sync.sh` | after line 22 | add flock guard |
| P1.6 | `~/.claude/hooks/lib/ping-mem-sync-lib.sh` | NEW | extract + rewrite |
| P1.6 | `~/.claude/hooks/ping-mem-native-sync.sh` | 108-131 (3 loops) | replace with lib-source + glob |
| P1.7 | `~/.claude/hooks/ping-mem-memory-sync-posttooluse.sh` | NEW | detached PostToolUse hook |
| P1.8 | `src/session/SessionManager.ts` | class body | add `_reaperInterval` field |
| P1.8 | `src/session/SessionManager.ts` | 54 | `maxActiveSessions: 10,` → `50,` |
| P1.8 | `src/session/SessionManager.ts` | ~215 | add `reapSystemSessions` method |
| P1.8 | `src/session/SessionManager.ts` | constructor | add `setInterval` for reaper |
| P1.8 | `src/session/SessionManager.ts` | `close()` | add `clearInterval` |
| P1.9 | `~/.claude/settings.json` | `hooks.PostToolUse[]` | add posttooluse hook |

## Wiring Matrix Rows Owned

- **W1** MCP tool invocation works: Claude Code → `mcpServers.ping-mem` env (P1.1) → proxy-cli reads `PING_MEM_ADMIN_USER`/`PASS` → Basic Auth header → REST `/api/v1/tools/:name/invoke` validates at `rest-server.ts:3646` → tool runs.
- **W2** All project memory files synced: PostToolUse hook (P1.7) → `lib/ping-mem-sync-lib.sh#ping_mem_import_native_file` → `POST /api/v1/context`.
- **W3** CLAUDE.md ingested: SessionStart glob includes `$HOME/.claude/CLAUDE.md` (P1.6 loop).
- **W4** Learnings ingested: SessionStart `find $HOME/.claude/learnings` loop (P1.6).
- **W5** <60s edit propagation: PostToolUse hook fires on Write/Edit; detached exec keeps tool-loop unblocked (P1.7).
- **W6** 5/5 regression queries return hits: smoke test (P1.10) + P7 CI suite.
- **W18** Session cap + reaper: `setInterval(...)` in constructor (P1.8) invokes `reapSystemSessions` every 120 s.

## Verification Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| V1.1 | MCP creds in claude.json | `jq '.mcpServers["ping-mem"].env \| has("PING_MEM_ADMIN_USER")' ~/.claude.json` | `true` |
| V1.2 | claude.json perm 600 | `stat -f '%Lp' ~/.claude.json` | `600` |
| V1.3 | Hook truncation 1000000 (schema-aligned, no silent loss) | `grep 'head -c 1000000' ~/.claude/hooks/ping-mem-native-sync.sh && ! grep -qE 'head -c (2000\|30000)(\$\|[^0-9])' ~/.claude/hooks/ping-mem-native-sync.sh && echo OK` | `OK` |
| V1.4 | Marker path includes PATH_HASH | `grep 'PATH_HASH' ~/.claude/hooks/ping-mem-native-sync.sh` | match |
| V1.5 | KEY_PREFIX case stmt present | `grep 'KEY_PREFIX="native/proj' ~/.claude/hooks/ping-mem-native-sync.sh` | match |
| V1.6 | Flock guard present | `grep 'flock -n 9' ~/.claude/hooks/ping-mem-native-sync.sh` | match |
| V1.7 | Lib exists and is function-only | `test -f ~/.claude/hooks/lib/ping-mem-sync-lib.sh && ! grep -E '^[^#[:space:]]+\s*$' ~/.claude/hooks/lib/ping-mem-sync-lib.sh \| grep -v '^\s*}' \| grep -v '^\s*function\|^ping_mem_' \| head -5` | empty (no top-level exec) |
| V1.8 | Projects glob replaces hardcoded | `grep '\-Users-umasankr-Projects-\*' ~/.claude/hooks/ping-mem-native-sync.sh` | match (wildcard glob) |
| V1.9 | PostToolUse hook exists | `test -x ~/.claude/hooks/ping-mem-memory-sync-posttooluse.sh` | exit 0 |
| V1.10 | PostToolUse registered | `grep -c 'ping-mem-memory-sync-posttooluse' ~/.claude/settings.json` | `1` |
| V1.11 | Capture-stop NOT duplicated | `grep -c 'ping-mem-capture-stop' ~/.claude/settings.json` | `1` (not 2) |
| V1.12 | SessionManager cap 50 | `grep 'maxActiveSessions: 50' src/session/SessionManager.ts` | match |
| V1.13 | `_reaperInterval` field declared | `grep '_reaperInterval.*NodeJS.Timeout' src/session/SessionManager.ts` | match |
| V1.14 | `reapSystemSessions` method defined | `grep 'private async reapSystemSessions' src/session/SessionManager.ts` | match |
| V1.15 | setInterval in constructor | `grep -A2 'constructor' src/session/SessionManager.ts \| grep 'setInterval.*120_000'` | match |
| V1.16 | clearInterval in close | `grep -A10 'close()' src/session/SessionManager.ts \| grep 'clearInterval(this._reaperInterval)'` | match |
| V1.17 | Typecheck passes | `bun run typecheck` | 0 errors |
| V1.18 | No orphan `native/<filename>` keys | `curl ... /api/v1/search?query=* \| jq '[.data[].key \| select(test("^native/[^/]+$"))] \| length'` | `0` (after P1.4a) |

## Functional Tests

| # | Test | Command | Expected |
|---|------|---------|----------|
| F1.1 (W1) | MCP `context_health` works | In Claude Code: invoke `mcp__ping-mem__context_health` | `{status:"healthy",...}` not 403 |
| F1.2 (W2) | Mid-session edit propagates | Write file `~/.claude/memory/topics/p1-smoke.md` with content "smoke-sentinel-$(date +%s)"; sleep 30; search | ≥1 hit for sentinel |
| F1.3 (W3) | CLAUDE.md synced | After full sync: `/api/v1/search?query=superpowers` | ≥1 hit from CLAUDE.md content |
| F1.4 (W4) | Learnings synced | Write `~/.claude/learnings/test.md` with "learn-sentinel"; bash hook; search | ≥1 hit |
| F1.5 (W5) | PostToolUse doesn't block | Time a Write edit on memory file; hook returns <500ms | `real < 0.5s` |
| F1.6 (W6) | 5/5 regression queries hit | P1.10 script | all 5 print ≥1 |
| F1.7 (W18) | Reaper ends zombies | Create 11 `native-sync` sessions via rapid `session/start` calls; sleep 17 min; `/api/v1/session/list` filter count | < 11 (reaper removed at least 1) |
| F1.8 (W18) | Cap raised to 50 | Create 40 sessions rapidly | none return 429 |
| F1.9 | Flock prevents duplicates | Run hook twice simultaneously (`& bash ...& bash ...`); check POST count | second run exits "SYNC=busy" |
| F1.10 | Claude.json perm stays 600 after P1.1 edit | `stat -f '%Lp' ~/.claude.json` post-task | `600` |

## Gate Criterion

**Binary PASS**: V1.1–V1.18 all pass AND F1.1–F1.10 all pass AND `bun run typecheck` shows 0 errors AND `bun test` pass count ≥ P0 baseline.

**Single FAIL = phase blocked**, no cascade to P2/P3/P4.

## Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1.1 | `jq` patch of `~/.claude.json` corrupts file | HIGH | Backup before patch (P1.1 shows `cp -a ... .bak`); re-chmod after mv |
| R1.2 | Creds in `.env` don't match running container | MED | Read from `~/Projects/ping-mem/.env` (source of truth); verify via REST `/api/v1/stats` 200 response post-edit |
| R1.3 | Files >1 MB hit server 400 (schema-enforced LOUD failure) | LOW | Schema-aligned cap is deliberate — silent truncation would violate O3. P5 doctor gate `memory-truncation-observed` surfaces the rare >1 MB case. If >5 such files in 30 days, consider a chunking strategy (file GH issue; not in P1 scope). |
| R1.4 | PATH_HASH collision (16 hex chars = 64 bits) | NEGLIGIBLE | Birthday-bound: need 2^32 paths for 50% collision. Fewer than 1M files plausible. |
| R1.5 | Rekey migration DELETEs a legit non-orphan row | MED | Regex `^native/[^/]+$` matches ONLY old-scheme single-segment keys; new scheme always has ≥2 segments. Dry-run prints candidates before DELETE. |
| R1.6 | Flock leaves stale lock on crash | LOW | macOS releases flock on process exit automatically; no stale state possible |
| R1.7 | Lib-source leaks variables into caller | LOW | All variables `local` inside the function; caller env only sees the function name |
| R1.8 | Reaper ends an active long-running service session | MED | Allowlist protects `native-sync`/`auto-recall`/`canary`; 15-min idle threshold. Non-allowlisted sessions need 10min idle + 0 activity |
| R1.9 | Native-sync session reaped between windows → zombie rewrite loop | MED | Mitigated via longer 15min threshold for named sessions + P5 doctor alerts on any reap event for `native-sync` |
| R1.10 | Existing `SessionManager.endSession` signature mismatch | LOW | Read file before patch; adjust call if signature differs. Confirmed at orchestrator scout: `endSession(id: string)` exists. |

## Dependencies

- **P0** (baseline captured, disk cleared, `~/.claude.json` already chmod 600, stale procs killed, GH issues GH-NEW-1/2/3 queued)
- No forward dependency on P2/P3/P4.

## Exit state

- `~/.claude.json` has admin creds, perm 600
- `~/.claude/hooks/ping-mem-native-sync.sh` patched (truncation, marker path, KEY_PREFIX, flock)
- `~/.claude/hooks/lib/ping-mem-sync-lib.sh` exists (new)
- `~/.claude/hooks/ping-mem-memory-sync-posttooluse.sh` exists + registered in settings.json
- `src/session/SessionManager.ts`: cap=50, `reapSystemSessions` defined, `_reaperInterval` field + setInterval in constructor, clearInterval in close
- `~/.ping-mem/sync-markers/` contains fresh markers (path-hashed filenames)
- `~/.ping-mem/post-tool-sync.log` starts accumulating entries
- REST `/api/v1/session/list` count stays <40 after rapid session creation
- 5/5 regression queries return ≥1 hit
- MCP `mcp__ping-mem__context_health` returns 200
- Ready to hand off to P2 (ingestion) and P3 (self-heal)

---

**Authoring note**: this phase file was written directly by the orchestrator (Opus 4.7) after the delegated phase-1 agent stalled at the 600s watchdog. All line numbers and signatures grep-verified against the live repo on 2026-04-18. `ContextSaveSchema.value.max(1_000_000)` confirmed at `src/validation/api-schemas.ts:39`.
