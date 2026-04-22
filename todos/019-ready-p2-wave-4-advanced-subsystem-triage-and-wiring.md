---
status: ready
priority: p2
issue_id: "019"
tags: [execution, wave-4, mining, dreaming, extractors, shell, diagnostics]
dependencies: ["015", "016", "017"]
---

## Problem Statement

Several advanced subsystem claims remain in the repo, but they are not yet all grounded as live, supportable capability.

## Findings

- open issues already cover extractor wiring, transcript miner wiring, shell daemon activation, and event-driven consumers
- advanced subsystems are a major source of false-green claim risk if left implicit
- this work should classify each subsystem rather than assuming it is either fully done or fully missing

## Recommended Action

1. Audit advanced subsystem wiring against actual startup/runtime paths.
2. Fix high-value gaps and classify the rest as verified, partial, dormant, or docs-only.
3. Feed that classification back into docs and support claims.

## Acceptance Criteria

- [ ] Advanced subsystems have explicit capability status.
- [ ] High-priority wiring gaps are fixed or tracked with grounded limitations.
- [ ] No major advanced surface remains implied without classification.

## Work Log

### 2026-04-22 - Stale advanced-surface backlog reconciled

**By:** Codex

**Actions:**
- Re-audited the open advanced-subsystem issue set against the current repo and live runtime.
- Verified `TranscriptMiner` event emission in code and tests, then closed `#96`.
- Verified production compose now carries the embedding provider env surface, then closed `#97`.
- Verified `LLMEntityExtractor` runtime wiring in code and live OrbStack logs, then closed `#99`.
- Verified shell daemon activation on the current machine, then closed `#98`.
- Implemented `scripts/periodic-cognition.sh` plus `config/launchd/com.ping-mem.periodic-cognition.plist`, installed the launchd job, verified disabled/mining/dreaming paths, then closed `#121`.
- Implemented a lightweight `RECALL_MISS` consumer in MCP and REST auto-recall responses, then closed `#102`.

**Learnings:**
- A meaningful part of Wave 4 is backlog truth, not only new implementation. Open issues that no longer describe reality keep distorting the perceived closure gap.
- The remaining advanced-surface scope is now more concentrated in the `TRANSCRIPT_MINED` consumer side (`#101`), not foundational wiring or scheduling.

### 2026-04-22 - Transcript mining events made operator-visible

**By:** Codex

**Actions:**
- Added a real `TRANSCRIPT_MINED` consumer to the Mining dashboard in `src/http/ui/partials/mining.ts`.
- The dashboard now queries recent `TRANSCRIPT_MINED` events from `events` and renders a `Recent Mined Transcripts` card with session file, project, mined timestamp, and extracted fact count.
- Added focused regression coverage in `src/http/ui/__tests__/mining.test.ts`.

**Verification:**
- `bun test src/http/ui/__tests__/mining.test.ts`
- `bun run typecheck`

**Learnings:**
- This gap was not missing infrastructure anymore; it was missing operator visibility. Surfacing the event log in the Mining UI closes the consumer side without inventing a second automation path.
