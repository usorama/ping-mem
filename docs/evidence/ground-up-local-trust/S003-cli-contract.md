# S003 CLI Trust Spine Contract

Issue: `S003-unified-cli-trust-spine`
Date: 2026-04-30
Repo: `/Users/umasankr/Projects/ping-mem`

## Outcome

S003 creates the first shared `ping-mem agent ... --json` command surface for Codex and Claude Code. It is a REST-only trust spine with stable JSON envelopes, bounded timeouts, read-only status/proof skeletons, secret-safe auth loading, and no Docker auto-repair.

This is not re-adoption. It is the command surface later slices use to prove memory, codebase grounding, identity, and recovery.

## Command Contract

| Command | Purpose | Runtime behavior | Exit behavior |
|---|---|---|---|
| `bun run src/cli/index.ts agent status --json --timeout-ms 5000` | Read-only runtime availability check | GET `/health` through configured REST URL | `0` if available, `2` if blocked/unavailable |
| `PING_MEM_REST_URL=http://127.0.0.1:9 bun run src/cli/index.ts agent status --json --timeout-ms 1000` | Negative proof for unavailable runtime | Does not start Docker or repair anything | `2`, with blocked JSON |
| `bun run src/cli/index.ts agent proof memory-lifecycle --agent codex-local --project /Users/umasankr/Projects/ping-mem --dry-run --json` | Read-only proof plan skeleton for later lifecycle proof | No runtime mutation | `0`, with dry-run JSON |

## JSON Envelope

All S003 agent trust-spine commands emit the same top-level shape:

```json
{
  "ok": false,
  "status": "blocked",
  "command": "agent status",
  "runtime": {
    "url": "http://localhost:3003",
    "timeoutMs": 5000
  },
  "elapsedMs": 9,
  "checkedAt": "2026-04-30T14:56:00.950Z",
  "error": {
    "code": "RUNTIME_UNAVAILABLE",
    "message": "Unable to connect. Is the computer able to access the url?",
    "layer": "runtime"
  }
}
```

Example outputs are stored in:

- `docs/evidence/ground-up-local-trust/S003-cli-json-examples/status-localhost.json`
- `docs/evidence/ground-up-local-trust/S003-cli-json-examples/status-localhost.exit`
- `docs/evidence/ground-up-local-trust/S003-cli-json-examples/status-unavailable.json`
- `docs/evidence/ground-up-local-trust/S003-cli-json-examples/status-unavailable.exit`
- `docs/evidence/ground-up-local-trust/S003-cli-json-examples/memory-lifecycle-dry-run.json`
- `docs/evidence/ground-up-local-trust/S003-cli-json-examples/memory-lifecycle-dry-run.exit`

## Secret And Auth Contract

The trust-spine helper reads auth from:

- `PING_MEM_API_KEY` environment variable, or
- the existing machine-local `~/.ping-mem/auth.json` loader.

It does not print the token value. The JSON envelope reports the runtime URL, timeout, elapsed time, status, and error class only.

## No-Direct-DB Contract

Structural check:

```bash
rg -n 'from .*EventStore|from .*MemoryManager|from .*IngestionService|from .*Neo4j|from .*Qdrant' src/cli src/client
```

Result: no matches.

Implementation files:

- `src/cli/agent-trust.ts`: REST-only helper for status and dry-run proof envelopes.
- `src/cli/commands/agent.ts`: command registration for `agent status` and `agent proof memory-lifecycle`.
- `src/cli/__tests__/agent-trust.test.ts`: status, unavailable-runtime, dry-run, and non-dry-run blocked tests.

## Verification

Targeted tests:

```bash
bun test src/cli src/client
```

Result:

```text
31 pass
0 fail
82 expect() calls
Ran 31 tests across 4 files.
```

Typecheck:

```bash
bun run typecheck
```

Result: passed with `tsc --noEmit`.

Manual command proof:

- Localhost status returned `ok=false`, `status=blocked`, `error.code=RUNTIME_UNAVAILABLE`, exit `2`.
- Forced unavailable runtime `http://127.0.0.1:9` returned `ok=false`, `status=blocked`, `error.code=RUNTIME_UNAVAILABLE`, exit `2`, and preserved `timeoutMs=1000`.
- Memory lifecycle dry-run returned `ok=true`, `status=dry-run`, `readOnly=true`, `mutatesRuntime=false`, planned lifecycle operations, and exit `0`.

## Scope vs Promise Delta

S003 proves:

- A shared `ping-mem agent ... --json` command surface exists.
- The trust-spine status command talks to REST only.
- Unavailable REST returns blocked JSON and does not auto-start Docker.
- The memory lifecycle proof command has a read-only dry-run skeleton for later Codex/Claude proof slices.
- Secret values are loaded from machine-local env/auth sources and are not printed.

S003 does not prove:

- Operational memory lifecycle success for Codex or Claude Code.
- Codebase verify/ingest/search/source-anchor success.
- Complete explicit identity enforcement.
- Runtime project registry alignment.
- Recovery scenario success.
- Doctor/UI/log alignment.
- Controlled re-adoption.

Next required slices:

- S004 enforces identity and project path safety.
- S005 and S006 turn the dry-run memory lifecycle plan into Codex and Claude operational memory proof.
- S007 and S008 turn the CLI spine into Codex and Claude codebase grounding proof after S010 registry alignment.
