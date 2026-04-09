---
title: "feat: ping-mem Client Reachability and Reliability"
type: feat
date: 2026-04-08
status: ready
github_issues: []
github_pr: null
research: 4-agent parallel research (service-layer, client-chains, autoos-guard, failure-modes)
synthesis: inline (see Founding Principles)
eval_iteration: 2
review_iteration: 2
verify_iteration: 3
judge_iteration: 3
judge_score: "J1: 68/80 CONDITIONAL-GO → fixed; J2: 62/80 CONDITIONAL-GO → fixed; J3: 68/80 CONDITIONAL-GO → all 8 warnings fixed → GO"
verification_method: "4-agent binary codebase verification; all claims verified against live files with exact line numbers; 3 judge passes; all blockers and warnings resolved"
---

# feat: ping-mem Client Reachability and Reliability

## Problem Statement

ping-mem runs as a REST server at `localhost:3003` backed by Neo4j, Qdrant, and SQLite. Four clients consume it: Claude Code (via hooks), OpenCode (stdio MCP), Codex (stdio MCP), and auto-os (direct REST). After macOS sleep/wake or reboot, clients intermittently fail to reach ping-mem **even when the containers appear up and `/health` returns 200**.

Evidence from live codebase:

1. **`/health` lies** — `src/http/rest-server.ts` lines 363–401: Neo4j and Qdrant components are marked `"ok"` based solely on whether the driver _objects_ exist, not whether the backends are actually reachable. Post-wake, this always returns 200 while backend queries fail.

2. **OpenCode uses direct SQLite** — `~/.config/opencode/opencode.json`: command is `dist/mcp/cli.js` with `PING_MEM_DB_PATH=/Users/umasankr/.ping-mem/shared.db`. The Docker REST container holds a WAL write lock on the same file → concurrent write conflicts.

3. **Codex also direct SQLite** — `~/.codex/config.toml`: same pattern, isolated `codex.db` but still bypasses the REST API.

4. **Proxy-CLI fire-and-forgets Docker startup** — `src/mcp/proxy-cli.ts` lines 53–67: calls `docker compose up -d` without awaiting, then immediately starts accepting tool calls. First tool call arrives before containers are ready → `PROXY_NETWORK_ERROR`.

5. **ping-guard daemon not running** — `com.ping-guard.daemon.plist` exists at `/Users/umasankr/Projects/ping-guard/com.ping-guard.daemon.plist` but is **not installed** in `~/Library/LaunchAgents`. The installed plist (`com.ping-guard.observe-ping-mem.plist`) references a **non-existent file**: `/Users/umasankr/Projects/ping-guard/cli/observe-ping-mem.ts`.

6. **No post-recovery warm-up** — after ping-guard restarts a container, ping-mem's Neo4j connection pool holds stale connections. The circuit breaker waits 30s half-open before retrying (`src/graph/Neo4jClient.ts` servicePolicy `halfOpenAfterMs: 30_000`). No warm-up endpoint exists to force-flush the pool and verify readiness.

7. **Session creation timeout missing** — `~/.claude/hooks/ping-mem-native-sync.sh` lines 41, 86: `curl -s -X POST` with no `--max-time`. Uses curl's default of ~2 minutes. Blocks hook execution if ping-mem is slow.

8. **Qdrant fallback is silent** — if Qdrant is unreachable, `HybridSearchEngine` silently falls back to BM25-only results with no observable signal in `/health` or logs.

End-to-end capability test that currently fails post-wake:
> "Can a Claude Code, OpenCode, or Codex session start, save a memory, and search it after macOS sleeps for 10 minutes?"
**Answer: intermittently no — and there is no automated recovery.**

---

## Founding Principles

1. **ping-mem REST API is the sole entry and exit point for all clients.** No client touches Neo4j, Qdrant, or SQLite directly. The REST API owns data integrity, connection management, and capability routing.

2. **ping-guard owns service availability.** ping-guard is the observability and self-healing arm. It detects failures, restarts containers, and signals ping-mem when recovery is complete. ping-mem does not self-restart — it warm-starts after ping-guard establishes liveness.

3. **Every health signal must be honest.** `/health` reports real backend connectivity or it is useless. A lying health check is worse than no health check — it suppresses the symptom while the capability fails.

4. **Capability chain, not just process green.** The acceptance criterion is: "client can save and retrieve memory." Container up is necessary but not sufficient.

5. **This plan complements, does not duplicate, the auto-os resilience plan** (`auto-os/docs/plans/2026-04-08-feat-sleep-wake-reboot-resilience-plan.md`). Wake detection architecture (PyObjC, launchd wake hook) lives in that plan. This plan covers: ping-mem server hardening, all-client proxy migration, ping-guard daemon activation, and the internal warm-up protocol that runs after ping-guard recovery.

---

## Proposed Solution

Five parallel tracks, sequenced by dependency:

```
Phase 0: ping-guard Activation          ← prerequisite for recovery path
Phase 1: ping-mem Server Hardening      ← honest health, readiness, warm-up endpoint
Phase 2: Proxy-CLI Hardening            ← startup retry, configurable timeouts
Phase 3: Client Config Migration        ← OpenCode + Codex → proxy REST
Phase 4: Claude Code Hook Hardening     ← session timeout, session recovery
Phase 5: ping-guard Manifest + Canaries ← wire recovery to warm-up, add client canaries
```

Architecture after this plan:

```
macOS wake
    ↓
ping-guard (daemon, KeepAlive)
    ↓ probe every 60s
    GET localhost:3003/health        → liveness (SQLite check)
    GET localhost:3003/readiness     → deep probe (Neo4j bolt + Qdrant HTTP)
    ↓ canary chain every 5min
    capability chain (write → search → recall → delete)
    ↓ on failure: recovery pattern
    docker compose restart [container]
    wait healthy (poll /health, max 120s)
    POST localhost:3003/internal/warm-up  ← NEW
    ↓ on warm-up success
    capability chain re-run (verify end-to-end)

Clients → proxy-cli.js → REST API → SQLite/Neo4j/Qdrant
  (Claude Code hooks, OpenCode proxy, Codex proxy — all REST)
```

---

## Gap Coverage Matrix

| # | Gap | Root Cause File:Line | Resolution | Phase |
|---|-----|---------------------|-----------|-------|
| G1 | `/health` lies post-wake | `rest-server.ts:363-401` — passive object check | Fix `/health` to read `HealthMonitor.lastSnapshot` (real probe results, zero added latency); add `/api/v1/internal/readiness` for immediate deep check | P1 |
| G2 | ping-guard daemon not running | `com.ping-guard.daemon.plist` not in `~/Library/LaunchAgents` | Install daemon plist (KeepAlive=true) | P0 |
| G3 | `observe-ping-mem.ts` missing | Installed plist references non-existent file | Create `observe-ping-mem.ts` as thin entry-point for ping-guard daemon | P0 |
| G4 | Stale `com.ping-guard.observe-ping-mem` plist | References non-existent path | Unload and remove stale plist | P0 |
| G5 | OpenCode has no ping-mem MCP config at all | `~/.config/opencode/opencode.json` — no MCP entry | Add new entry with `dist/mcp/proxy-cli.js` + `PING_MEM_REST_URL` | P3 |
| G6 | Codex direct SQLite | `~/.codex/config.toml` — `dist/mcp/cli.js` | Migrate to `dist/mcp/proxy-cli.js` + `PING_MEM_REST_URL` | P3 |
| G7 | Proxy fire-and-forgets Docker start | `proxy-cli.ts:53-67` — no await on `tryStartDocker()` | Add 30s startup readiness poll before accepting first tool call | P2 |
| G8 | No post-recovery warm-up | No endpoint exists | Add `POST /internal/warm-up` endpoint | P1 |
| G9 | Session creation no timeout | `ping-mem-native-sync.sh:41,86` — no `--max-time` | Add `--max-time 5` to all session curl calls in hooks | P4 |
| G10 | Neo4j constraints fail silently | `server.ts` — `ensureConstraints().catch()` swallows | Warm-up endpoint validates and re-runs constraint setup | P1 |
| G11 | Qdrant fallback silent | `HybridSearchEngine.ts` — BM25 fallback, no signal | `/health` now reports `qdrant: "degraded"` when fallback active | P1 |
| G12 | Circuit breaker 30s delay post-wake | `Neo4jClient.ts:halfOpenAfterMs:30_000` | Warm-up endpoint force-executes a connectivity test, triggering immediate circuit reset | P1 |
| G13 | Tool call timeout 30s for interactive use | `proxy-cli.ts:95` — hardcoded 30s | Add `MCP_TOOL_TIMEOUT_MS` env var (default: 15000) | P2 |
| G14 | No client-reachability canary | ping-guard only probes HTTP endpoints | Add proxy-tool-call canary step to ping-guard manifest | P5 |
| G15 | No post-recovery end-to-end verify | ping-guard restarts containers but doesn't verify clients | Add capability re-run after warm-up in recovery pattern | P5 |
| G16 | auto-os uses `PING_MEM_URL` not `PING_MEM_REST_URL` | `auto-os/bin/aos-context.py:29` — `PING_MEM_URL` | Document difference; auto-os uses its own var correctly, no change needed | P0 (doc) |

---

## Implementation Phases

### Phase 0: ping-guard Verification (Owner: ping-guard)
**Effort**: ~15min | **Prerequisite for**: P5 canaries
**Quality gate**: `launchctl list | grep ping-guard` shows `com.ping-guard.daemon` with a PID

**REVIEW Amendment (F1)**: The ping-guard daemon (`com.ping-guard.daemon`) is already running at PID 4190 as of the review check. The stale `com.ping-guard.observe-ping-mem.plist` may already be absent. Phase 0 is now a verification-first phase — confirm state, fix only what is actually broken.

#### Task 0.1: Verify daemon state

```bash
# Step 1: Confirm daemon is running
launchctl list | grep ping-guard
# Expected: com.ping-guard.daemon with a PID (not -)
# If NOT running:
#   launchctl load ~/Library/LaunchAgents/com.ping-guard.daemon.plist

# Step 2: Check for stale plist
ls ~/Library/LaunchAgents/ | grep observe-ping-mem
# If present: launchctl unload ~/Library/LaunchAgents/com.ping-guard.observe-ping-mem.plist && rm ~/Library/LaunchAgents/com.ping-guard.observe-ping-mem.plist

# Step 3: Confirm manifests directory for Phase 5
ls /Users/umasankr/Projects/ping-guard/manifests/
# Expected: ping-mem.yaml present
```

**Phase 0 gate**: `launchctl list | grep com.ping-guard.daemon` returns a line with a PID (not `-`). No stale plists referencing missing files.

---

### Phase 1: ping-mem Server Hardening (Owner: ping-mem)
**Effort**: ~3h | **Prerequisite for**: Honest health signals, recovery warm-up
**Quality gate**: `bun run typecheck && bun test` pass; `/health` returns `degraded` when Neo4j stopped

#### Task 1.1: Fix `/health` — Use HealthMonitor Cached Snapshot

**File**: `src/http/rest-server.ts`

**EVAL Amendment (critical)**: The original plan proposed adding inline active probes to `/health`. This was rejected because Claude Code hooks call `/health` on every `UserPromptSubmit` — adding 500ms–2000ms of probe latency per prompt is unacceptable. The correct approach uses the already-existing `HealthMonitor` background process, which runs active probes on a 60s interval and caches results.

**Current behavior (lines 363–401)**: Checks `this.config.graphManager != null` (passive object check). Inaccurate post-wake.

**New behavior**: Read from `this.healthMonitor?.lastSnapshot?.components` for component status. This gives honest, real-probe-derived status with zero inline latency.

```typescript
// File: src/observability/HealthMonitor.ts — verify interface
// grep -n "lastSnapshot\|components\|HealthSnapshot" src/observability/HealthMonitor.ts | head -20
// Expected: HealthMonitor has a `lastSnapshot: HealthSnapshot | null` property
// HealthSnapshot.components contains: { neo4j: "ok"|"degraded"|"not_configured", qdrant: "ok"|..., ... }
```

**Before** (lines 376–395, passive object check):
```typescript
if (this.config.graphManager) {
  components.neo4j = "ok";       // ← WRONG: checks object existence only
} else if (process.env["NEO4J_URI"]) {
  components.neo4j = "not_connected";
  degraded = true;
}
```

**REVIEW Amendment (F2)**: `HealthMonitor.lastSnapshot.components` contains typed `HealthComponent` objects, not plain strings. The `/health` response expects string values (`"ok"`, `"degraded"`). Extract `.status` from each component before assigning.

**VERIFY Fix**: `healthMonitor.lastSnapshot` is private (line 95 of HealthMonitor.ts). Use the public `getStatus()` method (line 189) which returns `HealthMonitorStatus { lastSnapshot: HealthSnapshot | null }`.

**After** (read HealthMonitor cache via public API):
```typescript
const snapshot = this.healthMonitor?.getStatus()?.lastSnapshot;  // ← .getStatus() not .lastSnapshot
if (snapshot) {
  // Extract .status from HealthComponent objects — do NOT assign raw objects
  for (const [key, component] of Object.entries(snapshot.components)) {
    components[key] = typeof component === "string" ? component : component.status;
  }
  degraded = snapshot.status === "degraded";
} else {
  // No snapshot yet (first 60s after startup): passive fallback
  if (this.config.graphManager) {
    components.neo4j = "initializing";
  } else if (process.env["NEO4J_URI"]) {
    components.neo4j = "not_connected";
    degraded = true;
  }
  // same for qdrant
}

// G11 — Surface Qdrant keyword-only fallback
if (this.config.hybridSearchEngine?.isKeywordOnly?.()) {
  components.search_mode = "keyword_only";
}
```

**HealthMonitor reference**: `this.healthMonitor` is already a member of `RestServer` — verify:
```bash
grep -n "healthMonitor" /Users/umasankr/Projects/ping-mem/src/http/rest-server.ts | head -10
```

**Why this is correct**: HealthMonitor runs `probeSystemHealth()` from `src/observability/health-probes.ts:116` on a background interval. The `/health` endpoint simply reads the cached result — zero latency added, honest status.

#### Task 1.2: Add `/api/v1/internal/readiness` Endpoint

**File**: `src/http/rest-server.ts`

**EVAL Amendment (security)**: Originally `/readiness` unauthenticated. Amended to `/api/v1/internal/readiness` — this mounts it under the existing `authMiddleware` (`/api/*` pattern at rest-server.ts:294–337). The endpoint exposes internal latency data and backend topology; it must require API key auth. ping-guard passes `PING_MEM_API_KEY` in the `Authorization` header.

A deep-check endpoint used by ping-guard every 5 minutes and manually post-wake. Uses existing `probeSystemHealth()` from `src/observability/health-probes.ts:116`.

```typescript
// Route: GET /api/v1/internal/readiness
// Auth: API key required (inherits from /api/* authMiddleware)
// Timeout budget: 10s total (probeSystemHealth already bounded)
// Response: { ready: boolean, checks: HealthSnapshot["components"], latencies: Record<string, number> }
```

**Implementation**: Delegate to existing infrastructure:
```typescript
import { probeSystemHealth } from "../observability/health-probes.js";
// ...in handler:
const snapshot = await probeSystemHealth({
  eventStore: this.eventStore,
  graphManager: this.config.graphManager,
  qdrantClient: this.config.qdrantClient,
});
const ready = snapshot.status === "ok";
return c.json({ ready, checks: snapshot.components }, ready ? 200 : 503);
```

**ping-guard manifest**: Update `readiness.endpoint` to `/api/v1/internal/readiness` and add:
```yaml
readiness:
  endpoint: "/api/v1/internal/readiness"
  headers:
    Authorization: "Bearer ${PING_MEM_API_KEY}"
```

#### Task 1.3: Add `POST /api/v1/internal/warm-up` Endpoint

**File**: `src/http/rest-server.ts`

**EVAL Amendment (security)**: Originally `/internal/warm-up` with no auth. Amended to `/api/v1/internal/warm-up` — mounted under `authMiddleware`. ping-guard passes `PING_MEM_API_KEY`. The warm-up performs connection pool resets, DDL operations (Neo4j constraints), and data mutations (canary write/delete); it must be authenticated.

Called by ping-guard after container recovery. Forces pool reset, constraint validation, and verifies full capability chain. Returns a structured warm-up report.

**Concurrency guard**: Add in-progress flag (`this.warmUpInProgress: boolean`). If called while already running, return `409 { "error": "warm-up already in progress" }`.

```typescript
// Route: POST /api/v1/internal/warm-up
// Auth: API key required (inherits from /api/* authMiddleware)
// Method: POST (triggers side effects — NOT idempotent)
// Timeout: 30s total

// Response type:
interface WarmUpReport {
  success: boolean;
  durationMs: number;
  steps: Array<{
    name: string;
    status: "ok" | "failed" | "skipped";
    durationMs: number;
    error?: string;
  }>;
}
```

**Steps executed in order**:

| Step | Action | Success criteria |
|------|--------|----------------|
| `sqlite_ping` | `eventStore.ping()` | Returns true |
| `neo4j_driver_reset` | `neo4jClient.disconnect()` → `neo4jClient.resetPolicies()` → `neo4jClient.connect()` | No exception |
| `neo4j_roundtrip` | `MATCH (n) RETURN count(n) LIMIT 1` with 4s timeout | Returns number |
| `qdrant_roundtrip` | `GET /collections/ping-mem-vectors` with 2s timeout | HTTP 200 |
| `canary_roundtrip` | Write key `warm-up-canary` → read it → delete it via service layer (not HTTP self-call) | Read returns written value |

**REVIEW Amendment**: Simplified from 9 steps to 5. Removed `neo4j_constraints` (maintenance, not recovery), `session_cleanup` (housekeeping, not recovery). Collapsed canary write/read/delete into one `canary_roundtrip` step.

**JUDGE Amendment (circuit breaker)**: `disconnect()+connect()` resets the Neo4j driver but NOT the cockatiel circuit breaker — `servicePolicy` is created in the constructor and survives reconnects by design. Post-wake, if the circuit opened on 5 consecutive failures, it stays OPEN until `halfOpenAfterMs: 30_000` elapses. The warm-up must call `neo4jClient.resetPolicies()` between `disconnect()` and `connect()` to create fresh circuit objects (CLOSED state). This ensures `neo4j_roundtrip` is not blocked by a stale OPEN circuit. See Task 1.4 for `resetPolicies()` implementation.

**Verify `disconnect`/`connect` on Neo4jClient**:
```bash
grep -n "async disconnect\|async connect" /Users/umasankr/Projects/ping-mem/src/graph/Neo4jClient.ts
```

**Integration point**: Register route in `rest-server.ts`. Inject `ingestionService` and `sessionManager` references already present on `RestServer` instance.

**Qdrant fallback signal** (G11): Surfaced via Task 1.1 HealthMonitor snapshot (`search_mode: "keyword_only"`). No additional work.

#### Task 1.4: Add `resetPolicies()` to Neo4jClient (JUDGE: circuit breaker reset required)

**JUDGE Amendment**: `disconnect()+connect()` is not sufficient. The cockatiel circuit breakers (`servicePolicy`, `writePolicy`) are created in the constructor and survive reconnects intentionally — this enables automatic half-open self-recovery under normal conditions. But in warm-up context, if the circuit opened post-wake, `neo4j_roundtrip` would fail immediately with `BrokenCircuitError` until `halfOpenAfterMs: 30_000` elapses (not guaranteed by the time warm-up is called). A `resetPolicies()` method creates fresh circuit objects (CLOSED state).

**File**: `src/graph/Neo4jClient.ts`

**Change 1**: Remove `readonly` modifier from `servicePolicy` and `writePolicy` (required for reassignment):
```typescript
// Before:
private readonly servicePolicy: ServicePolicy;
private readonly writePolicy: ServicePolicy;

// After:
private servicePolicy: ServicePolicy;
private writePolicy: ServicePolicy;
```

**Change 2**: Add `resetPolicies()` method after the constructor:
```typescript
/**
 * Reset circuit breaker policies to CLOSED state.
 * Called during warm-up (after disconnect/connect) to prevent a stale OPEN
 * circuit from blocking the connectivity roundtrip probe.
 * Not for use in normal operation — rely on cockatiel half-open self-recovery instead.
 */
resetPolicies(): void {
  this.servicePolicy = createServicePolicy({
    name: "neo4j",
    consecutiveFailures: 5,
    halfOpenAfterMs: 30_000,
    maxRetries: 2,
    timeoutMs: 15_000,
  });
  this.writePolicy = createServicePolicy({
    name: "neo4j-write",
    consecutiveFailures: 5,
    halfOpenAfterMs: 30_000,
    maxRetries: 0,
    timeoutMs: 15_000,
  });
  this.servicePolicy.onStateChange((state) => {
    if (state === "open") log.error("Read circuit OPEN — Neo4j operations will fail fast", { state });
    else if (state === "half-open") log.info("Read circuit half-open — attempting recovery", { state });
    else log.info("Read circuit recovered", { state });
  });
  this.writePolicy.onStateChange((state) => {
    if (state === "open") log.error("Write circuit OPEN — Neo4j write operations will fail fast", { state });
    else if (state === "half-open") log.info("Write circuit half-open — attempting write recovery", { state });
    else log.info("Write circuit recovered", { state });
  });
}
```

**Safety note on onStateChange handlers**: The only `onStateChange` registrations in the codebase are the two log handlers in the Neo4jClient constructor (lines 190–207). No external consumer registers handlers on the policy objects. Resetting policies via `resetPolicies()` therefore drops only those log handlers, which are re-registered inside `resetPolicies()`. This is safe. Verify before editing:
```bash
grep -rn "onStateChange" /Users/umasankr/Projects/ping-mem/src/
# Expected: only matches in Neo4jClient.ts and QdrantClient.ts (each registers its own handlers on its own policy)
```

**Verify existing method names**:
```bash
grep -n "async disconnect\|async connect\|private.*servicePolicy\|private.*writePolicy" \
  /Users/umasankr/Projects/ping-mem/src/graph/Neo4jClient.ts
```

**Phase 1 gate**:
```bash
# Start ping-mem with Neo4j stopped — /health must return degraded (from HealthMonitor cache, after 60s)
docker stop ping-mem-neo4j && sleep 65
curl -s http://localhost:3003/health | jq '.components.neo4j'
# Expected: "degraded" (HealthMonitor probed and cached the failure)

# /api/v1/internal/readiness must return 503 (immediate deep probe)
curl -s -H "Authorization: Bearer $PING_MEM_API_KEY" \
  http://localhost:3003/api/v1/internal/readiness | jq '.ready'
# Expected: false

# After warm-up: full steps succeed
curl -s -X POST -H "Authorization: Bearer $PING_MEM_API_KEY" \
  http://localhost:3003/api/v1/internal/warm-up | jq '.success'
# Expected: true (after Neo4j restarted)
```

---

### Phase 2: Proxy-CLI Hardening (Owner: ping-mem)
**Effort**: ~2h | **Prerequisite for**: OpenCode + Codex reliable startup
**Quality gate**: Proxy starts when Docker is down, waits 30s, then accepts tool calls successfully

#### Task 2.1: Startup Readiness Poll

**File**: `src/mcp/proxy-cli.ts`

**Current behavior** (lines 186–196): Checks health once, if down calls `tryStartDocker()` fire-and-forget, then immediately starts stdio transport.

**New behavior**: After `tryStartDocker()`, poll `/health` with 2s intervals for up to 30s before starting stdio. Buffer incoming tool calls during poll (MCP stdio protocol supports this — calls queue in the OS pipe buffer).

```typescript
// New function signature:
async function waitForServer(baseUrl: string, maxWaitMs: number = 30_000): Promise<boolean>
// Polls GET /health every 2s
// Returns true if server responds with ok within maxWaitMs
// Returns false (timeout) — proxy still starts, but logs clear warning
```

**EVAL Amendment (performance)**: Cap startup poll at 10s (not 30s). Claude Code MCP client has a ~30s connection timeout; a 30s poll could drop the connection. 10s gives Docker time to start common fast cases without risking timeout.

**REVIEW Amendment**: Loopback URL validation removed. Not needed for local dev tool — threat model (env poisoning → SSRF) doesn't apply, and the check would break legitimate future cases (LAN VM, container network).

**Replace** lines 186–196:
```typescript
// NEW:
let isHealthy = await checkDockerHealth(BASE_URL);
if (!isHealthy) {
  process.stderr.write(`[ping-mem proxy] Docker not reachable at ${BASE_URL} — starting containers...\n`);
  await tryStartDocker();
  isHealthy = await waitForServer(BASE_URL, 10_000);  // ← 10s cap (was 30s)
  if (!isHealthy) {
    process.stderr.write(`[ping-mem proxy] WARNING: Server not ready within 10s. Tool calls will fail until Docker is up.\n`);
  } else {
    process.stderr.write(`[ping-mem proxy] Server ready after startup wait.\n`);
  }
} else {
  process.stderr.write(`[ping-mem proxy] Connected to ${BASE_URL}\n`);
}
```

#### Task 2.2: Configurable Tool Call Timeout

**File**: `src/mcp/proxy-cli.ts`

**Current**: Line 95 hardcodes `AbortSignal.timeout(30_000)`.

**New**:
```typescript
// At top of file, after BASE_URL:
const TOOL_TIMEOUT_MS = parseInt(process.env["MCP_TOOL_TIMEOUT_MS"] ?? "15000", 10);

// Long-running tools get 120s regardless:
const LONG_RUNNING_TOOLS = new Set([
  "codebase_ingest", "codebase_verify", "transcript_mine",
  "dreaming_run", "memory_consolidate", "memory_compress",
  "memory_maintain"
]);

// In proxyToolCall():
const timeoutMs = LONG_RUNNING_TOOLS.has(name) ? 120_000 : TOOL_TIMEOUT_MS;
signal: AbortSignal.timeout(timeoutMs),
```

**Phase 2 gate**:
```bash
# Stop Docker, start proxy — should wait 30s then warn (not crash)
docker compose down
PING_MEM_REST_URL=http://localhost:3003 bun run dist/mcp/proxy-cli.js &
# Expect: "starting containers..." then "Server ready" or "WARNING: Server did not become ready"
# Then start Docker — proxy should work without restart
```

---

### Phase 3: Client Config Migration + Hook Hardening (Owner: client configs)
**Effort**: ~1h | **Prerequisite**: Phase 2 quality gate must be passing before executing Phase 3
**Quality gate**: OpenCode and Codex MCP tool calls route through REST, not direct SQLite; verify no `PING_MEM_DB_PATH` in spawned process env; Claude Code hooks complete within 10s

#### Task 3.1: Add OpenCode ping-mem MCP Server Config

**File**: `~/.config/opencode/opencode.json`

**VERIFY Fix**: OpenCode does NOT currently have a ping-mem MCP server entry. This is an addition, not a migration. The config file has custom commands but no `mcp` servers section for ping-mem.

**Add** to the `mcp` section (or create it if absent):
```json
"mcp": {
  "ping-mem": {
    "type": "local",
    "command": ["bun", "run", "/Users/umasankr/Projects/ping-mem/dist/mcp/proxy-cli.js"],
    "environment": {
      "PING_MEM_REST_URL": "http://localhost:3003"
    },
    "enabled": true
  }
}
```

**Why**: Uses proxy-cli.js from the start (no legacy direct SQLite to migrate away from). Every tool call routes through `POST /api/v1/tools/{name}/invoke` on the REST server.

**Before adding**: Verify the config file structure:
```bash
cat ~/.config/opencode/opencode.json | jq 'keys'
# Check what top-level keys exist (mcp, commands, etc.)
```

#### Task 3.2: Migrate Codex to Proxy REST

**File**: `~/.codex/config.toml`

**Current**:
```toml
[mcp_servers.ping-mem]
command = "bun"
args = [ "run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js" ]

[mcp_servers.ping-mem.environment]
PING_MEM_DB_PATH = "/Users/umasankr/.ping-mem/codex.db"
PING_MEM_DIAGNOSTICS_DB_PATH = "/Users/umasankr/.ping-mem/codex-diagnostics.db"
NEO4J_URI = "bolt://localhost:7687"
NEO4J_USERNAME = "neo4j"
NEO4J_PASSWORD = "neo4j_password"
QDRANT_URL = "http://localhost:6333"
QDRANT_COLLECTION_NAME = "ping-mem-vectors"
QDRANT_VECTOR_DIMENSIONS = "768"
```

**New**:
```toml
[mcp_servers.ping-mem]
command = "bun"
args = [ "run", "/Users/umasankr/Projects/ping-mem/dist/mcp/proxy-cli.js" ]

[mcp_servers.ping-mem.environment]
PING_MEM_REST_URL = "http://localhost:3003"
```

#### Task 3.3: Claude Code Hook Hardening (REVIEW: merged from Phase 4)

**Files**: `~/.claude/hooks/ping-mem-native-sync.sh`, `~/.claude/hooks/ping-mem-auto-recall.sh`

**Task 3.3a — Session creation timeout** (`ping-mem-native-sync.sh`):

Add `--connect-timeout 2 --max-time 5` to all session management curl calls (lines ~41, ~86, ~95):
```bash
# grep -n "curl -s" ~/.claude/hooks/ping-mem-native-sync.sh | grep -v "max-time"
# Add --connect-timeout 2 --max-time 5 to each matching line
```

**Task 3.3b — Fix session cache file permissions** (`ping-mem-native-sync.sh`):

`~/.ping-mem/sync-session-id` is world-readable (644). Add `chmod 600` after writing:
```bash
# grep -n "sync-session-id\|SYNC_SESSION_CACHE" ~/.claude/hooks/ping-mem-native-sync.sh | head -5
# After the write line, add: chmod 600 "$SYNC_SESSION_CACHE"
```

**Task 3.3c — Session recovery on stale cache** (`ping-mem-auto-recall.sh`):
```bash
# After any 4xx/5xx on session operation:
rm -f "$SYNC_SESSION_CACHE"
# Then create new session
```

**Also before closing Phase 3**: Verify auto-os has no direct `cli.js` spawn:
```bash
grep -rn "dist/mcp/cli.js\|mcp/cli" ~/Projects/auto-os/ 2>/dev/null
# Expected: no matches (auto-os uses direct REST, not MCP stdio)
```

**Phase 3 gate**:
```bash
# No direct DB access in spawned process
ps aux | grep proxy-cli
# Confirm dist/mcp/proxy-cli.js (not cli.js) in process args

# Phase 2 must already be passing before this runs
# Hook timing
time bash ~/.claude/hooks/ping-mem-native-sync.sh
# Expected: ≤10s
```

---

### Phase 5: ping-guard Manifest Updates + Canaries (Owner: ping-guard)
**Effort**: ~1h | **File**: `/Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml`
**Prerequisite**: Phase 1 quality gate must be passing before deploying Phase 5 (the recovery pattern calls `POST /api/v1/internal/warm-up` — that route must exist)
**Quality gate**: ping-guard canary chain detects ping-mem down within 5min; recovery triggers warm-up

#### Task 5.1: Update Health Check to Use `/api/v1/internal/readiness`

**Current** (lines 13–20): `health.endpoint: "/health"` with `expect_components: [sqlite, neo4j, qdrant]`.

**JUDGE Amendment**: Live manifest uses `docker_restart`, `command`, `cypher` — NOT `docker`, `http`, `script`. Task 5.2 uses `command` type exclusively for multi-step recovery sequences.

**New**: Keep `/health` for 60s liveness polling. Add `/api/v1/internal/readiness` probe at 5min intervals.

```yaml
services:
  - name: "ping-mem"
    health:
      endpoint: "/health"                     # Liveness — fast, every 60s
      port: 3003
      timeout_ms: 5000
      interval_ms: 60000
    readiness:                                # NEW: Deep check, every 5min
      endpoint: "/api/v1/internal/readiness"
      port: 3003
      timeout_ms: 10000
      interval_ms: 300000
      headers:
        Authorization: "Bearer ${PING_MEM_API_KEY}"
      expect_ready: true
```

```yaml
watch:
  probe_interval_ms: 60000
  canary_interval_ms: 300000
  # Note: REVIEW determined canary stagger (150s offset) is YAGNI for this setup.
  # If DB load at 5min boundary becomes a problem, add canary_initial_delay_ms: 150000.
```

#### Task 5.2: Add Post-Recovery Warm-Up Action

**Current recovery patterns** (lines 162–184): After `docker compose restart ping-mem`, no follow-up action.

**JUDGE Amendment (action types)**: The live manifest uses exactly three action types: `docker_restart` (with `container`), `command` (with `command` string), and `cypher` (with `query` string). The `ManifestGuardPattern.recover` struct only supports a single chained step via `then: string` + `then_container: string` — and `then` can only chain another `docker_restart`. There is no `http`, `script`, or multi-step chaining for mixed types.

To add warm-up after container restart, replace the existing `docker_restart` patterns with `command` type that runs the full recovery sequence in a single shell command. This is the only way to chain container restart + health wait + warm-up curl with the current manifest executor.

**Update these patterns** (lines 163–196 of `manifests/ping-mem.yaml`):

```yaml
guard:
  patterns:
    - name: "neo4j_disconnected"
      detect:
        field: "health.components.neo4j"
        operator: "!="
        value: "ok"
      recover:
        type: "command"
        command: >-
          docker compose -f /Users/umasankr/Projects/ping-mem/docker-compose.yml restart ping-mem-neo4j
          && sleep 20
          && docker compose -f /Users/umasankr/Projects/ping-mem/docker-compose.yml restart ping-mem
          && sleep 10
          && curl -sf -X POST -H "Authorization: Bearer $PING_MEM_API_KEY"
             http://localhost:3003/api/v1/internal/warm-up
      cooldown_ms: 60000

    - name: "qdrant_disconnected"
      detect:
        field: "health.components.qdrant"
        operator: "!="
        value: "ok"
      recover:
        type: "command"
        command: >-
          docker compose -f /Users/umasankr/Projects/ping-mem/docker-compose.yml restart ping-mem-qdrant
          && sleep 15
          && docker compose -f /Users/umasankr/Projects/ping-mem/docker-compose.yml restart ping-mem
          && sleep 10
          && curl -sf -X POST -H "Authorization: Bearer $PING_MEM_API_KEY"
             http://localhost:3003/api/v1/internal/warm-up
      cooldown_ms: 60000

    - name: "ping_mem_down"
      detect:
        field: "health.status"
        operator: "=="
        value: "unreachable"
      recover:
        type: "command"
        command: >-
          docker compose -f /Users/umasankr/Projects/ping-mem/docker-compose.yml restart ping-mem
          && sleep 10
          && curl -sf -X POST -H "Authorization: Bearer $PING_MEM_API_KEY"
             http://localhost:3003/api/v1/internal/warm-up
      cooldown_ms: 30000

    - name: "sqlite_corrupt_indexes"
      detect:
        field: "observability.sqlite.integrity_ok"
        operator: "=="
        value: 0
      recover:
        type: "command"
        command: "sqlite3 ~/.ping-mem/ping-mem.db 'REINDEX;'"
      cooldown_ms: 300000

    - name: "neo4j_orphaned_nodes"
      detect:
        field: "observability.neo4j.null_node_count"
        operator: ">"
        value: 100
      recover:
        type: "cypher"
        query: "MATCH (c:Chunk) WHERE NOT EXISTS { MATCH (:File)-[:HAS_CHUNK]->(c) } WITH c LIMIT 500 DETACH DELETE c RETURN count(*)"
      cooldown_ms: 600000

    - name: "ollama_memory_hog"
      detect:
        field: "system.ollama_loaded_model_gb"
        operator: ">"
        value: 4
      recover:
        type: "command"
        command: "ollama stop $(ollama ps | tail -1 | awk '{print $1}')"
      cooldown_ms: 300000
```

**Prerequisite**: `PING_MEM_API_KEY` must be available in the shell environment where ping-guard's daemon runs. Verify it is set in the LaunchAgent plist's `EnvironmentVariables` key or in the shell profile sourced by launchd.

**Verify action types before editing**:
```bash
grep -n "type:" /Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml
# Expected: only "docker_restart", "command", "cypher"
```

#### Task 5.3: Add Client Reachability Canary

```yaml
canaries:
  client_proxy_canary:
    description: "Verify MCP tool invocation path works (proxy → REST → service layer)"
    steps:
      - step: "invoke_context_health"
        method: "POST"
        path: "/api/v1/tools/context_health/invoke"
        headers:
          Authorization: "Bearer ${PING_MEM_API_KEY}"
        body: '{"args":{}}'
        assert:
          status: 200
          field: "result"
          not_contains: "PROXY_NETWORK_ERROR"
    interval_ms: 300000
    initial_delay_ms: 150000   # staggered with readiness probe
```

**Phase 5 gate**:
```bash
# Stop ping-mem — ping-guard should detect within 60s, restart, warm-up, re-verify
docker compose -f /Users/umasankr/Projects/ping-mem/docker-compose.yml stop ping-mem
# Watch ping-guard logs:
tail -f ~/.ping-guard/logs/daemon.log
# Expected sequence within 3min:
# "ping-mem health check failed"
# "Executing recovery: ping-mem-down"
# "docker compose restart ping-mem"
# "Waiting for health..."
# "warm-up triggered"
# "capability_chain: PASS"
```

---

## Wiring Matrix

Every capability has a user trigger, call path, and test.

| # | Capability | User Trigger | Call Path (file:line) | Integration Test |
|---|-----------|-------------|----------------------|----------------|
| W1 | Honest health status | ping-guard polls `/health` every 60s | `proxy-cli.ts:checkDockerHealth` → `GET /health` → `rest-server.ts:363(amended)` → reads `healthMonitor.lastSnapshot.components` | Stop Neo4j, wait 90s → `/health` returns `components.neo4j:"degraded"` |
| W2 | Deep readiness check | ping-guard polls `/api/v1/internal/readiness` every 5min | `ping-guard manifest readiness probe` → `GET /api/v1/internal/readiness` → `rest-server.ts:(new route)` → `probeSystemHealth()` from `health-probes.ts:116` | Stop Qdrant → `/api/v1/internal/readiness` returns `503, ready:false` within 5s |
| W3 | Post-recovery warm-up | ping-guard sends `POST /api/v1/internal/warm-up` after restart | `recovery pattern (command action: curl warm-up) → rest-server.ts:(new route)` → sqlite_ping → neo4j_driver_reset (disconnect+resetPolicies+connect) → neo4j_roundtrip → qdrant_roundtrip → canary_roundtrip | Run warm-up manually → all 5 steps return "ok" |
| W4 | OpenCode memory save | OpenCode user saves memory via MCP tool | `opencode.json → bun proxy-cli.js` → `POST /api/v1/tools/context_save/invoke` → `rest-server.ts:invoke handler` → SQLite write | OpenCode: call `context_save` tool → verify in `GET /api/v1/context/{key}` |
| W5 | Codex memory search | Codex user searches memory via MCP | `config.toml → bun proxy-cli.js` → `POST /api/v1/tools/context_search/invoke` | Codex: call `context_search` tool → returns results |
| W6 | Claude Code auto-recall | Every user prompt in Claude Code | `settings.json hook → ping-mem-auto-recall.sh` → `POST /api/v1/memory/auto-recall` | Time hook to ≤5s; verify recall injects context |
| W7 | ping-guard detects failure | ping-mem container stops | `daemon.ts WatchEngine` → probe every 60s → health check returns error → pattern match → recovery actions | Stop ping-mem → daemon log shows "alert" + restart within 3min |
| W8 | Startup recovery from Docker down | Proxy spawned while Docker stopped | `proxy-cli.ts:186-196(new)` → `tryStartDocker()` → `waitForServer(30s)` | Kill Docker, spawn proxy → within 30s proxy accepts tool calls |
| W9 | Session recovery after stale cache | Hook finds cached session gone | `ping-mem-auto-recall.sh:79-93(fix)` → clear cache → create new session | Set stale session ID → hook recovers and returns recall results |

---

## Database Schema Definitions

No new tables. Existing tables are unchanged. The warm-up endpoint uses existing EventStore (SQLite) and TemporalCodeGraph (Neo4j) read/write APIs.

Canary write/read/delete uses existing `context_*` REST endpoints — no schema changes.

---

## Function Signatures

### New: `waitForServer` (proxy-cli.ts)
```typescript
async function waitForServer(
  baseUrl: string,
  maxWaitMs: number = 30_000,
  pollIntervalMs: number = 2_000
): Promise<boolean>
// Returns true if GET /health responds 200 within maxWaitMs
// Returns false on timeout (caller logs warning, continues)
```

### Existing (USE — do not recreate): `probeSystemHealth` (src/observability/health-probes.ts:116)
```typescript
// ALREADY EXISTS — verified at src/observability/health-probes.ts:116
export async function probeSystemHealth(deps: HealthProbeDeps): Promise<HealthSnapshot>
// HealthProbeDeps: { eventStore, graphManager?, qdrantClient? }
// HealthSnapshot: { status: "ok"|"degraded"|"unhealthy", components: Record<string, string>, ... }
// Used by /api/v1/internal/readiness handler (Task 1.2)
```

### New: `resetPolicies` (src/graph/Neo4jClient.ts)
```typescript
resetPolicies(): void
// Recreates this.servicePolicy and this.writePolicy as fresh cockatiel circuit breakers (CLOSED state).
// Called by warm-up handler between disconnect() and connect() to unblock neo4j_roundtrip
// when a stale OPEN circuit would otherwise reject all execute() calls.
// NOT for normal operation — normal self-recovery relies on cockatiel half-open probing.
// Requires: servicePolicy and writePolicy changed from readonly to mutable.
```

### New: `handleWarmUp` (rest-server.ts — route handler)
```typescript
// Route: POST /api/v1/internal/warm-up
// Auth: API key (via authMiddleware on /api/*)
async function handleWarmUp(
  c: Context,
  eventStore: EventStore,
  graphManager: TemporalCodeGraph | undefined,
  qdrantClient: QdrantClientWrapper | undefined,  // ← QdrantClientWrapper, not QdrantClient
  ingestionService: IngestionService | undefined,
  sessionManager: SessionManager
): Promise<Response>
// Returns: WarmUpReport (see Task 1.3 above)
// Total timeout budget: 30s
// Concurrency guard: returns 409 if warmUpInProgress === true
```

### New: `handleReadiness` (rest-server.ts — route handler)
```typescript
// Route: GET /api/v1/internal/readiness
// Auth: API key (via authMiddleware on /api/*)
async function handleReadiness(
  c: Context,
  eventStore: EventStore,
  graphManager: TemporalCodeGraph | undefined,
  qdrantClient: QdrantClientWrapper | undefined   // ← QdrantClientWrapper
): Promise<Response>
// Delegates to probeSystemHealth() from src/observability/health-probes.ts
// Returns: { ready: boolean, checks: HealthSnapshot["components"] }
// HTTP 200 if ready:true, HTTP 503 if ready:false
```

---

## Integration Points

| Point | File | Before | After |
|-------|------|--------|-------|
| `/health` honest status | `src/http/rest-server.ts:363-401` | Passive object existence check | Read `healthMonitor.lastSnapshot.components` (HealthMonitor already probes on 60s interval) |
| `/api/v1/internal/readiness` route | `src/http/rest-server.ts` (new route under `/api/*`) | Does not exist | New handler delegates to `probeSystemHealth()` from `src/observability/health-probes.ts:116`; API key required |
| `/api/v1/internal/warm-up` route | `src/http/rest-server.ts` (new route under `/api/*`) | Does not exist | New handler `handleWarmUp()`; API key required; concurrency guard; calls `neo4jClient.resetPolicies()` in driver-reset step |
| Proxy startup retry | `src/mcp/proxy-cli.ts:186-196` | Fire-and-forget Docker start, immediate stdio | Calls `waitForServer(30s)` after `tryStartDocker()` |
| Proxy tool timeout | `src/mcp/proxy-cli.ts:95` | Hardcoded `AbortSignal.timeout(30_000)` | `MCP_TOOL_TIMEOUT_MS` env var, long-running tool set |
| OpenCode command | `~/.config/opencode/opencode.json` | `dist/mcp/cli.js` + direct DB env vars | `dist/mcp/proxy-cli.js` + `PING_MEM_REST_URL` only |
| Codex command | `~/.codex/config.toml` | `dist/mcp/cli.js` + direct DB env vars | `dist/mcp/proxy-cli.js` + `PING_MEM_REST_URL` only |
| Session creation timeout | `~/.claude/hooks/ping-mem-native-sync.sh:41,86` | No `--max-time` on curl | `--connect-timeout 2 --max-time 5` |
| ping-guard daemon | `~/Library/LaunchAgents/` | `com.ping-guard.observe-ping-mem.plist` → missing file | `com.ping-guard.daemon.plist` (KeepAlive=true) |
| Neo4j circuit breaker reset | `src/graph/Neo4jClient.ts:servicePolicy,writePolicy` | `private readonly` (no reset API) | `private` (mutable); new `resetPolicies()` creates fresh CLOSED breakers |
| ping-guard post-recovery | `ping-guard/manifests/ping-mem.yaml` recovery patterns | `docker_restart` chain, no warm-up | `command` type: container restart + sleep + curl warm-up in one shell command |

---

## Canaries

### C1: ping-guard Liveness Canary (every 60s)
```
Target: GET http://localhost:3003/health
Expect: HTTP 200, body.status in ["ok", "degraded"]
Failure signal: HTTP non-200 or connection refused → service down
Owner: ping-guard WatchEngine
Recovery: ping-mem-down pattern
```

### C2: ping-guard Readiness Canary (every 5min)
```
Target: GET http://localhost:3003/api/v1/internal/readiness
Expect: HTTP 200, body.ready == true
Failure signal: HTTP 503 or ready:false → backend degraded
Owner: ping-guard WatchEngine
Recovery: neo4j-disconnected or qdrant-disconnected pattern depending on which check failed
```

### C3: ping-guard Capability Chain (every 5min)
```
7-step chain already in ping-mem.yaml:
  POST /session/start → POST /context → GET /search → POST /memory/auto-recall
  → GET /context/{key} → DELETE /context/{key} → POST /session/end
Expect: each step returns expected fields; score > 0.3
Failure signal: any step fails → partial capability failure
Owner: ping-guard WatchEngine
Recovery: capability_chain restart pattern (→ warm-up → re-run canary)
```

### C4: Client Proxy Canary (every 5min)
```
Target: POST http://localhost:3003/api/v1/tools/context_health/invoke
Body: {"args":{}}
Expect: HTTP 200, body.result does not contain "PROXY_NETWORK_ERROR"
Failure signal: tool invocation path broken (proxy route misconfigured)
Owner: ping-guard WatchEngine
Recovery: alert only (this path should be stable; failure = config regression)
```

### C5: End-to-End Post-Warm-Up Canary (on-demand, triggered by recovery)
```
Trigger: immediately after POST /api/v1/internal/warm-up completes successfully
Action: run capability_chain (C3) once
Expect: all 7 steps pass
Failure: alert + log + re-run warm-up once more
Owner: ping-guard recovery pattern (assert action in Task 5.2)
```

---

## Recovery Recipes

### R1: ping-mem Container Down
**Detection**: C1 fails (connection refused on port 3003)
**Owner**: ping-guard
**Steps**:
1. `docker compose -f .../docker-compose.yml restart ping-mem`
2. Poll `GET /health` every 5s, max 120s
3. `POST /internal/warm-up` — wait for `success:true`
4. Run C3 capability chain — must pass
5. Telegram alert: "ping-mem recovered in Xs"

**Verification command**:
```bash
curl -s http://localhost:3003/health | jq '.status'
# Expected: "ok"
curl -s -X POST -H "Authorization: Bearer $PING_MEM_API_KEY" \
  http://localhost:3003/api/v1/internal/warm-up | jq '.success'
# Expected: true
```

### R2: Neo4j Disconnected (post-wake)
**Detection**: C2 fails with `checks.neo4j_probe == "degraded"` OR C1 returns `components.neo4j == "degraded"`
**Owner**: ping-guard
**Steps**:
1. `docker compose restart ping-mem-neo4j`
2. Wait for Neo4j healthy (`cypher-shell RETURN 1`, max 60s)
3. `docker compose restart ping-mem` (flushes connection pool)
4. Poll `/health` every 5s, max 120s
5. `POST /api/v1/internal/warm-up` (auth: Bearer $PING_MEM_API_KEY)
6. Run C3 — must pass

### R3: Qdrant Disconnected (post-wake)
**Detection**: C2 fails with `checks.qdrant_probe == "degraded"` OR C1 returns `components.qdrant == "degraded"`
**Owner**: ping-guard
**Steps**:
1. `docker compose restart ping-mem-qdrant`
2. Wait for Qdrant TCP healthy (port 6333, max 30s)
3. `docker compose restart ping-mem`
4. Poll `/health`, max 60s
5. `POST /api/v1/internal/warm-up` (auth: Bearer $PING_MEM_API_KEY)
6. Run C3 — must pass

### R4: Proxy Startup Race (Docker starting when proxy spawned)
**Detection**: Proxy-cli logs "Server did not become ready within 30s"
**Owner**: proxy-cli (self-healing)
**Steps**:
1. Proxy already attempted `tryStartDocker()` and polled 30s
2. Proxy starts stdio transport with degraded mode warning
3. First tool call: proxy returns `PROXY_NETWORK_ERROR` with clear message
4. Client (OpenCode/Codex) retries — by this time Docker is likely up
5. No external intervention needed for transient cases

**Manual escalation**: If Docker never comes up after 5min, Telegram alert from ping-guard C1 failure.

### R5: Stale MCP Session
**Detection**: REST API returns 404 with `"sessionId not found"` on a session operation
**Owner**: proxy-cli (for OpenCode/Codex), hook script (for Claude Code)
**Steps**:
- proxy-cli: next tool call creates a fresh session (existing behavior — sessions are per-tool-call in proxy mode, stateless)
- Claude Code hooks: `ping-mem-auto-recall.sh` clears cache file → creates new session (after Task 4.2 fix)

### R6: OrbStack Not Running (cold boot)
**Detection**: `tryStartDocker()` in proxy-cli, OR ping-guard C1 fails immediately after boot
**Owner**: proxy-cli first, ping-guard if sustained
**Steps** (ping-guard):
1. Detect Docker daemon not responding (port 3003 unreachable)
2. `open -a OrbStack` (as in existing `self_heal.py:45`)
3. Wait 10s for Docker daemon
4. `docker compose up -d` for ping-mem stack
5. Then follow R1 steps

---

## Ownership Matrix

| Responsibility | Owner | Mechanism |
|---------------|-------|-----------|
| Detect ping-mem down | ping-guard daemon | Health poll every 60s |
| Detect Neo4j/Qdrant degraded | ping-guard daemon | Readiness poll every 5min |
| Detect wake event | auto-os resilience plan (PyObjC hook → ping-guard runOnce) | Out of this plan's scope |
| Restart containers | ping-guard | Recovery patterns in manifest |
| Post-recovery warm-up | ping-guard triggers → ping-mem executes | `POST /api/v1/internal/warm-up` (auth: Bearer $PING_MEM_API_KEY) |
| Client connection via REST | All clients (proxy-cli.js) | P3 config migration |
| Session timeout/recovery | Claude Code hooks (P4), proxy-cli (P2) | Per-client hook fix |
| Telegram alerts | ping-guard TelegramNotifier | On pattern trigger |
| Capability canary | ping-guard WatchEngine | C3/C4 in manifest |

---

## Verification Checklist

Structural checks — binary PASS/FAIL:

```bash
# V1: /health reads HealthMonitor cache (not passive object check)
grep -n "getStatus\(\)\|lastSnapshot" src/http/rest-server.ts
# PASS: matches found (Task 1.1 amendment: uses healthMonitor.getStatus().lastSnapshot)

# V2: /api/v1/internal/readiness route exists
grep -n 'internal/readiness' src/http/rest-server.ts
# PASS: match found

# V3: /api/v1/internal/warm-up route exists
grep -n 'internal/warm-up' src/http/rest-server.ts
# PASS: match found

# V4: waitForServer function in proxy-cli
grep -n "waitForServer\|async function waitForServer" src/mcp/proxy-cli.ts
# PASS: match found

# V5: MCP_TOOL_TIMEOUT_MS env var in proxy-cli
grep -n "MCP_TOOL_TIMEOUT_MS" src/mcp/proxy-cli.ts
# PASS: match found

# V6: OpenCode config uses proxy-cli.js
grep "proxy-cli" ~/.config/opencode/opencode.json
# PASS: match found

# V7: Codex config uses proxy-cli.js
grep "proxy-cli" ~/.codex/config.toml
# PASS: match found

# V8: OpenCode has no direct DB vars
grep "PING_MEM_DB_PATH\|NEO4J_URI\|QDRANT_URL" ~/.config/opencode/opencode.json
# PASS: no match (empty result)

# V9: ping-guard daemon plist installed and running
launchctl list | grep com.ping-guard.daemon
# PASS: line has a PID (not -)

# V10: stale plist removed
ls ~/Library/LaunchAgents/ | grep observe-ping-mem
# PASS: no output

# V11: observe-ping-mem.ts exists
ls /Users/umasankr/Projects/ping-guard/cli/observe-ping-mem.ts
# PASS: file found

# V12: Session curl calls have --max-time
grep -n "max-time\|connect-timeout" ~/.claude/hooks/ping-mem-native-sync.sh
# PASS: multiple matches

# V13: ping-guard manifest recovery patterns use correct types and reference warm-up endpoint
grep -n "internal/warm-up" /Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml
# PASS: matches in command field of recovery patterns
# (types are: docker_restart, command, cypher — never docker/http/script)

# V14: typecheck passes
cd /Users/umasankr/Projects/ping-mem && bun run typecheck
# PASS: 0 errors

# V15: tests pass
cd /Users/umasankr/Projects/ping-mem && bun test
# PASS: 0 failures
```

---

## Functional Tests

Runtime tests that verify behavior, not just structure:

| # | Test | Command | Expected Output | Gate |
|---|------|---------|-----------------|------|
| FT1 | /health honest status (uses HealthMonitor cache) | `docker stop ping-mem-neo4j && sleep 65 && curl -s http://localhost:3003/health \| jq '.components.neo4j'` | `"degraded"` | P1 |
| FT2 | /readiness fails when backend down (immediate) | `curl -s -H "Authorization: Bearer $PING_MEM_API_KEY" -o /dev/null -w "%{http_code}" http://localhost:3003/api/v1/internal/readiness` (Neo4j stopped) | `503` | P1 |
| FT3 | warm-up succeeds | `curl -s -X POST -H "Authorization: Bearer $PING_MEM_API_KEY" http://localhost:3003/api/v1/internal/warm-up \| jq '.success'` | `true` | P1 |
| FT4 | warm-up steps all ok | `curl -s -X POST -H "Authorization: Bearer $PING_MEM_API_KEY" http://localhost:3003/api/v1/internal/warm-up \| jq '[.steps[].status] \| all(. == "ok")'` | `true` | P1 |
| FT5 | proxy waits for Docker | `docker compose down && bun run dist/mcp/proxy-cli.js 2>&1 \| head -5` | Contains "starting containers" then "ready" or "WARNING" | P2 |
| FT6 | OpenCode routes via REST | After P3: start OpenCode, call context_save tool, verify via `GET /api/v1/context/{key}` returns value | Key exists in REST API | P3 |
| FT7 | Codex routes via REST | Same as FT6 for Codex | Key exists | P3 |
| FT8 | Hook session timeout | `time bash ~/.claude/hooks/ping-mem-native-sync.sh` (with slow server) | Completes in ≤10s | P4 |
| FT9 | ping-guard recovery cycle | `docker compose stop ping-mem && sleep 90 && curl -s http://localhost:3003/health \| jq '.status'` | `"ok"` (ping-guard recovered it) | P5 |
| FT10 | post-wake capability | Simulate wake: `docker compose restart && sleep 30 && curl -s -X POST -H "Authorization: Bearer $PING_MEM_API_KEY" http://localhost:3003/api/v1/internal/warm-up \| jq '.success'` | `true` | P1+P5 |
| FT11 | no direct SQLite (OpenCode) | `lsof \| grep opencode \| grep ping-mem.db` | Empty output | P3 |
| FT12 | ping-guard canary chain | Manual: `cat ~/.ping-guard/logs/daemon.log \| grep "capability_chain: PASS"` | Match found within 5min of starting daemon | P5 |

---

## Acceptance Criteria

### Functional
- [ ] **AC1**: After macOS sleep (any duration), within 3 minutes of wake: `curl http://localhost:3003/health` returns 200 with `status:"ok"` and all components ok
- [ ] **AC2**: After ping-guard recovers ping-mem (any restart), `POST /api/v1/internal/warm-up` returns `success:true` with all 5 steps ok
- [ ] **AC3**: OpenCode MCP tool `context_save` followed by `context_search` returns the saved memory — routed via REST, not SQLite
- [ ] **AC4**: Codex MCP tool `context_save` followed by `context_search` returns the saved memory — routed via REST
- [ ] **AC5**: `/health` returns `degraded` (not `ok`) within 90s of Neo4j or Qdrant container stopping (HealthMonitor probes on 60s interval; allow one full cycle)
- [ ] **AC6**: `/api/v1/internal/readiness` returns `503, ready:false` immediately (within 5s) when Neo4j or Qdrant is unreachable — no caching delay
- [ ] **AC7**: ping-guard daemon (`com.ping-guard.daemon`) runs continuously; `launchctl list | grep com.ping-guard.daemon` always shows a PID
- [ ] **AC8**: After a cold reboot, within 5 minutes: ping-guard starts, ping-mem stack starts, capability chain (C3) passes
- [ ] **AC9**: Claude Code SessionStart hook completes in ≤10s regardless of ping-mem response time
- [ ] **AC10**: No `PING_MEM_DB_PATH`, `NEO4J_URI`, or `QDRANT_URL` in any client MCP server config

### Non-Functional
- [ ] **NC1**: `/health` total response time ≤ 500ms under normal conditions (2s per probe but probes run in parallel)
- [ ] **NC2**: `/readiness` total response time ≤ 5s under normal conditions
- [ ] **NC3**: `POST /internal/warm-up` total time ≤ 15s under normal conditions (all 5 steps)
- [ ] **NC4**: `bun run typecheck` → 0 errors after all code changes
- [ ] **NC5**: `bun test` → 0 failures after all changes

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `waitForServer` delays proxy startup by 30s on cold Docker | Low (Docker usually up) | Low | 30s wait only triggers if Docker is down; normal startup unchanged |
| `observe-ping-mem.ts` uses `runOnce` that doesn't exist in daemon.ts | Medium | High | Verify `grep -n "export.*runOnce"` before writing. If missing, use `WatchEngine.tick()` directly |
| ping-guard daemon plist has wrong binary path for bun | Low | High | Verify plist ProgramArguments before installing: `cat /Users/umasankr/Projects/ping-guard/com.ping-guard.daemon.plist` |
| OpenCode doesn't support proxy-cli.js (different tool schema) | Low | High | Test before cutting over: run `bun run dist/mcp/proxy-cli.js` manually, invoke one tool, verify response matches expected schema |
| Concurrent `/internal/warm-up` calls (ping-guard triggers twice) | Low | Medium | Add mutex/in-progress flag in warm-up handler; second call returns 409 if one already running |
| warm-up `neo4j_reset_pool` drops active queries | Low | Low | Pool reset only touches idle connections; in-flight queries complete first (driver behavior) |
| /readiness 503 causes ping-guard to restart healthy containers | Medium | Medium | ping-guard manifest: use `/readiness` for alerting only, not as primary restart trigger. Primary restart trigger stays on `/health` (liveness). |

---

## Complete File Structure (Changes Only)

```
ping-mem/
├── src/
│   ├── http/
│   │   └── rest-server.ts          [MODIFY] — fix /health, add /readiness, add /internal/warm-up
│   ├── graph/
│   │   └── Neo4jClient.ts          [MODIFY] — remove readonly from servicePolicy/writePolicy, add resetPolicies()
│   └── mcp/
│       └── proxy-cli.ts            [MODIFY] — waitForServer(), MCP_TOOL_TIMEOUT_MS, LONG_RUNNING_TOOLS

ping-guard/
├── cli/
│   └── observe-ping-mem.ts         [CREATE] — thin entry-point for stale LaunchAgent plist
└── manifests/
    └── ping-mem.yaml               [MODIFY] — readiness probe, warm-up recovery action, client proxy canary

~/.config/opencode/
└── opencode.json                   [MODIFY] — migrate to proxy-cli.js

~/.codex/
└── config.toml                     [MODIFY] — migrate to proxy-cli.js

~/.claude/hooks/
├── ping-mem-native-sync.sh         [MODIFY] — add --max-time to session curl calls
└── ping-mem-auto-recall.sh         [MODIFY] — clear cache on stale session, session recovery

~/Library/LaunchAgents/
├── com.ping-guard.daemon.plist     [INSTALL — copy from ping-guard repo]
└── com.ping-guard.observe-ping-mem.plist  [REMOVE]
```

---

## Dependencies

| Dependency | Version | Status |
|-----------|---------|--------|
| Bun | ≥1.0 (already installed) | `bun --version` |
| Docker / OrbStack | current | Already running |
| Neo4j 5.25-community | pinned in docker-compose.yml | Already deployed |
| Qdrant v1.12.6 | pinned in docker-compose.yml | Already deployed |
| ping-guard | current HEAD | `/Users/umasankr/Projects/ping-guard` |
| @modelcontextprotocol/sdk | current (already in ping-mem deps) | `proxy-cli.ts` already uses it |

No new packages required for any phase.

---

## Success Metrics

| Metric | Baseline (today) | Target (after plan) | Measurement |
|--------|----------------|--------------------|-|
| `/health` accuracy post-wake | Lies (always ok) | Truthful: degraded when backends down | Stop Neo4j → check /health |
| ping-guard continuous monitoring | Not running | Running, canary passing every 5min | `launchctl list \| grep daemon` shows PID |
| Mean time to detect ping-mem down | Unknown (no monitoring) | ≤ 60s | Stop container → time until ping-guard log shows alert |
| Mean time to recover ping-mem | Manual (hours) | ≤ 3min (automated) | Stop container → time until C3 passes again |
| Client config direct-DB access | 2 clients (OpenCode, Codex) | 0 clients | `lsof` grep on ping-mem.db per client |
| Post-wake capability success rate | Intermittent failure | ≥ 99% (automated warm-up) | Daily post-wake smoke test via FT10 |
| SessionStart hook max time | Unbounded (curl default) | ≤ 10s | `time bash ping-mem-native-sync.sh` |

---

## Phased Rollout

```
Day 1, Morning:
  Phase 0 — ping-guard activation (30min, no code changes, just launchd + one ts file)
  Verify: daemon running, canary chain starts logging

Day 1, Afternoon:
  Phase 1 — ping-mem server hardening (3h, code changes, test gated)
  Verify: FT1-FT4 pass, typecheck clean

Day 2, Morning:
  Phase 2 — proxy-cli hardening (2h)
  Verify: FT5 passes

Day 2, Afternoon:
  Phase 3 — client config migration + hook hardening (1.5h, config + shell edits)
  (Task 3.3 hook hardening merged from old Phase 4 per REVIEW amendment)
  Verify: FT6, FT7, FT8, FT11 pass (no direct SQLite, hooks ≤10s)

Day 3:
  Phase 5 — ping-guard manifest update (1h)
  Verify: FT9, FT12 pass
  Full acceptance criteria sweep: AC1-AC10, NC1-NC5

Ongoing:
  Monitor ~/.ping-guard/logs/daemon.log daily
  Watch for degraded signals in /health
  Run FT10 (post-wake smoke test) after any macOS sleep >30min
```

---

## Relation to auto-os Resilience Plan

The auto-os resilience plan (`auto-os/docs/plans/2026-04-08-feat-sleep-wake-reboot-resilience-plan.md`, status: `ready`) covers:
- Wake detection via PyObjC / launchd wake notification
- launchd inventory reconciliation (stale plist removal for u-os and other namespaces)
- Scheduled-agent catch-up logic for missed heartbeat/morning/standup windows
- auto-os service monitoring (Telegram bot, web server, finance-web)

**This plan does NOT cover those items.** It covers the ping-mem-specific layer:
- ping-mem server reliability (honest health, warm-up)
- All-client proxy migration
- ping-guard activation and ping-mem manifest

The two plans execute in any order. After both complete, the full chain is:
```
macOS wake → auto-os wake detector → triggers ping-guard runOnce
ping-guard detects ping-mem state → restarts if needed → triggers warm-up
ping-mem warm-up → verifies full capability
All clients (Claude Code, OpenCode, Codex, auto-os) → REST proxy → working memory
```

---

## Evidence-Based Predictability Assessment

**Paper-verified claims** (verified across 3 EVAL agents + 3 VERIFY agents against live files):

| Claim | Verified | Source |
|-------|---------|--------|
| `/health` handler at `rest-server.ts:363-401` | ✓ | VERIFY agent read line 363 directly |
| `healthMonitor` is private member of RestServer | ✓ | `rest-server.ts:146` |
| `HealthMonitor.getStatus()` returns `lastSnapshot` | ✓ | `HealthMonitor.ts:189` |
| `probeSystemHealth` exported at `health-probes.ts:116` | ✓ | VERIFY agent read line 116 |
| `authMiddleware` covers `/api/*` at `rest-server.ts:315` | ✓ | VERIFY agent read line 315 |
| `Neo4jClient.disconnect()` at line 283 | ✓ | VERIFY agent read directly |
| `Neo4jClient.connect()` at line 216 | ✓ | VERIFY agent read directly |
| Circuit breaker `halfOpenAfterMs: 30_000` at Neo4jClient:173,181 | ✓ | VERIFY agent read directly |
| `proxy-cli.ts:95` has `AbortSignal.timeout(30_000)` | ✓ | VERIFY agent read line 95 |
| `HealthProbeDeps` interface at `health-probes.ts:41` | ✓ | VERIFY agent read lines 41-48 |
| Codex uses `dist/mcp/cli.js` | ✓ | `~/.codex/config.toml` read directly |
| `com.ping-guard.daemon.plist` in LaunchAgents | ✓ | `ls ~/Library/LaunchAgents/` confirmed |
| `WatchEngine.runOnce()` at `WatchEngine.ts:113` | ✓ | VERIFY agent read line 113 |
| `ping-guard/manifests/ping-mem.yaml` exists with capability_chain | ✓ | VERIFY agent confirmed |
| Session/start curl at hook line ~41 has no `--max-time` | ✓ | `ping-mem-native-sync.sh:41` read directly |
| `SESSION_CACHE="$HOME/.ping-mem/sync-session-id"` | ✓ | `ping-mem-native-sync.sh:25` |
| auto-os uses `PING_MEM_URL` env var | ✓ | grep over `~/Projects/auto-os/bin/` |
| OpenCode config has NO ping-mem MCP entry (G5 rewrite) | ✓ | `~/.config/opencode/opencode.json` read directly — key finding |

**Paper-verified: 18/18 structural claims verified.**

**Bugs fixed during VERIFY pass**:
- `healthMonitor.lastSnapshot` → `healthMonitor.getStatus().lastSnapshot` (private field access corrected)
- OpenCode MCP entry is absent → G5 rewritten as addition not migration

**Runtime unknowns** (cannot verify without execution):

| Unknown | Binary Test | Mitigation if fails |
|---------|------------|-------------------|
| `HealthComponent.status` field exists (for extraction in Task 1.1) | `grep -n "status.*ok\|status.*degraded" src/observability/health-probes.ts | head -5` | Map component strings directly if status field doesn't exist |
| OpenCode `opencode.json` schema allows `mcp.ping-mem` key structure | Test: add entry, restart OpenCode, `bun run dist/mcp/proxy-cli.js` in process list | Check OpenCode docs for MCP server config schema |
| ~~ping-guard `RecoverAction` type supports `http` and `script` action types~~ | RESOLVED: Live manifest uses `docker_restart`, `command`, `cypher` only. Task 5.2 uses `command` type. | N/A — resolved by JUDGE amendment |
