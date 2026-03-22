# Claude Code Lifecycle Hooks — Technical Reference for REST API Integration

Research date: 2026-03-22
Sources: Official Claude Code hooks documentation (code.claude.com/docs/en/hooks), claudefa.st hooks guide, existing hook scripts in ~/.claude/hooks/

---

## 1. Available Hook Events

Claude Code fires hooks at these lifecycle points:

| Event | Fires When | Can Block Claude | Notes |
|-------|-----------|-----------------|-------|
| `SessionStart` | Session begins or resumes | No | Source: startup/resume/clear/compact |
| `UserPromptSubmit` | User submits a prompt | Yes (exit 2 or decision:block) | Fires before Claude processes it |
| `PreToolUse` | Before any tool executes | Yes (permissionDecision:deny) | Matcher filters by tool name |
| `PermissionRequest` | Permission dialog would appear | Yes | For tools requiring user approval |
| `PostToolUse` | After a tool succeeds | No (can inject feedback) | Has both tool_input and tool_response |
| `PostToolUseFailure` | After a tool fails | No | Can inject additionalContext |
| `Stop` | Claude finishes a response turn | Yes (decision:block) | Used for completion guards |
| `SubagentStart` | Subagent spawned | No | Only in multi-agent sessions |
| `SubagentStop` | Subagent finishes | Yes (decision:block) | |
| `StopFailure` | API error occurs | No | |
| `Notification` | Claude sends a notification | No | |
| `PreCompact` | Before context compaction | No | |
| `PostCompact` | After context compaction | No | |
| `SessionEnd` | Session terminates entirely | No | Distinct from Stop |
| `ConfigChange` | Settings file changes | Yes | Can block config reload |
| `Elicitation` | MCP server requests user input | Yes | Can accept/decline/cancel |
| `WorktreeCreate` | Git worktree creation | Yes | Stdout must be the worktree path |
| `WorktreeRemove` | Git worktree removal | No | |
| `InstructionsLoaded` | CLAUDE.md file loaded | No | |
| `TaskCompleted` | Agent task completed | Yes (exit 2 or continue:false) | Teams/subagent mode |
| `TeammateIdle` | Teammate goes idle | Yes (exit 2 or continue:false) | Teams mode |

---

## 2. Configuration in settings.json

### File Locations (in precedence order)
```
~/.claude/settings.json                    # User-level, all projects
.claude/settings.json                       # Project-level, shareable via git
.claude/settings.local.json                 # Project-level, local only (gitignored)
~/.claude/plugins/*/hooks/hooks.json        # Plugin-provided hooks
```

### Schema

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/script.sh",
            "timeout": 10,
            "async": false,
            "statusMessage": "Syncing to ping-mem..."
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/session-init.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/session-end.sh",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  },
  "disableAllHooks": false
}
```

### Key Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `matcher` | string (regex) | `""` (match all) | Regex applied to tool name. No spaces around `\|`. Case-sensitive. |
| `type` | string | required | `"command"`, `"http"`, `"prompt"`, or `"agent"` |
| `command` | string | required for command | Shell command to execute |
| `timeout` | integer | 30 (http/prompt), 60 (agent), 600 (command) | Seconds before hook is killed |
| `async` | boolean | `false` | If true, fire-and-forget — never blocks Claude |
| `once` | boolean | `false` | Only fire once per session |
| `statusMessage` | string | none | Shown in UI while hook runs |

### Matcher Pattern Examples
```
""                     # Match all tools (omit matcher field entirely)
"Bash"                 # Exact tool name
"Edit|Write"           # Multiple tools (regex OR — no spaces)
"mcp__memory__.*"      # All tools from memory MCP server
"mcp__.*__write.*"     # Write operations from any MCP server
"startup|resume"       # SessionStart source values
```

---

## 3. Hook Input: stdin JSON Payload

All `type: "command"` hooks receive a JSON object on **stdin**. Read it with `INPUT=$(cat)`.

### Common Fields Present in ALL Hook Events

```json
{
  "hook_event_name": "PostToolUse",
  "session_id": "abc123def456",
  "transcript_path": "/Users/umasankr/.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/umasankr/Projects/ping-mem",
  "permission_mode": "bypassPermissions",
  "agent_id": "agent-123",
  "agent_type": "Explore"
}
```

Note: `agent_id` and `agent_type` are only present in subagent hooks.

### SessionStart Payload

```json
{
  "hook_event_name": "SessionStart",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/Users/umasankr/Projects/ping-mem",
  "permission_mode": "bypassPermissions",
  "source": "startup"
}
```

Fields:
- `source`: one of `"startup"` | `"resume"` | `"clear"` | `"compact"`

Parse in bash:
```bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "$CWD")
```

### UserPromptSubmit Payload

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "bypassPermissions",
  "prompt": "Write a function to parse JSON and POST to ping-mem"
}
```

Fields:
- `prompt`: the full text the user typed

Parse in bash:
```bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
```

### PreToolUse Payload

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "bypassPermissions",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01ABCxyz",
  "tool_input": {
    "command": "npm test",
    "description": "Run tests",
    "timeout": 120000,
    "run_in_background": false
  }
}
```

Fields by tool_name:
- `Bash`: `tool_input.command` (string), `tool_input.description`, `tool_input.timeout`, `tool_input.run_in_background`
- `Write`: `tool_input.file_path`, `tool_input.content`
- `Edit`: `tool_input.file_path`, `tool_input.old_string`, `tool_input.new_string`
- `Read`: `tool_input.file_path`, `tool_input.limit`, `tool_input.offset`
- `Grep`: `tool_input.pattern`, `tool_input.path`, `tool_input.glob`
- MCP tools: `tool_name` format is `mcp__<server>__<tool>`, e.g. `mcp__memory__save`

Parse in bash:
```bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
# For Bash tools:
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
# For Write/Edit tools:
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
```

### PostToolUse Payload

```json
{
  "hook_event_name": "PostToolUse",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "bypassPermissions",
  "tool_name": "Write",
  "tool_use_id": "toolu_01ABCxyz",
  "tool_input": {
    "file_path": "/path/to/file.ts",
    "content": "export function foo() { ... }"
  },
  "tool_response": {
    "filePath": "/path/to/file.ts",
    "success": true
  }
}
```

`tool_response` shape varies by tool:
- `Bash`: `{ "stdout": "...", "stderr": "...", "exitCode": 0, "interrupted": false }`
- `Write`: `{ "filePath": "/path", "success": true }`
- `Edit`: `{ "filePath": "/path", "success": true }`
- `Read`: `{ "content": "file contents...", "numLines": 42 }`
- `Grep`: `{ "results": [...] }`

Parse in bash:
```bash
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# For Bash PostToolUse:
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exitCode // 0')

# For Write/Edit PostToolUse:
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
SUCCESS=$(echo "$INPUT" | jq -r '.tool_response.success // false')
```

### Stop Payload

```json
{
  "hook_event_name": "Stop",
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "bypassPermissions",
  "stop_hook_active": false,
  "last_assistant_message": "I've completed the implementation. The changes include..."
}
```

Fields:
- `stop_hook_active`: boolean — true if a previous Stop hook already blocked this stop (prevents infinite loops)
- `last_assistant_message`: the last text Claude outputted before stopping

Parse in bash:
```bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
```

### Environment Variables Available in All Hooks

```bash
CLAUDE_PROJECT_DIR        # Project root directory (all hooks)
CLAUDE_ENV_FILE           # Path to write env vars to persist (SessionStart/Setup only)
CLAUDE_CODE_REMOTE        # "true" if running in web environment; unset locally
CLAUDE_PLUGIN_ROOT        # Plugin installation directory
CLAUDE_PLUGIN_DATA        # Plugin persistent data directory
CLAUDE_SESSION_ID         # Session ID (also available in stdin JSON)
```

Note: `CLAUDE_SESSION_ID` env var confirmed working in existing hook scripts (see `memory-persist-stop.sh` line 22: `SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"`). However, `session_id` in the stdin JSON is more reliable — always prefer the stdin payload.

---

## 4. Hook Output Format

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success. Claude Code reads stdout and parses JSON if present. |
| `2` | Blocking error. stderr content is sent to Claude as context / shown to user. Tool/action is blocked. |
| Other non-zero | Non-blocking error. stderr shown in verbose mode only. Execution continues. |

### Stdout JSON Structure

Output is only meaningful for hooks that can influence behavior. For fire-and-forget (logging, API calls), exit 0 with no stdout.

**Universal fields** (any hook):
```json
{
  "continue": true,
  "stopReason": "Reason shown when continue is false",
  "suppressOutput": false,
  "systemMessage": "Warning text injected into Claude's context"
}
```

**SessionStart — inject context into Claude's memory**:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Text injected into Claude's system context for this session"
  }
}
```

**UserPromptSubmit — inject context or block prompt**:
```json
{
  "decision": "block",
  "reason": "Reason shown to user",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Extra context prepended to Claude's processing"
  }
}
```

**PreToolUse — allow, deny, or modify the tool call**:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Validated safe",
    "updatedInput": {
      "command": "safe_wrapper 'original_command'"
    },
    "additionalContext": "Security validation passed"
  }
}
```

**PostToolUse — inject feedback or block**:
```json
{
  "decision": "block",
  "reason": "Tests failed after file was written",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Lint errors detected: line 42 unused variable",
    "updatedMCPToolOutput": "replacement output string (MCP tools only)"
  }
}
```

**Stop — allow stop or force continuation**:
```json
{
  "decision": "block",
  "reason": "Tests not yet passing — continue fixing"
}
```

For fire-and-forget REST API logging hooks, just `exit 0` — no stdout needed.

---

## 5. Hook Type: HTTP (Native REST)

Claude Code has a native `http` hook type that POSTs directly to a REST endpoint — no shell script needed.

```json
{
  "type": "http",
  "url": "http://localhost:3003/api/v1/hooks/capture",
  "timeout": 5,
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer $PING_MEM_API_KEY",
    "X-Session-ID": "$CLAUDE_SESSION_ID"
  },
  "allowedEnvVars": ["PING_MEM_API_KEY", "CLAUDE_SESSION_ID"]
}
```

Behavior:
- Claude Code POSTs the same stdin JSON payload as a `command` hook to the URL
- Same JSON payload format (hook_event_name, session_id, tool_name, etc.)
- 2xx response = success; Claude reads the response body as the hook output JSON
- Non-2xx, connection refused, or timeout = non-blocking error (execution continues)
- `allowedEnvVars`: required whitelist for env var interpolation in headers. Variables not in this list resolve to empty strings.
- Default timeout: 30 seconds
- Deduplication: by URL (identical URL = same hook, not run twice)

**Important**: HTTP hooks cannot block actions by returning non-2xx. To block, return 2xx with `{"decision": "block", "reason": "..."}` in the body.

---

## 6. Making Async REST API Calls from Shell Hooks

For capturing data to ping-mem without blocking Claude, there are two approaches:

### Approach A: `async: true` flag in settings.json

```json
{
  "type": "command",
  "command": "bash ~/.claude/hooks/my-capture-hook.sh",
  "async": true
}
```

- Claude does NOT wait for the hook to complete
- Fire-and-forget: the hook process runs in background
- Cannot influence Claude's behavior (no output parsed)
- Only available for `type: "command"` hooks

### Approach B: Background curl in the shell script

```bash
#!/bin/bash
INPUT=$(cat)

# Parse payload
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Fire-and-forget POST — & sends to background, won't block Claude
curl -s -X POST "http://localhost:3003/api/v1/hooks/capture" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg session "$SESSION_ID" \
    --arg tool "$TOOL_NAME" \
    --arg cwd "$CWD" \
    '{sessionId: $session, toolName: $tool, cwd: $cwd}')" \
  --max-time 0.5 \
  > /dev/null 2>&1 &

exit 0
```

The key pattern from existing hooks (`command-center-event.sh`):
- `--max-time 0.5` — hard timeout on the curl call
- `> /dev/null 2>&1` — suppress all output
- `&` at end — background the process
- `exit 0` — Claude Code proceeds immediately

### Approach C: Native HTTP hook type (cleanest for pure logging)

```json
{
  "PostToolUse": [
    {
      "hooks": [
        {
          "type": "http",
          "url": "http://localhost:3003/api/v1/hooks/post-tool-use",
          "timeout": 2,
          "headers": {
            "Content-Type": "application/json"
          }
        }
      ]
    }
  ]
}
```

The HTTP hook type handles the async semantics itself — non-2xx and timeouts are non-blocking by design.

---

## 7. Performance Considerations for Hooks Calling REST APIs

### Timeout Budget

Each hook has a timeout that determines how long Claude waits. Observed patterns from existing hooks:
- SessionStart hooks: 5-10 seconds (user tolerates startup delay)
- PreToolUse hooks: 2-5 seconds (blocks tool execution)
- PostToolUse hooks: 5-10 seconds (blocks next Claude message)
- Stop hooks: 5-10 seconds (blocks session end)
- Fire-and-forget hooks: `async: true` or `--max-time 0.5` with `&`

Recommended timeout for ping-mem REST calls:
- Health check: `--connect-timeout 1 --max-time 2`
- Data writes: `--max-time 3`
- Blocking hooks: set `"timeout": 5` in settings.json

### Availability Check Pattern

Always check if the REST API is reachable before attempting calls (from `ping-mem-auto-recall.sh`):

```bash
if ! curl -sf --connect-timeout 1 --max-time 2 "$PING_MEM_URL/health" > /dev/null 2>&1; then
  exit 0  # Silently skip — ping-mem not running
fi
```

### Deduplication

- Command hooks: deduplicated by the `command` string — identical commands merged
- HTTP hooks: deduplicated by URL
- If multiple hook entries have the same command/URL, they're treated as one

### Rate Limiting

Claude Code does not have built-in hook rate limiting. For PostToolUse hooks that fire on every tool call (Bash, Edit, Write), calls accumulate quickly. Options:
1. Use `matcher` to narrow which tools trigger the hook
2. Use `async: true` so hooks don't pile up in series
3. Implement a debounce in the shell script using a lockfile or timestamp check
4. Use the `once: true` flag to fire only once per session

### Concurrency

Multiple hooks for the same event run in sequence (not parallel), except `prompt` and `agent` type hooks which run in parallel. For parallel execution of multiple command hooks, use `async: true`.

---

## 8. Exact Payload Parsing Reference for Shell Scripts

### Complete PostToolUse Handler Template

```bash
#!/bin/bash
# Template for PostToolUse hook that POSTs to ping-mem REST API

PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"

# Always read stdin first
INPUT=$(cat)

# Extract common fields
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "$CWD")
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')

# Extract tool-specific fields
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
TOOL_RESPONSE=$(echo "$INPUT" | jq -c '.tool_response // {}')

# Check ping-mem reachability (fast fail)
if ! curl -sf --connect-timeout 1 --max-time 2 "$PING_MEM_URL/health" > /dev/null 2>&1; then
  exit 0
fi

# POST to ping-mem (background, fire-and-forget)
curl -s -X POST "$PING_MEM_URL/api/v1/events" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg event "post_tool_use" \
    --arg session "$SESSION_ID" \
    --arg tool "$TOOL_NAME" \
    --arg tool_use_id "$TOOL_USE_ID" \
    --arg project "$PROJECT" \
    --arg cwd "$CWD" \
    --argjson tool_input "$TOOL_INPUT" \
    --argjson tool_response "$TOOL_RESPONSE" \
    '{
      eventType: $event,
      sessionId: $session,
      payload: {
        toolName: $tool,
        toolUseId: $tool_use_id,
        project: $project,
        cwd: $cwd,
        toolInput: $tool_input,
        toolResponse: $tool_response
      }
    }')" \
  --max-time 3 \
  > /dev/null 2>&1 &

exit 0
```

### Complete SessionStart Handler Template

```bash
#!/bin/bash
# Template for SessionStart hook that registers session in ping-mem

PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // empty')       # startup|resume|clear|compact
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "$CWD")

if ! curl -sf --connect-timeout 1 --max-time 2 "$PING_MEM_URL/health" > /dev/null 2>&1; then
  exit 0
fi

# Register session (synchronous — we want to know the ping-mem session ID)
RESPONSE=$(curl -s --max-time 3 -X POST "$PING_MEM_URL/api/v1/session/start" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg name "$PROJECT" \
    --arg source "$SOURCE" \
    --arg claude_session "$SESSION_ID" \
    '{name: $name, metadata: {source: $source, claudeSessionId: $claude_session}}')" \
  2>/dev/null)

PING_MEM_SESSION=$(echo "$RESPONSE" | jq -r '.data.sessionId // .data.id // empty')
if [ -n "$PING_MEM_SESSION" ]; then
  echo "$PING_MEM_SESSION" > "$HOME/.ping-mem/sync-session-id"
fi

# Output additionalContext to inject into Claude's session
jq -n \
  --arg session "$PING_MEM_SESSION" \
  --arg project "$PROJECT" \
  '{
    "hookSpecificOutput": {
      "hookEventName": "SessionStart",
      "additionalContext": ("ping-mem session active: " + $session + " (project: " + $project + ")")
    }
  }'

exit 0
```

### Complete Stop Handler Template

```bash
#!/bin/bash
# Template for Stop hook that records session end in ping-mem

PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' | head -c 500)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "$CWD")

# Avoid infinite loop: if a Stop hook is already blocking, don't block again
# (stop_hook_active = true means we already fired a block once)

# Get cached ping-mem session
SESSION_CACHE="$HOME/.ping-mem/sync-session-id"
PING_MEM_SESSION=""
if [ -f "$SESSION_CACHE" ]; then
  PING_MEM_SESSION=$(cat "$SESSION_CACHE")
fi

if ! curl -sf --connect-timeout 1 --max-time 2 "$PING_MEM_URL/health" > /dev/null 2>&1; then
  exit 0
fi

# Fire and forget — don't block the stop
curl -s -X POST "$PING_MEM_URL/api/v1/events" \
  -H 'Content-Type: application/json' \
  -H "X-Session-ID: ${PING_MEM_SESSION}" \
  -d "$(jq -n \
    --arg session "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg last_msg "$LAST_MSG" \
    '{
      eventType: "session_stop",
      sessionId: $session,
      payload: {
        project: $project,
        lastAssistantMessage: $last_msg
      }
    }')" \
  --max-time 3 \
  > /dev/null 2>&1 &

exit 0
```

---

## 9. Existing Hooks in ~/.claude/hooks/ Relevant to ping-mem

The user already has these hooks wired in `settings.json`:

| Hook Script | Event | What It Does |
|------------|-------|-------------|
| `ping-mem-auto-recall.sh` | UserPromptSubmit | Extracts keywords from prompt, calls `POST /api/v1/memory/auto-recall`, outputs additionalContext |
| `ping-mem-native-sync.sh` | SessionStart | Imports ~/.claude/memory/*.md files into ping-mem via REST API |
| `memory-persist-stop.sh` | Stop | Writes session_end event directly to SQLite (ping-mem.db) |
| `memory-persist-pr-merge.sh` | PostToolUse (Bash) | Detects `gh pr merge` commands, writes pr_merged event to SQLite |
| `command-center-event.sh` | SessionStart, Stop | POSTs events to command center API (fire-and-forget, 0.5s timeout) |

### Observed Pattern: REST vs Direct SQLite

Existing hooks use two strategies:
1. **REST API** (preferred): `ping-mem-auto-recall.sh`, `ping-mem-native-sync.sh` — avoids WAL lock conflicts when ping-mem Docker container has the DB open
2. **Direct SQLite** (fallback): `memory-persist-stop.sh`, `memory-persist-pr-merge.sh` — used when REST is unavailable or for simple appends

For new auto-capture hooks, use REST API as primary with SQLite as fallback, matching the existing pattern.

### Existing ping-mem REST Endpoints Used by Hooks

From `ping-mem-auto-recall.sh` and `ping-mem-native-sync.sh`:
```
GET  /health                              — Liveness check
POST /api/v1/session/start                — Start session: body {name, metadata}; returns {data: {sessionId}}
GET  /api/v1/status                       — Session status: header X-Session-ID; returns {data: {currentSession: {status}}}
POST /api/v1/memory/auto-recall           — Recall: body {query, limit, minScore}; header X-Session-ID
GET  /api/v1/search?query=...&limit=5     — Search: header X-Session-ID
POST /api/v1/knowledge/search             — Knowledge search: body {query, limit}; header X-Session-ID
POST /api/v1/context                      — Save context: body {key, value, category, priority}; header X-Session-ID
PUT  /api/v1/context/:key                 — Update context: body {value}; header X-Session-ID
```

Session cache path: `~/.ping-mem/sync-session-id` (plain text file containing session UUID)

---

## 10. Key Implementation Notes

1. **Always drain stdin** — even if you don't use it, hooks must read stdin or Claude Code may hang on large payloads. Use `INPUT=$(cat)` at the top.

2. **jq is required** — all existing hooks assume `jq` is available for JSON parsing. It is installed at `/usr/bin/jq` or `/opt/homebrew/bin/jq` on macOS.

3. **No stdout for pure observers** — if the hook only logs/captures data and doesn't need to inject context, produce no stdout and `exit 0`. Any unparseable stdout may generate warnings.

4. **Transcript path** — the `transcript_path` field in the payload points to a JSONL file containing the full conversation. This can be read to extract richer context (previous tool calls, assistant messages) for capture hooks.

5. **session_id is the Claude Code session UUID** — it is stable within one `claude` process invocation. It changes on `clear` but not on tool calls. Use it as the correlation key when linking events to sessions in ping-mem.

6. **stop_hook_active guard** — Stop hooks that block Claude must check `stop_hook_active` in the payload. When a Stop hook blocks, Claude tries to complete the task, then fires Stop again. `stop_hook_active: true` in the second firing means "you already blocked once." Without this guard, you can create infinite loops.

7. **Matcher regex is anchored to tool name only** — for PostToolUse, the matcher matches against `tool_name` (e.g., `"Bash"`, `"Write"`, `"mcp__memory__save"`). It does NOT match against tool input content. Content-based filtering must happen inside the hook script.

8. **HTTP hook Content-Type** — HTTP hooks always POST with `Content-Type: application/json`. The `Content-Type` header in the hook config does not need to be set explicitly but can be overridden.

9. **Env var interpolation in HTTP headers** — only works for headers, not the URL. Variables must be listed in `allowedEnvVars`. Unlisted variables resolve to empty string silently.

10. **SessionEnd vs Stop** — `Stop` fires after every response turn (Claude finishes one message). `SessionEnd` fires when the entire `claude` process exits. For capturing per-turn work, use `Stop`. For final cleanup, use `SessionEnd`.
