# Claude Code Session Transcript Format

**Date**: 2026-03-22 | **Source**: Analysis of 3 representative .jsonl files

## Overview
- **Total .jsonl files**: 251 main sessions + 6,217 subagent sessions = 6,468 total
- **Total size**: ~3.4GB across all projects
- **Total lines**: ~521,329
- **Date range**: Feb 20, 2026 — Mar 22, 2026
- **Location**: `~/.claude/projects/<project-path>/<session-uuid>.jsonl`

## JSON Structure

Each line is newline-delimited JSON. Key message types:

### User Messages (`type: "user"`)
```json
{
  "type": "user",
  "message": { "role": "user", "content": "[user's text]" },
  "timestamp": "ISO 8601",
  "sessionId": "UUID",
  "cwd": "/path/to/project"
}
```
**Extract text from**: `message.content`

### Assistant Messages (`type: "assistant"`)
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "model": "claude-opus-4-6",
    "content": [
      { "type": "thinking", "thinking": "[reasoning]" },
      { "type": "text", "text": "[response]" },
      { "type": "tool_use", "name": "Read", "input": {...} }
    ],
    "usage": { "input_tokens": N, "output_tokens": N }
  }
}
```

### Progress Messages (`type: "progress"`) — ~88% of lines
Hook events, command execution. Low value for mining.

### System Messages (`type: "system"`)
Turn duration, session metadata.

## What to Extract for Mining

**High value** (user messages):
- Corrections: "don't do X", "always do Y", "no, use Z instead"
- Preferences: "I prefer...", "quality first", style choices
- Project decisions: architecture choices, tech stack selections
- Workflow patterns: repeated tool sequences, common commands

**Medium value** (assistant messages):
- What was accepted without pushback (implicit approval)
- Error patterns and their solutions
- Tool usage patterns per project

**Low value** (skip):
- Progress/hook messages (88% of content)
- File history snapshots
- Queue operations

## Filtering Strategy

For a 3.4GB corpus, filtering to user messages only reduces to ~50-100MB of actual content. Apply:
1. `type == "user"` filter → extract `message.content`
2. Skip lines with `isSidechain: true` (subagent internal)
3. Group by `sessionId` for conversation context
4. Sort by `timestamp` within session

## Project Distribution
- ping-learn: 85 sessions
- u-os: 39 sessions
- ping-mem: 29 sessions
- ping-learn-mobile: 29 sessions
- understory: 21 sessions
- Others: < 21 each
