# S019 Original Capability Inventory

Generated: 2026-05-03T11:49:02Z

GitHub issue: https://github.com/usorama/ping-mem/issues/137

## Result

The original ping-mem product surface is mapped in:

- `docs/evidence/ground-up-local-trust/capability-inventory.json`

The inventory covers memory, codebase ingestion/search, graph/relationships,
sessions, events, mining/dreaming, diagnostics, health, UI, CLI, MCP/proxy
boundaries, recovery, and docs/operator truth.

Each entry includes:

- objective and outcome mapping;
- user-facing feature statement;
- owner paths;
- evidence sources;
- current status: `verified`, `partial`, `dormant`, or `out_of_current_claim`;
- claim boundary.

## Current Classification

| Status | Count | Meaning |
|---|---:|---|
| `verified` | 5 | Live or proof-backed enough for the current trust claim. |
| `partial` | 7 | Module exists and has some tests or evidence, but needs explicit live metrics before broad claims. |
| `dormant` | 1 | Code exists, but trigger path and product acceptance are not currently proven. |
| `out_of_current_claim` | 1 | Explicitly excluded from current capability claims. |

## Scorecard Feed

`scripts/capability-scorecard.mjs` now reads the inventory and emits it into
`scorecard.json`, `scorecard.md`, and `scorecard.html`. The next issue can turn
these inventory entries into deterministic per-capability metrics without
rediscovering the surface area.
