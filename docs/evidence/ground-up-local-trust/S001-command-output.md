# S001 Command Output Summary

Generated: 2026-04-30
Scope: sanitized command evidence for S001.

Sensitive values were not copied into this artifact. Local proxy-token contents, API keys, admin password values, and credential file contents were not read or were redacted. The required repo `rg` command was run as specified by the issue; the stored result below summarizes counts and key anchors instead of copying all 2,917 matching lines.

## Required Commands

### `git status --short --branch`

Exit: 0

```text
## main...origin/main
?? docs/architecture/
?? docs/issues/
?? docs/prds/
```

Interpretation: local rebuild package is untracked. Product code was not changed by S001.

### `git worktree list --porcelain`

Exit: 0

```text
worktree /Users/umasankr/Projects/ping-mem
HEAD e4f2919fa057d09b21823fd3a979317e91b2f0be
branch refs/heads/main
```

Interpretation: only the main checkout was present.

### Required repo text scan

Command run: the S001 verification `rg -n` command over `README.md CLAUDE.md AGENT_INSTRUCTIONS.md docs src/static scripts package.json`.

Exit: 0

```text
total matching lines: 2917
matching files: 167
```

Top matching files by count:

```text
171 docs/plans/2026-04-08-feat-client-reachability-reliability-plan.md
110 docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md
89 docs/plans/2026-03-16-feat-ping-mem-cli-rest-api-plan.md
82 docs/plans/2026-04-18-ping-mem-complete-remediation/phase-8-docs-handoff.md
82 docs/architecture/2026-04-29-ground-up-local-trust-rebuild.md
73 docs/ping-mem-consolidation-research/02-multi-client-config.md
72 docs/plans/2026-04-18-ping-mem-complete-remediation/phase-1-memory-sync-mcp-auth.md
70 README.md
62 docs/AGENT_INTEGRATION_GUIDE.md
57 docs/plans/2026-04-08-feat-capability-closure-plan.md
31 docs/INSTALLATION.md
27 scripts/install-client.sh
24 src/static/codebase-diagram.html
11 AGENT_INSTRUCTIONS.md
```

Key active anchors from the scan:

```text
package.json:9 direct MCP bin path
package.json:41 start:mcp direct mode
package.json:42 start:proxy proxy mode
scripts/agent-path-audit.sh:22 direct dist/mcp/cli.js check
scripts/install-client.sh:176 Cursor direct MCP config output
scripts/install-client.sh:203 Claude direct MCP config output
README.md:241 proxy-cli config example
README.md:252 direct MCP isolated-development warning
CLAUDE.md:10 session start without agentId
CLAUDE.md:23 direct MCP command
CLAUDE.md:68-69 proxy and direct transport notes
AGENT_INSTRUCTIONS.md:11-20 mandatory ping-mem workflow wording
docs/INSTALLATION.md:235-266 direct MCP mode
docs/AGENT_INTEGRATION_GUIDE.md:564-615 direct maintenance scripts
src/static/codebase-diagram.html:805 direct MCP command
src/static/codebase-diagram.html:821 force-ingest recovery path
```

### Process inventory

Command run:

```bash
ps -axo pid,ppid,command | rg 'Codex\.app|app-server|ping-mem/dist/mcp/proxy-cli|dist/mcp/proxy-cli|dist/mcp/cli'
```

Exit: 0

Key output:

```text
/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled
/Users/umasankr/.vscode/extensions/openai.chatgpt-.../codex app-server --analytics-default-enabled
22 processes matched /Users/umasankr/Projects/ping-mem/dist/mcp/proxy-cli.js
one additional node process matched /Users/umasankr/Projects/ping-mem/dist/mcp/proxy-cli.js
```

Proxy child PIDs observed:

```text
25901 48681 48867 62844 63027 63266 63492 63805 63978 71227 71426
76051 76357 77090 81679 83827 84267 86983 92728 92949 96923 11628
```

Interpretation: Codex static config cannot be treated as full quarantine proof while these proxy processes are live.

### LaunchAgent discovery

Command run:

```bash
find /Users/umasankr/Library/LaunchAgents -maxdepth 1 -name 'com.ping-mem*.plist' -print | sort
```

Exit: 0

```text
/Users/umasankr/Library/LaunchAgents/com.ping-mem.daemon.plist
/Users/umasankr/Library/LaunchAgents/com.ping-mem.doctor.plist
/Users/umasankr/Library/LaunchAgents/com.ping-mem.periodic-cognition.plist
/Users/umasankr/Library/LaunchAgents/com.ping-mem.periodic-ingest.plist
/Users/umasankr/Library/LaunchAgents/com.ping-mem.soak-monitor.plist
/Users/umasankr/Library/LaunchAgents/com.ping-mem.system-ready.plist
```

Launchctl summary:

```text
com.ping-mem.daemon: running, pid 25465, last exit code 0
com.ping-mem.doctor: not running, last exit code 2, StartInterval 900
com.ping-mem.periodic-cognition: not running, last exit code 0, StartInterval 86400
com.ping-mem.periodic-ingest: not running, last exit code 127, StartInterval 600
com.ping-mem.soak-monitor: not running, last exit code 0, StartInterval 86400
com.ping-mem.system-ready: not running, last exit code 1, StartInterval 300
```

Sanitized plist summary:

```text
daemon: /Users/umasankr/.bun/bin/bun run /Users/umasankr/Projects/ping-mem/dist/cli/index.js daemon start --foreground
doctor: cd /Users/umasankr/Projects/ping-mem && bun run dist/cli/index.js doctor --quiet, admin env keys present, credential value redacted
periodic-cognition: /Users/umasankr/Projects/ping-mem/scripts/periodic-cognition.sh, PING_MEM_ENV_FILE points at repo .env
periodic-ingest: /Users/umasankr/Projects/ping-mem/scripts/periodic-ingest.sh, script missing in this checkout
soak-monitor: /Users/umasankr/Projects/ping-mem/scripts/soak-monitor.sh
system-ready: /Users/umasankr/Projects/ping-mem/scripts/system-ready.ts --touch-heartbeat, admin env keys present, credential value redacted, script missing in this checkout
```

Missing target checks:

```text
test -f scripts/periodic-ingest.sh -> missing
test -f scripts/system-ready.ts -> missing
ls found dist/cli/index.js, dist/mcp/cli.js, dist/mcp/proxy-cli.js, scripts/periodic-cognition.sh, scripts/soak-monitor.sh
```

### Codex static config

Command run:

```bash
rg -n 'ping-mem|mcp_servers|codebase_|context_|hook|Stop|PostToolUse|PreToolUse' /Users/umasankr/.codex/config.toml /Users/umasankr/.codex/AGENTS.md
```

Exit: 0

Key output:

```text
/Users/umasankr/.codex/config.toml:17:[mcp_servers.context7]
/Users/umasankr/.codex/config.toml:20:[mcp_servers.pencil]
/Users/umasankr/.codex/config.toml:30:[projects."/Users/umasankr/Projects/ping-mem"]
/Users/umasankr/.codex/AGENTS.md:25:do not use ping-mem/codebase tools for grounding unless re-enabled
/Users/umasankr/.codex/AGENTS.md:37:do not use ping-mem as memory fallback unless re-enabled
```

Interpretation: no static Codex ping-mem MCP server was configured, but live proxy process evidence still blocks a full quarantine claim.

### Claude Code config and hook surfaces

Commands inspected:

```bash
nl -ba /Users/umasankr/.claude/mcp.json
nl -ba /Users/umasankr/.claude/settings.json
nl -ba /Users/umasankr/.claude/settings.local.json
nl -ba /Users/umasankr/.claude/hooks.json
nl -ba /Users/umasankr/.claude/scripts/hooks/ping-mem-session-init.sh
rg -n 'ping-mem|dist/mcp|proxy-cli|context_session_start|codebase_|PING_MEM|neo4j|mcpServers|hooks|PostToolUse|PreToolUse|Stop|UserPromptSubmit' /Users/umasankr/.claude/mcp.json /Users/umasankr/.claude/settings.json /Users/umasankr/.claude/settings.local.json /Users/umasankr/.claude/hooks.json /Users/umasankr/.claude/ping-mem-agent-workflow.md
```

Exit: 0

Key output:

```text
/Users/umasankr/.claude/mcp.json: mcpServers is empty
/Users/umasankr/.claude/settings.json: mcpServers is empty
/Users/umasankr/.claude/settings.json: active hooks exist for SessionStart, PreToolUse, PostToolUse, Stop, Notification
/Users/umasankr/.claude/settings.json: no active ping-mem hook command found
/Users/umasankr/.claude/hooks.json: legacy hooks exist, no ping-mem hook registration found
/Users/umasankr/.claude/ping-mem-agent-workflow.md: mandatory ping-mem workflow and direct MCP config examples still present
/Users/umasankr/.claude/scripts/hooks/ping-mem-session-init.sh: existing unregistered hook file can call /health and POST /api/v1/codebase/ingest
```

Note: `/Users/umasankr/.claude/settings.json` contains unrelated plugin settings. Secret-like values were not copied into this artifact.

### Runtime health and Docker/OrbStack

Commands run:

```bash
curl -sS -m 3 http://localhost:3003/health
lsof -nP -iTCP:3003 -sTCP:LISTEN
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | rg 'ping-mem|neo4j|qdrant'
docker volume ls --format '{{.Name}}' | rg 'ping-mem|qdrant|neo4j'
```

Outputs:

```text
curl: Failed to connect to localhost port 3003
lsof: no listener on TCP 3003
docker ps: failed to connect to unix:///Users/umasankr/.orbstack/run/docker.sock; no such file or directory
docker volume ls: failed to connect to unix:///Users/umasankr/.orbstack/run/docker.sock; no such file or directory
```

Interpretation: live REST/runtime and Docker-backed service status are blocked/unavailable in this shell. S001 did not repair or restart anything.

### Repo code anchors

Commands inspected targeted source anchors for seeded offenders:

```text
package.json: bin/scripts expose ping-mem, ping-mem-mcp, start:mcp, start:proxy
src/mcp/proxy-cli.ts: tryStartDocker and proxyToolCall forwarding behavior
src/cli/commands/session.ts: session start args
src/cli/client.ts: thin CLI headers
src/cli/commands/codebase.ts: codebase projects call
src/http/rest-server.ts: codebase routes and currentSessionId fallback
src/client/rest-client.ts: X-Session-ID support exists in SDK
src/http/ui/routes.ts and src/http/ui/layout.ts: 15 UI route labels
src/http/ui/ingestion.ts and src/http/ui/partials/ingestion.ts: host registered-projects reads
src/doctor/gates/service.ts: service.mcp-proxy-stdio gate checks direct binary/path
```

Selected direct excerpts:

```text
src/cli/commands/session.ts: start command args include name, projectDir, autoIngest; no start-time agentId
src/cli/client.ts: headers include Content-Type and optional Authorization only; no X-Session-ID
src/cli/commands/codebase.ts: projects command calls /api/v1/codebase/projects without scope
src/http/rest-server.ts: /api/v1/codebase/ingest, verify, search, timeline, projects routes exist
src/http/rest-server.ts: getSessionIdFromRequest falls back to currentSessionId
src/client/rest-client.ts: REST SDK appends X-Session-ID when currentSessionId is set
```

### UI/static surface inventory

Command run:

```bash
rg --files src/http/ui src/static | sort
```

Exit: 0

Summary:

```text
UI source files found for dashboard, memories, diagnostics, ingestion, agents, knowledge, sessions, events, worklog, codebase, eval, insights, mining, profile, health.
Static files found: chart.umd.min.js, chat.js, codebase-diagram.html, htmx.min.js, styles.css.
src/http/ui/layout.ts lists 15 route labels.
src/static/codebase-diagram.html contains direct MCP and force-ingest guidance.
```

### Data path inventory

Command run:

```bash
find /Users/umasankr/.ping-mem -maxdepth 2 -type f -print | sort
ls -la /Users/umasankr/.ping-mem
```

Exit: 0

Summary:

```text
Host data path contains multiple DB and WAL files, including ping-mem.db, ping-mem-admin.db, ping-mem-diagnostics.db, ping-mem-bm25.db, shared.db, diagnostics.db, claude-code.db, codex.db, archived-host-dbs, backups, doctor-runs, registered-projects.txt, system-ready.json, system-heartbeat, sync-heartbeat, local-proxy-token.
local-proxy-token exists and was not read.
registered-projects.txt exists as host-side registry evidence only.
```

### Compose/service declarations

Command run:

```bash
rg -n 'ping-mem|neo4j|qdrant|volumes|ports|3003|6333|7474|7687|ping-mem-data' docker-compose.yml docker-compose.*.yml
```

Exit: 0

Key output:

```text
docker-compose.yml declares ping-mem-neo4j, ping-mem-qdrant, and ping-mem services.
docker-compose.yml maps ping-mem to port 3003.
docker-compose.yml bind-mounts /Users/umasankr/.ping-mem to /data.
docker-compose.prod.yml uses named volumes for prod/deferred service shape.
```

### Shell startup integration

Command run:

```bash
rg -n 'ping-mem|dist/mcp|proxy-cli|codebase_|context_session_start|PING_MEM' /Users/umasankr/.zshrc /Users/umasankr/.zprofile /Users/umasankr/.bashrc /Users/umasankr/.bash_profile 2>/dev/null
```

Exit: 2 because some profile files were absent; `.zshrc` matches were returned.

Key output:

```text
/Users/umasankr/.zshrc:101:# ping-mem shell integration
/Users/umasankr/.zshrc:102:if command -v bun ... dist/cli/index.js
/Users/umasankr/.zshrc:103:eval "$(bun run /Users/umasankr/Projects/ping-mem/dist/cli/index.js shell-hook zsh 2>/dev/null)"
```

Interpretation: shell startup remains an active ping-mem surface and is blocked from trust/re-adoption proof until reconciled.

## Verification Result

S001 acceptance result:

```text
current discovered surfaces: 78 / 78 classified
seeded offenders: 36 / 36 classified
overall: 114 / 114 classified
```

No product code, agent config, LaunchAgent, GitHub issue, or ping-mem re-adoption change was made.
