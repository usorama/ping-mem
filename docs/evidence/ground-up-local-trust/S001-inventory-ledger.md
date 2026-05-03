# S001 Inventory And Quarantine Ledger

Generated: 2026-04-30
Issue: `S001-phase-0-inventory-and-quarantine-ledger.md`
Scope: read-only inventory and classification for the ping-mem ground-up local trust rebuild.

## Summary

This ledger does not re-enable ping-mem and does not treat ping-mem MCP/codebase tools as a grounding source. It classifies current repo, machine, process, config, doc, UI, script, LaunchAgent, and data-path evidence from direct shell/file/runtime checks.

Classification vocabulary: `quarantined`, `approved-test-only`, `approved-re-adoption`, `offline-dev-only`, `historical`, `blocked`, `out-of-scope`.

Population denominator:

| Population | Count | Classified | Result |
|---|---:|---:|---|
| Current discovered surface rows | 78 | 78 | `78 / 78 == 1.0` |
| Seeded offender rows from architecture/COVERAGE | 36 | 36 | `36 / 36 == 1.0` |
| Total S001 ledger rows | 114 | 114 | `114 / 114 == 1.0` |

Broad text scan note: the required repo text scan found 2,917 matching lines across 167 files. Those raw line hits are represented below as active control-plane rows, active operator-doc/static-UI rows, current issue-package rows, and historical-doc corpus rows. S011/S014 own correction of active docs/UI; S001 only inventories and classifies.

No row is `approved-re-adoption`. Re-adoption remains blocked until later issues prove the CLI-first path and acceptance gates.

## Current Discovered Surfaces

| ID | Surface / item | Evidence command or anchor | Classification | Disposition |
|---|---|---|---|---|
| C001 | Main checkout state | `git status --short --branch` | approved-test-only | Evidence only. Current checkout is `main`; rebuild docs/issues are untracked/local package inputs. |
| C002 | Worktree state | `git worktree list --porcelain` | approved-test-only | Main checkout only. No S001 worktree was created because this is evidence/docs-only. |
| C003 | Graphify architecture aid | `graphify-out/GRAPH_REPORT.md` | approved-test-only | Navigation aid only. It reported core abstractions such as `PingMemSDK`, `EventStore`, `registerUIRoutes()`, `MemoryManager`, `RESTPingMemServer`, and `HybridSearchEngine`; all claims were verified against files/commands. |
| C004 | Codex static MCP config | `/Users/umasankr/.codex/config.toml` | quarantined | Static config lists Context7 and Pencil only. No `[mcp_servers.ping-mem]` entry was present. |
| C005 | Codex project trust config | `/Users/umasankr/.codex/config.toml:30-31` | out-of-scope | Trust entry is not a ping-mem adapter or memory path. |
| C006 | Codex root instructions | `/Users/umasankr/.codex/AGENTS.md` | approved-test-only | Current instructions forbid ping-mem/codebase grounding unless explicitly re-enabled. |
| C007 | Live Codex app-server process | `ps -axo pid,ppid,command` | approved-test-only | Codex app-server is live; not itself a ping-mem adapter. |
| C008 | Live Codex proxy child processes | `ps ... | rg 'dist/mcp/proxy-cli.js'` | blocked | 22 live proxy-cli children were observed. Static config absence is not enough to claim quarantine. |
| C009 | Non-Codex/node proxy child | `ps ... | rg 'node ... dist/mcp/proxy-cli.js'` | blocked | A node process for `dist/mcp/proxy-cli.js` was observed. Owner/process source needs later cleanup/disposition. |
| C010 | REST `/health` runtime | `curl -sS -m 3 http://localhost:3003/health` | blocked | Connection failed. Runtime health is not available. |
| C011 | TCP listener on 3003 | `lsof -nP -iTCP:3003 -sTCP:LISTEN` | blocked | No listener was found. |
| C012 | Docker/OrbStack container inventory | `docker ps ...` | blocked | Docker API was unreachable at the OrbStack socket. No repair attempted. |
| C013 | Docker volume inventory | `docker volume ls ...` | blocked | Docker API was unreachable at the OrbStack socket. No repair attempted. |
| C014 | LaunchAgent `com.ping-mem.daemon` | `launchctl print gui/$(id -u)/com.ping-mem.daemon` | blocked | Running PID 25465, `KeepAlive=true`, starts `dist/cli/index.js daemon start --foreground`. Active automation cannot count as proof until S012/S014 reconcile it. |
| C015 | LaunchAgent `com.ping-mem.doctor` | `launchctl print gui/$(id -u)/com.ping-mem.doctor` | blocked | Enabled, not running during check, last exit code 2, embeds admin env keys. Credential value redacted in evidence. |
| C016 | LaunchAgent `com.ping-mem.periodic-cognition` | `launchctl print gui/$(id -u)/com.ping-mem.periodic-cognition` | blocked | Enabled, uses repo script plus `.env`, can create hidden work/state during proof. |
| C017 | LaunchAgent `com.ping-mem.periodic-ingest` | `launchctl print gui/$(id -u)/com.ping-mem.periodic-ingest` | blocked | Enabled, not running, last exit code 127, points at missing `scripts/periodic-ingest.sh`. |
| C018 | LaunchAgent `com.ping-mem.soak-monitor` | `launchctl print gui/$(id -u)/com.ping-mem.soak-monitor` | blocked | Enabled status/rollup automation; must be reconciled before status proof can count. |
| C019 | LaunchAgent `com.ping-mem.system-ready` | `launchctl print gui/$(id -u)/com.ping-mem.system-ready` | blocked | Enabled, last exit code 1, points at missing `scripts/system-ready.ts`, embeds admin env keys. Credential value redacted in evidence. |
| C020 | LaunchAgent plist set | `find ~/Library/LaunchAgents -name 'com.ping-mem*.plist'` | blocked | Six machine-local ping-mem plists exist and are owned by S012/S014 for reconciliation. |
| C021 | Host data path `/Users/umasankr/.ping-mem` | `find /Users/umasankr/.ping-mem -maxdepth 2 -type f` | blocked | Multiple host DB/WAL/state files exist. They are not accepted as runtime truth for the rebuild. |
| C022 | Local proxy token file | `ls -la /Users/umasankr/.ping-mem` | quarantined | `local-proxy-token` exists as a machine-local secret file. Value was not read or copied. |
| C023 | Host registered-projects file | `find /Users/umasankr/.ping-mem ... registered-projects.txt` | blocked | Host-side registry file exists but cannot count as runtime registry proof. |
| C024 | Host doctor/system-ready state files | `find /Users/umasankr/.ping-mem ... doctor-runs system-ready.json` | approved-test-only | Existing state/log files may guide later analysis, but do not prove product trust. |
| C025 | Local docker-compose ping-mem service | `rg -n 'ping-mem|3003|volumes' docker-compose.yml` | blocked | Compose defines service, but Docker API/runtime is unavailable in this check. |
| C026 | Local Neo4j/Qdrant services | `rg -n 'neo4j|qdrant|7474|7687|6333' docker-compose.yml` | blocked | Services are declared, but live status could not be verified because Docker API was unavailable. |
| C027 | Local compose host bind mount | `docker-compose.yml:92-93` | blocked | Local compose bind-mounts `/Users/umasankr/.ping-mem:/data`, which is a runtime/data ownership risk for S002/S010. |
| C028 | Prod compose named volumes | `docker-compose.prod.yml` | out-of-scope | VPS/prod is deferred by the PRD. |
| C029 | CLI binary `ping-mem` | `package.json:7-10` | approved-test-only | Existing CLI may be used for implementation tests, but is not the approved trust spine yet. |
| C030 | Direct MCP binary `ping-mem-mcp` | `package.json:7-10` | offline-dev-only | Direct MCP cannot count for re-adoption or acceptance. |
| C031 | HTTP binary `ping-mem-http` | `package.json:7-10` | approved-test-only | Runtime entrypoint candidate only; live server was not reachable. |
| C032 | Script `start:mcp` | `package.json:41` | offline-dev-only | Direct MCP mode only. |
| C033 | Script `start:proxy` | `package.json:42` | quarantined | Optional later adapter; blocked from re-adoption until identity/auth/no-auto-repair proof exists. |
| C034 | Built proxy CLI | `ls -l dist/mcp/proxy-cli.js` | quarantined | File exists and is actively spawned, but is not approved for trust/re-adoption. |
| C035 | Built direct MCP CLI | `ls -l dist/mcp/cli.js` | offline-dev-only | File exists; direct mode only. |
| C036 | Built CLI index | `ls -l dist/cli/index.js` | approved-test-only | File exists; current CLI gaps still block trust spine use. |
| C037 | Proxy auto-repair path | `src/mcp/proxy-cli.ts:68`, `:228` | blocked | Proxy startup calls Docker startup behavior; read-only proof must not repair. |
| C038 | Proxy identity forwarding | `src/mcp/proxy-cli.ts:110-133`, `:217-218` | blocked | Proxy forwards `{ args }`; no approved proof that agent/project/session identity is enforced. |
| C039 | `scripts/direct-ingest.ts` | `rg -n ... scripts/direct-ingest.ts` | offline-dev-only | Direct Neo4j/Qdrant/IngestionService path; not allowed in acceptance/re-adoption proof. |
| C040 | `scripts/force-ingest.ts` | `rg -n ... scripts/force-ingest.ts` | offline-dev-only | Direct IngestionService path; not allowed in acceptance/re-adoption proof. |
| C041 | `scripts/reindex-qdrant.ts` | `rg -n ... scripts/reindex-qdrant.ts` | offline-dev-only | Direct Qdrant reindex path; not allowed in acceptance/re-adoption proof. |
| C042 | `scripts/migrate-from-memory-keeper.ts` | `rg -n ... scripts/migrate-from-memory-keeper.ts` | offline-dev-only | Direct EventStore path; not allowed in live agent proof. |
| C043 | `scripts/agent-path-audit.sh` | `scripts/agent-path-audit.sh:22,37` | blocked | Uses `dist/mcp/cli.js`, so it can green-light direct mode. |
| C044 | Doctor `service.mcp-proxy-stdio` gate | `src/doctor/gates/service.ts:78-93` | blocked | Gate checks direct binary/path presence, not approved proxy readiness. |
| C045 | Default-admin proof helpers | `scripts/agent-path-audit.sh`, `scripts/test-all-capabilities.sh` | blocked | Scripts default to a known admin password string; values redacted from this artifact. |
| C046 | Regression fixture helper | `scripts/seed-regression-fixtures.sh:7` | blocked | Defaults to known admin password string; not secret-safe acceptance proof. |
| C047 | Installer Cursor config output | `scripts/install-client.sh:171-184` | blocked | Emits direct MCP config; not allowed for re-adoption. |
| C048 | Installer Claude config output | `scripts/install-client.sh:201-210` | blocked | Emits direct MCP config; not allowed for re-adoption. |
| C049 | CLI session start identity | `src/cli/commands/session.ts:10-27` | blocked | Start accepts `projectDir` and `autoIngest`; no start-time `agentId`. |
| C050 | CLI thin client session header | `src/cli/client.ts:26-34` | blocked | Thin client has no `X-Session-ID` support. |
| C051 | CLI context session identity | `src/cli/commands/context.ts` | blocked | Commands pass `sessionId` as mixed body/query data instead of a normalized approved identity contract. |
| C052 | CLI codebase project scope | `src/cli/commands/codebase.ts:90` | blocked | `projects` does not expose `scope=registered`. |
| C053 | REST codebase routes | `src/http/rest-server.ts:1235,1327,1350,1385,3567` | approved-test-only | Routes exist, but runtime is down and identity/path-safety proof is not complete. |
| C054 | REST session fallback | `src/http/rest-server.ts:4101-4148` | blocked | `currentSessionId` fallback can hide cross-talk; approved paths must not rely on it. |
| C055 | REST SDK session header support | `src/client/rest-client.ts:203-237` | approved-test-only | Existing SDK pattern is a candidate implementation substrate, not proof by itself. |
| C056 | UI routes | `src/http/ui/layout.ts:31-58`, `src/http/ui/routes.ts:56-176` | approved-test-only | 15 UI route labels exist; truthful status alignment is later S010/S014 work. |
| C057 | UI ingestion registered projects | `src/http/ui/ingestion.ts:26`, `src/http/ui/partials/ingestion.ts:79` | blocked | Reads host `~/.ping-mem/registered-projects.txt`; not runtime truth. |
| C058 | Static codebase diagram | `src/static/codebase-diagram.html` | blocked | Active static UI teaches direct MCP/force-ingest recovery paths. |
| C059 | Root `README.md` | Required repo `rg` command | blocked | Active doc still exposes/teaches ping-mem paths and default credential examples; S011 owns correction/quarantine. |
| C060 | Root `CLAUDE.md` | `CLAUDE.md:10,23,32,68-69` | blocked | Active root instruction teaches no-agentId session start, direct MCP, proxy credential examples. |
| C061 | Root `AGENT_INSTRUCTIONS.md` | `AGENT_INSTRUCTIONS.md:11-20,201-209` | blocked | Active root instruction still mandates ping-mem-first and direct MCP config examples. |
| C062 | `docs/INSTALLATION.md` | `docs/INSTALLATION.md:235-266` | blocked | Active operator doc teaches direct MCP mode. |
| C063 | `docs/AGENT_INTEGRATION_GUIDE.md` | `docs/AGENT_INTEGRATION_GUIDE.md` matching rows | blocked | Active operator doc contains direct-mode, maintenance-script, and credential examples. |
| C064 | Broad repo text-scan corpus | Required repo `rg` command | blocked | 2,917 hits across 167 files; active hits are blocked, stale/historical docs are separated below. |
| C065 | Historical plan/research/remediation docs | Required repo `rg` command file counts | historical | Older plans/research are not current operator truth; they must not be used for re-adoption proof. |
| C066 | Current PRD/architecture/issue package | `docs/prds`, `docs/architecture`, `docs/issues/2026-04-29-ground-up-local-trust-rebuild` | approved-test-only | Current rebuild contract and evidence targets only. |
| C067 | Claude `mcp.json` | `/Users/umasankr/.claude/mcp.json:1-3` | quarantined | `mcpServers` is empty. |
| C068 | Claude `settings.json` MCP config | `/Users/umasankr/.claude/settings.json:229` | quarantined | `mcpServers` is empty. |
| C069 | Claude active hooks in `settings.json` | `/Users/umasankr/.claude/settings.json:48-176` | quarantined | No active ping-mem hook command found in current settings. |
| C070 | Claude legacy `hooks.json` | `/Users/umasankr/.claude/hooks.json:1-28` | quarantined | Contains legacy hooks, but no ping-mem hook registration. |
| C071 | User-level Claude ping-mem workflow | `/Users/umasankr/.claude/ping-mem-agent-workflow.md` | blocked | Still says ping-mem workflow is mandatory and teaches direct MCP config. |
| C072 | User-level Claude ping-mem hook script | `/Users/umasankr/.claude/scripts/hooks/ping-mem-session-init.sh` | quarantined | File exists and can trigger ingest, but is not registered in current active settings. |
| C073 | Claude native memory/topic docs mentioning ping-mem as primary | `rg` over `/Users/umasankr/.claude` | blocked | User-level memory surfaces can re-poison Claude behavior; S011/S015 must reconcile active ones before re-adoption. |
| C074 | Claude archive/backup skill/docs mentioning ping-mem | `rg` over `/Users/umasankr/.claude` | historical | Archived/backup material is historical and should not drive current re-adoption. |
| C075 | Shell startup integration | `rg -n ... /Users/umasankr/.zshrc` | blocked | `.zshrc` still evals `ping-mem` shell-hook when `dist/cli/index.js` exists. |
| C076 | Codex ambient/memory suggestion material | `rg` over `/Users/umasankr/.codex` | historical | Ambient suggestions and memories are leads only, not accepted proof or active adapter config. |
| C077 | Repo `state.md` old green story | `state.md` | historical | Older green status is not accepted as current product trust proof. |
| C078 | Repo `agents.md` old wave guide | `agents.md` | historical | Useful context, but current ground-up rebuild package supersedes it for execution. |

## Seeded Offender Classification

`offline-maintenance-only` from the architecture is represented with the allowed S001 classification `offline-dev-only`.

| ID | Seed offender / risk | Evidence command or anchor | Classification | Disposition |
|---|---|---|---|---|
| O001 | `ping-mem-mcp` binary points at direct MCP | `package.json:9` | offline-dev-only | Direct DB/MCP mode cannot count toward acceptance or re-adoption. |
| O002 | `start:mcp` runs direct MCP mode | `package.json:41` | offline-dev-only | Direct MCP only. |
| O003 | `start:proxy` runs proxy mode | `package.json:42` | quarantined | Candidate optional adapter after CLI proof, not approved now. |
| O004 | Live Codex proxy children despite static config | `ps ... dist/mcp/proxy-cli.js` | blocked | 22 live children observed. Must be stopped, classified further, or explained before quarantine/re-adoption claims. |
| O005 | `direct-ingest.ts` bypasses REST owner | `scripts/direct-ingest.ts:13-55` | offline-dev-only | Direct Neo4j/Qdrant/IngestionService path. |
| O006 | `force-ingest.ts` bypasses REST owner | `scripts/force-ingest.ts:5-24` | offline-dev-only | Direct IngestionService path. |
| O007 | `reindex-qdrant.ts` bypasses REST owner | `scripts/reindex-qdrant.ts:6-30` | offline-dev-only | Direct Qdrant path. |
| O008 | `migrate-from-memory-keeper.ts` opens EventStore directly | `scripts/migrate-from-memory-keeper.ts:20-66` | offline-dev-only | Direct EventStore path. |
| O009 | Installer writes Cursor direct MCP config | `scripts/install-client.sh:171-184` | blocked | Re-adoption installer output must be replaced or guarded. |
| O010 | Installer writes Claude direct MCP config | `scripts/install-client.sh:201-210` | blocked | Re-adoption installer output must be replaced or guarded. |
| O011 | Existing agent audit uses direct MCP | `scripts/agent-path-audit.sh:22,37` | blocked | Cannot be used as acceptance proof as-is. |
| O012 | CLI session start lacks `agentId` | `src/cli/commands/session.ts:10-27` | blocked | S003/S004 must add approved identity contract. |
| O013 | Thin CLI client lacks `X-Session-ID` support | `src/cli/client.ts:26-34` | blocked | S003/S004 must normalize session identity. |
| O014 | Context CLI passes `sessionId` inconsistently | `src/cli/commands/context.ts` | blocked | S003/S004 must normalize identity transport. |
| O015 | Codebase CLI projects lacks registered scope | `src/cli/commands/codebase.ts:90` | blocked | S010/S007/S008 must expose runtime registered-project proof. |
| O016 | REST codebase verify path-safety parity gap | `src/http/rest-server.ts:1327-1344`, `src/mcp/handlers/CodebaseToolModule.ts` | blocked | S004/S007/S008 own parity proof. |
| O017 | Installation docs teach direct MCP | `docs/INSTALLATION.md:235-266` | blocked | S011 owns correction/quarantine. |
| O018 | Agent integration docs contain stale/default credential examples | `docs/AGENT_INTEGRATION_GUIDE.md` | blocked | S011/S014 own correction/quarantine. |
| O019 | Agent integration docs teach blocked maintenance scripts | `docs/AGENT_INTEGRATION_GUIDE.md:564-615` | blocked | S011/S014 own correction/quarantine. |
| O020 | Static diagram teaches direct MCP / force-ingest recovery | `src/static/codebase-diagram.html` | blocked | S011/S014 own correction/quarantine. |
| O021 | Other committed docs/runbooks teach blocked paths/default credentials | Required repo `rg` command | blocked | S001 denominator captured active vs historical buckets; S011/S014 own active fixes. |
| O022 | UI ingestion reads host registered-projects file | `src/http/ui/ingestion.ts:26` | blocked | S010 owns runtime registry alignment. |
| O023 | UI reingest authorization reads host registered-projects file | `src/http/ui/partials/ingestion.ts:79` | blocked | S010 owns runtime registry alignment. |
| O024 | Scripts default to known admin credential | `scripts/agent-path-audit.sh`, `scripts/test-all-capabilities.sh`, `scripts/seed-regression-fixtures.sh` | blocked | Acceptance proof must refuse committed/default credentials. |
| O025 | Proxy auto-starts Docker | `src/mcp/proxy-cli.ts:68,228` | blocked | S003/S009/S016 must put repair behind explicit mode. |
| O026 | Live daemon LaunchAgent starts ping-mem daemon | `com.ping-mem.daemon.plist`, `launchctl print` | blocked | S012 must classify runtime automation, logs, write behavior, rollback. |
| O027 | Live doctor LaunchAgent embeds admin env keys | `com.ping-mem.doctor.plist`, `launchctl print` | blocked | S012/S014 must move to secret-safe pattern or disable before acceptance. |
| O028 | Live periodic-cognition LaunchAgent | `com.ping-mem.periodic-cognition.plist` | blocked | S012 must bound hidden writes and `.env` dependency. |
| O029 | Live periodic-ingest LaunchAgent points at missing clean-main script | `com.ping-mem.periodic-ingest.plist`; `test -f scripts/periodic-ingest.sh` | blocked | Last exit 127; S012 owns repair/disable/classification. |
| O030 | Live soak-monitor LaunchAgent | `com.ping-mem.soak-monitor.plist` | blocked | S012/S014 must prove it does not mask or mutate acceptance results. |
| O031 | Live system-ready LaunchAgent points at missing clean-main script | `com.ping-mem.system-ready.plist`; `test -f scripts/system-ready.ts` | blocked | Last exit 1; S012 owns repair/disable/classification. |
| O032 | Live system-ready LaunchAgent embeds admin env keys | `com.ping-mem.system-ready.plist`, `launchctl print` | blocked | S012/S014 must move to secret-safe pattern or disable before acceptance. |
| O033 | Repo root `CLAUDE.md` teaches blocked paths | `CLAUDE.md:10,23,32,68-69` | blocked | S011/S015 own quarantine/correction. |
| O034 | Repo root `AGENT_INSTRUCTIONS.md` mandates ping-mem-first | `AGENT_INSTRUCTIONS.md:11-20,201-209` | blocked | S011/S015 own quarantine/correction. |
| O035 | User-level Claude workflow mandates ping-mem/direct MCP | `/Users/umasankr/.claude/ping-mem-agent-workflow.md` | blocked | S011/S015 own quarantine/correction. |
| O036 | Doctor gate treats direct MCP presence as proxy readiness | `src/doctor/gates/service.ts:78-93` | blocked | S014 owns doctor/status alignment. |

## Scope vs Promise Delta

This slice proves:

- The Phase 0 inventory denominator exists for Codex/Claude configs, live processes, REST/runtime reachability, CLI/MCP/scripts, LaunchAgents, docs/static UI, shell integration, data paths, Docker/compose surfaces, and seeded offenders.
- All discovered S001 rows are classified.
- All seeded offender rows are classified.

This slice does not prove:

- ping-mem product trust.
- memory lifecycle correctness.
- codebase grounding correctness.
- runtime/data ownership correctness.
- truthful health/status alignment.
- recovery after sleep/reboot/restart.
- Codex or Claude Code re-adoption.

Current highest product risk:

- Static config says Codex is not configured for ping-mem, but live process evidence still shows many `dist/mcp/proxy-cli.js` children.
- REST on `localhost:3003` is not reachable and Docker/OrbStack API is unavailable from this shell, while LaunchAgents and proxy children remain present.
- Several active instruction/doc/UI surfaces still tell agents/operators to use ping-mem or direct-mode paths.

Next issue remains S002 only after S001 is accepted: runtime ownership and direct-mode quarantine.
