# ping-mem Agent Execution Guide

This file is the short operational handoff for agents working in this repo.

Use it with:

- [docs/plans/2026-04-22-fix-deterministic-capability-grounding-plan.md](/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-22-fix-deterministic-capability-grounding-plan.md)
- [docs/plans/2026-04-22-deterministic-capability-execution-waves.md](/Users/umasankr/Projects/ping-mem/docs/plans/2026-04-22-deterministic-capability-execution-waves.md)
- umbrella issue `#133`

## Current Reality

- The old remediation closure story is not trustworthy.
- Deterministic ingestion and low-memory Neo4j cleanup have been materially improved.
- Runtime truth, state convergence, search acceptance, and doc truth are still open.

## Execution Rule

Work wave-by-wave.

1. Wave 0: truth baseline and scope freeze
2. Wave 1: operational truth
3. Wave 2: state convergence
4. Wave 3: capability correctness and acceptance
5. Wave 4: declared surface and environment parity
6. Wave 5: documentation and operator truth

Do not skip forward because a lower wave looks “mostly fine”.

## Repo Tracking

Wave tracking lives in `todos/003` through `todos/008`.
Concrete execution backlog now lives in `todos/009` through `todos/022`.

Earlier focused todos already exist and currently belong under Wave 2:

- `todos/001-ready-p1-deterministic-cross-repo-ingestion.md`
- `todos/002-ready-p1-runtime-reingest-and-state-reconciliation.md`

## Delegation Guidance

- Use bounded sub-agents for one wave slice at a time.
- Keep write scopes disjoint.
- Main agent owns synthesis and verification between waves.
- In this environment, `gpt-5.4-mini` is available for bounded explorer work; `gpt-5.1-codex-mini` was not available during prior discovery.

## Memory / Handoff Rule

If a new session starts, re-anchor from:

1. `agents.md`
2. the grounding plan
3. the execution-waves doc
4. issue `#133`
5. the relevant wave todo

If implementation discovers more work, attach it to an existing capability family and wave before creating a new stream.
