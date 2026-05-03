# S011 Active Surface Ledger

## Outcome

S011 is complete for repo-owned active instructions, active operator quick-start docs, and active static UI. Machine-local user instruction/config surfaces were inventoried but not edited; they remain blocked for S015 re-adoption approval.

## Active Surfaces Corrected

| Surface | Previous risk | S011 disposition |
|---|---|---|
| `CLAUDE.md` | Told Claude Code to start sessions and listed direct MCP stdio as a dev command. Included default local admin credentials. | Replaced with REST-only `agent ... --json` proof commands. Direct/proxy MCP are quarantined until S015/S016. |
| `AGENT_INSTRUCTIONS.md` | Mandated ping-mem-first grounding and direct MCP config. | Quarantined the whole quick-start as not approved for onboarding. Direct repo evidence is now required before S015. |
| `README.md` Claude Code integration | Told operators to add ping-mem back to `~/.claude/mcp.json` with sample default credentials. | Replaced with S015-gated re-adoption language and placeholder credential names. |
| `src/static/codebase-diagram.html` | Active static UI taught direct MCP, host registered-project file edits, and `force-ingest.ts` recovery. | Replaced with REST-only CLI proof, runtime registry endpoint, and blocked/unproven states. |

## Pattern Scan

Command:

```bash
rg -n 'direct-ingest|force-ingest|reindex-qdrant|dist/mcp/cli|ping-mem-mcp|neo4j_password|ping-mem-dev-local|use ping-mem first|ping-mem-first' README.md CLAUDE.md AGENT_INSTRUCTIONS.md docs src/static scripts package.json
```

Remaining matches are classified below. There are zero active unclassified matches.

| Match group | Classification | Rationale / owner |
|---|---|---|
| `package.json` `ping-mem-mcp`, `start:mcp` | `offline-dev-only` | Direct MCP exists but cannot count for acceptance or re-adoption. S016 owns optional later adapter proof. |
| `README.md` `dist/mcp/cli.js` | `offline-dev-only` | The remaining mention explicitly says isolated direct-mode development only. |
| `scripts/direct-ingest.ts`, `scripts/force-ingest.ts`, `scripts/reindex-qdrant.ts`, `scripts/migrate-from-memory-keeper.ts` | `offline-dev-only` | Direct maintenance scripts are not accepted for agent proof, recovery proof, or re-adoption proof. S012 owns recovery hygiene if any script must become active. |
| `scripts/install-client.sh`, `scripts/setup.sh` | `blocked-for-S015` | These can write user/client integration config and still contain direct MCP examples. Not edited in S011 because config/re-adoption writes are explicitly gated. |
| `scripts/agent-path-audit.sh`, `scripts/test-all-capabilities.sh`, `scripts/seed-regression-fixtures.sh` default admin fallback strings | `blocked-for-S009/S014` | These are proof/status/failure-state surfaces. S009/S014 own failure-state honesty and observability alignment. |
| `scripts/backup.sh`, `scripts/restore.sh` Neo4j password literals | `blocked-for-S012` | Recovery scripts need LaunchAgent/recovery approval hygiene in S012. |
| `docs/issues/**`, `docs/evidence/**`, `docs/architecture/2026-04-29-ground-up-local-trust-rebuild.md` | `current-rebuild-record` | These intentionally record the stale patterns and their issue ownership. |
| `docs/AGENT_INTEGRATION_GUIDE.md`, `docs/INSTALLATION.md`, `docs/DEPLOYMENT_ARCHITECTURE.md`, `docs/IMPLEMENTATION_*.md`, `docs/VERIFICATION_2026-01-29.md`, `docs/BUG_FIXES_2026-01-29.md`, `docs/claude/**` | `historical-or-reference` | These are not the active S011-approved operator path. Rewriting the broader archive is out of S011 scope. |
| `docs/plans/**`, `docs/research/**`, `docs/ping-mem-*research/**`, `docs/continuation-packages/**` | `historical-or-planning` | These preserve prior analysis/plans and are not active operator instructions. |

## User-Level Instruction Inventory

Command:

```bash
rg -n 'ping-mem|dist/mcp/cli|dist/mcp/proxy-cli|codebase_verify|codebase_ingest|codebase_search|context_session_start|PING_MEM_REST_URL|PING_MEM_ADMIN_PASS' /Users/umasankr/.codex /Users/umasankr/.claude
```

Classification:

| Surface | Classification | Rationale |
|---|---|---|
| `/Users/umasankr/.codex/config.toml` | `no-ping-mem-mcp-active` | Current scan showed project entries but no active ping-mem MCP block. |
| `/Users/umasankr/.codex/hooks.json` | `approved-stop-hook-restored` | Stop hook restoration was explicitly requested by the user; it runs execution-loop status only. |
| `/Users/umasankr/.codex/memories/**` | `memory-reference-only` | Memory files are not active ping-mem integration config. |
| `/Users/umasankr/.codex/skills/ping-mem-run/**` | `blocked-until-rebuild-or-explicit-use` | Existing local recovery skill still contains old live validation/admin examples; not edited in S011 because user-level skill changes need separate approval. |
| `/Users/umasankr/.claude/*.bak`, `/Users/umasankr/.claude/teams/**`, `/Users/umasankr/.claude/logs/**` | `historical-backup-or-log` | Backups, team inboxes, and logs are not active re-adoption config. |
| `/Users/umasankr/.claude/settings*.bak` | `historical-backup` | Backup hook settings only; not edited. |

## Verification

```bash
bun test src/http/ui
bun run typecheck
```

Results:

- `bun test src/http/ui`: `59 pass`, `0 fail`.
- `bun run typecheck`: passed.

## Allowed Claim

Allowed: repo-owned active quick-start instructions and active static UI no longer tell agents or the founder to use direct MCP, default credentials, hidden hooks, direct scripts, or ping-mem-first grounding before proof.

Blocked: user-level config/skill cleanup and re-adoption. Those remain S015/S016 work.
