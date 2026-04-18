# CHANGELOG — ping-mem Complete Remediation Plan

Append-only log of substantive amendments with commit SHAs. The plan body (overview.md + phase files) is always the source of truth for current state; this file is processing history.

## 2026-04-18

- **Initial**: overview.md drafted from `docs/ping-mem-remediation-research/07-synthesis.md` + 4 user decisions (memory-sync fix mode, keep-forward supervisor, 3-tier Ollama, realistic soak bar) + 3-judge panel consolidated findings on the superseded single-file plan.
- Supersedes `docs/plans/2026-04-18-ping-mem-complete-remediation-plan.md` (single-file, failed Judge Panel per Opus 4.7 + GPT-5.4 FAIL verdicts).
- **Integration verification**: all 10 outcomes, 29 wirings, 28 functional tests cross-referenced across phase files; 12+ file:line citations verified against live repo. One path typo fixed (`src/ingestion/` → `src/ingest/` in P8 changelog).
- **Final Judge Panel (rebuild) — FAIL**: Opus 4.7 + GPT-5.4 voted FAIL; Gemini 2.5 Pro PASS_WITH_CONCERNS (limited workspace). 6 CRITICAL/HIGH findings surfaced.
- **F1 fix (CRITICAL, 2-judge CONFIRMED)**: moved `ProjectScanner.ts` defaults override into P2.6 (was deferred to "future ADR" — anti-pattern #46 regression). `IngestProjectOptions`, `IngestionEnqueueSchema`, and `ProjectScanner.scanProject` gain optional `ignoreDirs` + `excludeExtensions` overrides; global defaults stay safe; per-project overrides for 5 active projects re-include `docs/` + text extensions. Coverage measurement now uses `git ls-files` denominator consistent with the override set.
- **F2 fix (MEDIUM, 2-judge CONFIRMED)**: P2 pre.5 endpoint `/api/v1/health` → `/health`; expected `"healthy"` → `ok`; removed unneeded Basic Auth.
- **F3 fix (CRITICAL, Opus)**: reconciled P5↔P7 gate schema — P7 `scripts/soak-monitor.sh` matches on `.id` (not `.name`) and maps P5 status (`pass→green`, `fail/skip→red`). Added 4 missing gates to P5 (`orbstack-warm-latency`, `auto-os-cross-project-hit`, `ping-mem-doctor-exec-time-below-10s`, `doctor-launchd-ran`). P5 registry total: 35 gates. P5 doctor-runs filename convention pinned to ISO-8601 so P7's `find ${day}T*.jsonl` pattern matches deterministically.
- **F4 fix (HIGH, Opus)**: P8 doc drift corrected — PostToolUse hook filename matches P1 (`ping-mem-memory-sync-posttooluse.sh`); reaper interval 2 min (matches P1.8); removed fabricated `RESERVED_SESSION_NAMES` reference (P1 uses inline literal allowlist); exit-code taxonomy aligned across overview AC-F9, P5.3, P8 §13 (`0`=green, `1`=warning, `2`=critical, `3`=unreachable).
- **F5 fix (HIGH, GPT-5.4)**: O3 truncation cap raised from 30 KB → 1 MB to match server schema `ContextSaveSchema.value.max(1_000_000)`. Silent truncation becomes loud 400 for the rare >1 MB file — matches O3's "full content, no truncation" mandate.
- **F6 fix (HIGH, GPT-5.4)**: `scripts/seed-regression-fixtures.sh` authored in P7.4b (full script body with idempotency, per-fixture verification, set -euo pipefail, shellcheck gate). Removed P8 ownership claim. P8 now only documents the script, not writes it.
