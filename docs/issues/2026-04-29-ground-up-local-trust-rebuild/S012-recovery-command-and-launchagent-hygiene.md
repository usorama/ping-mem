---
id: S012
title: "Recovery command and LaunchAgent hygiene"
type: HITL
status: done
parent: "/Users/umasankr/Projects/ping-mem/docs/architecture/2026-04-29-ground-up-local-trust-rebuild.md"
blocked_by: ["S001", "S002"]
tracks: ["OBJ-6", "OUT-6", "CAP-6", "FR-9", "AC-9", "ADR-010", "ADR-015"]
---

## What to build

Establish a repo-owned, credential-safe read-only status/readiness command and reconcile active `com.ping-mem.*` LaunchAgents, missing targets, credential handling, logs, write behavior, and rollback paths before recovery scenarios can count.

## Scope boundaries

- Owned surfaces: status/readiness command, launchd template docs, active LaunchAgent evidence, credential hygiene checks, recovery precondition ledger.
- Out of scope: executing sleep/reboot/restart scenarios, re-adoption, secret creation, destructive cleanup.
- Architecture/context updates required: human approval is required before editing, unloading, loading, or deleting active user LaunchAgents.

## Traceability

- Objectives: OBJ-6
- Outcomes: OUT-6
- Capabilities: CAP-6
- User stories: US-8
- Functional requirements: FR-9
- Non-functional requirements: NFR-1, NFR-5, NFR-7, NFR-8
- Acceptance criteria: AC-9
- Architecture decisions: ADR-010, ADR-015

## Acceptance criteria

- [x] A repo-owned read-only readiness/status command exists or an existing command is formally selected and proven credential-safe.
- [x] All active `com.ping-mem.*` LaunchAgents are classified by target path, existence, credentials, write behavior, log path, runtime effect, and rollback.
- [x] Known default credentials are not embedded in acceptance commands or active LaunchAgent proof.
- [x] Hidden write-capable recovery/maintenance jobs are disabled, blocked, or explicitly approved before scenario proof.

## Definition of done

- [x] Deterministic outcome: recovery scenario proof has a safe status command and clean launchd baseline.
- [x] Required code/docs/tests produced: readiness command, LaunchAgent hygiene ledger, rollback notes.
- [x] Required verification run with exact command(s): status command and launchd checks below.
- [x] Required evidence attached: LaunchAgent ledger and credential-safe readiness output.

## Verification

- [x] Structural check command: `rg -n 'system-ready|watchdog|recover|doctor|launchd|LaunchAgent|PING_MEM_ADMIN_PASS|ping-mem-dev-local' scripts config launchagents src docs`
- [x] Automated test command: `bun test src/cli src/doctor src/observability`
- [x] Automated test command: `bun run typecheck`
- [x] Runtime/manual proof steps: `find /Users/umasankr/Library/LaunchAgents -maxdepth 1 -name 'com.ping-mem*.plist' -print`
- [x] Runtime/manual proof steps: `bun run src/cli/index.ts agent status --json --read-only --evidence-dir docs/evidence/ground-up-local-trust/S012-status`
- [x] Runtime/manual proof steps: for each active label, run `launchctl print gui/$(id -u)/<label>` only after confirming it is read-only.
- [x] PR-zero evidence required: scope delta lists which LaunchAgent actions were approved, deferred, or blocked.

## Evidence artifacts

- Artifact/path: `docs/evidence/ground-up-local-trust/S012-launchagent-hygiene.md`
- Artifact/path: `docs/evidence/ground-up-local-trust/S012-status/`
- Command output: status/readiness command, launchctl read-only output, target existence checks.

## Resolved blocker evidence

- Six `com.ping-mem.*` LaunchAgent plists existed under `/Users/umasankr/Library/LaunchAgents`.
- `com.ping-mem.daemon` was running before reconciliation.
- `com.ping-mem.doctor` and `com.ping-mem.system-ready` carry local admin env values; S012 evidence redacts the password.
- `com.ping-mem.periodic-cognition`, `com.ping-mem.periodic-ingest`, and `com.ping-mem.system-ready` are write-capable jobs.
- User approval was given to proceed after OrbStack/runtime recovery.
- All six plists were copied to `/Users/umasankr/Library/LaunchAgents/.ping-mem-backups/20260430-215056`, moved to `/Users/umasankr/Library/LaunchAgents/.ping-mem-disabled-20260430-215056`, and booted out.
- Post-reconciliation top-level `com.ping-mem*.plist` count is `0`; every known label returns `launchctl print` exit `113`.

## Scope vs promise delta

S012 proves read-only status output, LaunchAgent classification, reversible backup, and clean launchd baseline. It does not prove sleep/reboot/restart recovery scenarios; those remain S013.

## Stop conditions for `/to-execute`

- Stop before editing, unloading, loading, deleting, or creating active LaunchAgents unless the user explicitly approves that external write.
- Stop if a readiness command would recreate secrets, restart services, or mask failure in read-only mode.

## Blocked by

S001, S002

## Rollout / rollback notes

Rollback evidence is recorded in `docs/evidence/ground-up-local-trust/S012-launchagent-reconciliation/ROLLBACK.md`. Do not commit machine-local secrets.
