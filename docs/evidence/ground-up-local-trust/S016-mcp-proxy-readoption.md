# S016 Optional MCP Proxy Re-adoption

Status: not re-adopted; remains quarantined.

Date: 2026-05-01

## Decision

S016 was not implemented as an MCP proxy re-adoption.

Reason:

- The issue is explicitly optional and HITL.
- Its stop condition requires explicit approval before enabling MCP proxy in
  Codex or Claude configs.
- The current user-approved scope says to use one tool, Codex first.
- S015 proved the CLI-first Codex path without MCP.

## Current Allowed Path

Codex uses one local wrapper:

- `/Users/umasankr/.codex/bin/ping-mem-codex`

Skill contract:

- `/Users/umasankr/.codex/skills/ping-mem/SKILL.md`

This path calls the REST-owned CLI surface. It does not use MCP proxy, direct DB
mode, or hidden hook behavior.

## Proxy Process Disposition

Process inventory still shows pre-existing Codex app-server child processes
running `dist/mcp/proxy-cli.js`. They are classified as residual adapter
processes from the desktop runtime, not the approved re-adoption path.

No MCP config was updated in this slice, and no optional proxy convenience path
was added.

## Evidence

- S015 report: `docs/evidence/ground-up-local-trust/S015-readoption-report.md`
- S015 process inventory: `docs/evidence/ground-up-local-trust/S015-codex-readoption/final-process-inventory.txt`
- S015 wrapper proof: `docs/evidence/ground-up-local-trust/S015-codex-readoption/codex-wrapper-projects.json`
- S015 wrapper search proof: `docs/evidence/ground-up-local-trust/S015-codex-readoption/codex-wrapper-search.json`

## Allowed Completion Claim

Allowed:

- MCP proxy remains optional and quarantined.
- Codex re-adoption is complete only through the one CLI-first wrapper.

Not allowed:

- Claiming MCP proxy has been re-adopted.
- Claiming direct MCP DB mode is approved.
- Claiming proxy process presence is proof of trust.
