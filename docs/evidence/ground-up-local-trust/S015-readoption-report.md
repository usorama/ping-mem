# S015 Controlled CLI-First Re-adoption Report

Status: Codex-first local re-adoption complete; Claude Code remains out of scope for this run.

Date: 2026-05-01

## Decision

User approval unblocked machine-local config writes and added a clean-slate
requirement: empty ping-mem before writing new data, seed one repo, set up
incremental re-indexing on change, and re-adopt Codex first through one tool.

The implemented Codex path is:

- Tool: `/Users/umasankr/.codex/bin/ping-mem-codex`
- Skill contract: `/Users/umasankr/.codex/skills/ping-mem/SKILL.md`
- Runtime: REST/CLI only at `http://localhost:3003`
- Disallowed for Codex re-adoption: MCP/proxy tools, direct DB mode, hidden hooks

## Clean Slate And Backup

Backup before emptying:

- `/Users/umasankr/.ping-mem-empty-backups/20260501-081401`

The backup includes the prior host `~/.ping-mem` directory plus Neo4j/Qdrant
Docker volume archives. After oversized corpus attempts failed, the newly
created local stores were reset again and rebuilt from the same clean contract.

Final registered roots:

- `/projects/vunderstory`
- `/projects/codex-corpus`

Final runtime counts:

- Vunderstory: 243 files, 260 chunks, 200 commits
- Codex corpus: 463 files, 517 chunks, 0 commits
- Qdrant points: 777
- SQLite FTS code chunks: 777

## Codex Corpus Scope

The Codex corpus is search-safe rather than raw-event exhaustive:

- Included directly: Codex instructions, durable memories, prompts, rules,
  `history.jsonl`, `session_index.jsonl`, thread summaries, stage summaries,
  and logs summary.
- Raw session/event streams: represented by complete inventory path, byte size,
  and SHA-256 hash.
- Reason: raw session payload ingestion failed the local SQLite BM25 path with
  `database disk image is malformed`; using raw streams would leave partial
  graph-only state rather than a searchable trust store.

Evidence:

- `docs/evidence/ground-up-local-trust/S015-codex-readoption/codex-corpus-build-inventory-safe.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/codex-corpus-final-run-status.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-codex-search.json`

## Config Backup And Diffs

Backup path:

- `/Users/umasankr/.codex/backups/ping-mem-readoption-20260501-0903`

Backed up:

- `AGENTS.md`
- `instructions.md`
- `config.toml`

Machine-local writes:

- Added `/Users/umasankr/.codex/bin/ping-mem-codex`
- Added `/Users/umasankr/.codex/skills/ping-mem/SKILL.md`
- Updated `/Users/umasankr/.codex/AGENTS.md` with controlled ping-mem
  re-adoption guardrails

## Incremental Re-indexing

Added one scoped LaunchAgent:

- `/Users/umasankr/Library/LaunchAgents/com.ping-mem.vunderstory-reindex.plist`

It runs:

- `/Users/umasankr/.ping-mem/scripts/vunderstory-incremental-reindex.sh`

Proof:

- `plutil -lint` passed.
- Manual script run verified the current Vunderstory manifest without ingest.
- `launchctl print gui/501/com.ping-mem.vunderstory-reindex` shows `state = not running`, `last exit code = 0`, `runs = 2`, `WatchPaths = /Users/umasankr/Projects/vunderstory`, and `run interval = 120 seconds`.

## Runtime Proof

Key evidence files:

- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-health.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-projects.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-qdrant-counts.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-bm25-counts.txt`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-vunderstory-codex-proof.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-codex-memory-lifecycle.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/codex-wrapper-projects.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/codex-wrapper-search.json`
- `docs/evidence/ground-up-local-trust/S015-codex-readoption/codex-readoption-memory-search.json`

Observed outcomes:

- Health is `ok` with SQLite, Neo4j, Qdrant, and diagnostics healthy.
- Codex wrapper lists both registered roots.
- Vunderstory codebase grounding proof passes for `codex-local`.
- Codex memory lifecycle proof passes for `codex-local`.
- Search for the trust rebuild finds Codex thread and memory artifacts.
- A durable re-adoption decision memory was saved and found by search.
- `bun run typecheck` passes.
- `bun test` was run; 2036 tests passed and 7 memory-sync regression tests
  failed because the clean-slate store no longer contains legacy PingLearn,
  Firebase, LiveKit, DPDP, Supabase, Ollama, and native-sync memories expected
  by that fixture.

## Active Process Inventory

Residual Codex app-server and pre-existing `dist/mcp/proxy-cli.js` child
processes may remain active in the Codex desktop runtime. They were not used as
the re-adoption path. The proved path is the wrapper above.

## Rollback

To roll back Codex re-adoption:

```bash
cp /Users/umasankr/.codex/backups/ping-mem-readoption-20260501-0903/AGENTS.md /Users/umasankr/.codex/AGENTS.md
cp /Users/umasankr/.codex/backups/ping-mem-readoption-20260501-0903/instructions.md /Users/umasankr/.codex/instructions.md
cp /Users/umasankr/.codex/backups/ping-mem-readoption-20260501-0903/config.toml /Users/umasankr/.codex/config.toml
rm -f /Users/umasankr/.codex/bin/ping-mem-codex
rm -rf /Users/umasankr/.codex/skills/ping-mem
launchctl bootout gui/$(id -u) /Users/umasankr/Library/LaunchAgents/com.ping-mem.vunderstory-reindex.plist
rm -f /Users/umasankr/Library/LaunchAgents/com.ping-mem.vunderstory-reindex.plist
```

To restore the pre-empty ping-mem data, use the tar archives under:

- `/Users/umasankr/.ping-mem-empty-backups/20260501-081401`

## Allowed Completion Claim

Allowed:

- ping-mem is locally re-adopted for Codex through one CLI-first wrapper and
  skill contract.
- Vunderstory is indexed and has incremental re-indexing configured.
- Codex instructions, memories, rules, prompts, thread summaries, stage
  summaries, logs summary, and raw session inventory are searchable through the
  Codex corpus.

Not allowed:

- Claiming raw Codex session event payloads are fully embedded as searchable
  content.
- Claiming Claude Code has been re-adopted in this run.
- Claiming optional MCP proxy re-adoption.
- Treating ping-mem as final authority without direct evidence.
