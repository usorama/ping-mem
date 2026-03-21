---
title: "fix: Container Restart Data Loss — Session Hydration, WAL Recovery, Single Container"
type: fix
date: 2026-03-15
status: completed
github_issues: [35]
github_pr: 36
research: "Codebase audit of 8 critical files + docker-compose analysis + docker-compose.prod.yml"
synthesis: "Inline — scoped bug fix, no separate synthesis needed"
eval_iteration: 0
review_iteration: 0
verification_iteration: 2
verification_method: "8-file codebase verification (grep + read), all claims verified against source, all conditional language resolved"
---

# Fix: Container Restart Data Loss

## Problem Statement

When the ping-mem Docker container restarts (crash, deploy, `docker-compose restart`), all active sessions are lost. Users must re-create sessions from scratch. Additionally, the WAL file grows unbounded (observed: 4.1MB WAL vs 225KB main DB), indicating broken checkpointing under dual-writer conditions.

### Evidence

1. **Sessions stored in-memory only**: `SessionManager.sessions` is a `Map<SessionId, Session>` (`src/session/SessionManager.ts:65`) — volatile, lost on process exit.
2. **`SessionManager.hydrate()` exists but is never called on startup**: `SessionManager.hydrate()` at line 84 rebuilds session state from EventStore. Neither `src/http/server.ts:134` nor `RESTPingMemServer.start()` nor `SSEPingMemServer` call it during initialization. **Note**: `rest-server.ts:428` calls `memoryManager.hydrate()` and `rest-server.ts:2156` calls `manager.hydrate()` — but these are `MemoryManager.hydrate()` (reconstructs memories for a single session), NOT `SessionManager.hydrate()` (reconstructs all sessions). These are distinct operations on different classes.
3. **Two containers share one SQLite file (dev only)**: `docker-compose.yml` lines 47+96 — both `ping-mem` and `ping-mem-rest` mount `ping-mem-data:/data` and write to `/data/ping-mem.db`. **Production (`docker-compose.prod.yml`) already uses a single container** with `PING_MEM_TRANSPORT=rest`, so this is a dev-only issue.
4. **WAL bloat**: `wal_autocheckpoint = 1000` (`EventStore.ts:210`) is set, but dual-writer contention prevents SQLite from completing checkpoints. HealthMonitor triggers PASSIVE checkpoints only when WAL exceeds **50MB** (`HealthMonitor.ts:270`: `walSize > 50_000_000`), which never block writers and silently fail under contention.
5. **No graceful shutdown for SessionManager in REST mode**: `server.ts` shutdown handler (lines 169-212) calls `serverInstance.stop()` at line 184. For SSE transport, `SSEPingMemServer.stop()` calls `toolServer.close()` which calls `sessionManager.close()` — **this path is already correct**. For REST transport, `RESTPingMemServer.stop()` (`rest-server.ts:2281`) closes pubsub, eventStore, and memory managers but does **NOT** call `sessionManager.close()` — **this is the gap**.

### Impact

- **Data loss**: Every container restart loses all in-memory session state
- **WAL corruption risk**: Dual-writer + no TRUNCATE checkpoint = unbounded WAL growth
- **User experience**: Claude Code, understory, and other MCP clients must re-establish sessions after any restart

## Proposed Solution

Five targeted fixes, ordered by dependency:

### Fix 1: Auto-hydrate sessions on startup

**What**: Call `SessionManager.hydrate()` during server initialization, before accepting requests.

**Wiring (verified)**: Both server types create SessionManager internally — it is NOT injected:
- `RESTPingMemServer` creates `this.sessionManager = new SessionManager({ eventStore })` at `rest-server.ts:136`
- `SSEPingMemServer` creates `this.toolServer = new PingMemServer({...})` at `sse-server.ts:68-81`, which internally creates its own SessionManager

Therefore, each server class must expose a `hydrateSessionState()` method that calls its own SessionManager.

**File 1**: `src/http/rest-server.ts`

Add method to `RESTPingMemServer`:
```typescript
async hydrateSessionState(): Promise<void> {
  await this.sessionManager.hydrate();
}
```

**File 2**: `src/http/sse-server.ts`

Add method to `SSEPingMemServer` (delegates to PingMemServer which owns SessionManager):
```typescript
async hydrateSessionState(): Promise<void> {
  await this.toolServer.hydrateSessionState();
}
```

And add to `PingMemServer` (`src/mcp/PingMemServer.ts`):
```typescript
async hydrateSessionState(): Promise<void> {
  await this.sessionManager.hydrate();
}
```

**File 3**: `src/http/server.ts` — Insert before line 135 (`await serverInstance.start()`):

**Before** (`server.ts:134-135`):
```typescript
// Start the server
await serverInstance.start();
```

**After**:
```typescript
// Hydrate sessions from persisted events before accepting requests
await serverInstance.hydrateSessionState();
// Start the server
await serverInstance.start();
```

**Verification**: `PTP-HYDRATE-1`: Start server -> create session -> restart server -> `GET /sessions` returns the previously created session.

**Test skeleton** (`tests/integration/session-hydration.test.ts`):
```typescript
import { describe, it, expect } from "bun:test";
import { SessionManager } from "../../src/session/SessionManager";
import { EventStore } from "../../src/storage/EventStore";

describe("SessionManager.hydrate()", () => {
  it("restores sessions from EventStore after restart", async () => {
    const dbPath = "/tmp/test-hydrate.db";
    const es1 = new EventStore({ dbPath, walMode: true });
    const sm1 = new SessionManager({ eventStore: es1 });
    const session = await sm1.startSession({ name: "test-session" });
    await es1.close();

    // Simulate restart: new instances, same DB
    const es2 = new EventStore({ dbPath, walMode: true });
    const sm2 = new SessionManager({ eventStore: es2 });
    await sm2.hydrate();
    const restored = sm2.getSession(session.sessionId);
    expect(restored).toBeDefined();
    expect(restored!.name).toBe("test-session");
    await es2.close();
  });
});
```

### Fix 2: Consolidate to single container (dev only)

**What**: Remove the `ping-mem-rest` service from `docker-compose.yml`. The primary `ping-mem` container already supports both SSE and REST via the `PING_MEM_TRANSPORT` environment variable.

**Scope**: `docker-compose.yml` only. `docker-compose.prod.yml` already uses a single container with `PING_MEM_TRANSPORT=rest` — no changes needed for prod.

**File**: `docker-compose.yml`

**Before** (lines 94-148): Full `ping-mem-rest` service definition with `profiles: [rest-api]`.

**After**: Remove the entire `ping-mem-rest` service block. If REST-only access is needed locally, change `PING_MEM_TRANSPORT=rest` on the primary container.

**Verification**: `PTP-SINGLE-1`: `docker-compose config --services` returns only `ping-mem-neo4j`, `ping-mem-qdrant`, `ping-mem`. No `ping-mem-rest`.
**Verification**: `PTP-SINGLE-2`: `docker-compose -f docker-compose.prod.yml config --services` confirms prod is unchanged (already single container).

### Fix 3: Graceful shutdown — flush session state (REST only)

**What**: Add `sessionManager.close()` to `RESTPingMemServer.stop()`.

**Status (verified)**:
- **SSEPingMemServer.stop()** (`sse-server.ts:343`) → calls `this.toolServer.close()` → `PingMemServer.close()` (`PingMemServer.ts:346`) → calls `this.sessionManager.close()` — **already correct, no change needed**.
- **RESTPingMemServer.stop()** (`rest-server.ts:2281`) → closes pubsub, eventStore, memory managers — does **NOT** call `this.sessionManager.close()` — **this is the gap**.

**File**: `src/http/rest-server.ts` — In the `stop()` method (line 2281), add before eventStore close:

```typescript
// Close SessionManager first to clear checkpoint timers
// (timers firing after EventStore close causes errors)
await this.sessionManager.close();
```

**No changes to `src/http/server.ts` shutdown handler** — the `serverInstance.stop()` call at line 184 will now propagate correctly for both transport types.

**Verification**: `PTP-SHUTDOWN-1`: Send SIGTERM to REST-mode server -> no "Auto-checkpoint failed" errors in logs -> process exits cleanly with code 0.

### Fix 4: WAL recovery on startup

**What**: Run `PRAGMA wal_checkpoint(TRUNCATE)` on EventStore startup when WAL file exceeds a threshold (e.g., 1MB).

**File**: `src/storage/EventStore.ts` — Add to constructor, after schema initialization (line 222).

**Implementation**:
```typescript
// WAL recovery: if WAL file is oversized, force a TRUNCATE checkpoint on startup
// This handles the case where a previous crash left a bloated WAL file
if (this.config.walMode && this.config.dbPath !== ":memory:") {
  const walSize = this.getWalSizeBytes();
  if (walSize > 1_048_576) { // 1MB threshold
    log.info("WAL file oversized, running TRUNCATE checkpoint", { walSize });
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      log.info("WAL recovery complete", { newWalSize: this.getWalSizeBytes() });
    } catch (err) {
      log.warn("WAL recovery failed — will retry via HealthMonitor", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

**Why TRUNCATE**: `PASSIVE` (used by HealthMonitor) never blocks writers and silently skips pages that are in use. `TRUNCATE` blocks until all pages are checkpointed, then truncates the WAL file to zero bytes. On startup, there are no concurrent writers, so TRUNCATE is safe and effective.

**Verification**: `PTP-WAL-1`: Create bloated WAL (>1MB) -> restart server -> WAL file size < 100KB after startup.

### Fix 5: Periodic WAL checkpointing — lower threshold + TRUNCATE

**What**: Two changes to HealthMonitor's periodic checkpoint:
1. Upgrade from `PASSIVE` to `TRUNCATE` (safe after Fix 2 — single container, no concurrent writers)
2. Lower the threshold from **50MB** (`HealthMonitor.ts:270`) to **2MB** to match the 1MB startup threshold in Fix 4

**Why the threshold change**: Currently HealthMonitor only checkpoints when WAL exceeds 50MB (`walSize > 50_000_000`). With Fix 4's startup recovery at 1MB, there's a gap: WAL can grow from 1MB to 50MB during normal operation without any checkpoint. Lowering to 2MB keeps WAL bounded.

**File**: `src/observability/HealthMonitor.ts` — Line 270-272

**Before**:
```typescript
if (walSize > 50_000_000) {
  // PASSIVE mode never blocks writers - SQLite WAL checkpoint is atomic
  this.deps.eventStore.walCheckpoint("PASSIVE");
}
```

**After**:
```typescript
if (walSize > 2_000_000) { // 2MB — lowered from 50MB to keep WAL bounded
  // TRUNCATE mode safe with single container (no concurrent writers from another process)
  this.deps.eventStore.walCheckpoint("TRUNCATE");
}
```

**Caveat**: Only safe after Fix 2 (single container). With dual containers, TRUNCATE would block the other process's writes.

**Verification**: `PTP-WAL-2`: Run server for 1 hour -> WAL file never exceeds 4MB (2× the checkpoint threshold).

## Implementation Phases

### Phase 1: Session Hydration (Fix 1 + Fix 3) — Low Risk
**Effort**: ~1 hour
**Dependencies**: None
**Quality gate**: `bun test` passes, PTP-HYDRATE-1 passes, PTP-SHUTDOWN-1 passes

### Phase 2: Container Consolidation (Fix 2) — Medium Risk
**Effort**: ~30 minutes
**Dependencies**: None (can be done in parallel with Phase 1)
**Quality gate**: `docker-compose config` validates, PTP-SINGLE-1 passes

### Phase 3: WAL Recovery (Fix 4 + Fix 5) — Low Risk
**Effort**: ~1 hour
**Dependencies**: Fix 2 must be completed before Fix 5 (TRUNCATE only safe with single container)
**Quality gate**: `bun test` passes, PTP-WAL-1 passes, PTP-WAL-2 passes

## Verification Checklist

| ID | Test | Pass/Fail |
|----|------|-----------|
| PTP-HYDRATE-1 | Sessions survive container restart | |
| PTP-SINGLE-1 | Only one ping-mem container in dev docker-compose | |
| PTP-SINGLE-2 | Prod docker-compose unchanged (already single container) | |
| PTP-SHUTDOWN-1 | Clean REST-mode shutdown with no checkpoint errors | |
| PTP-WAL-1 | Bloated WAL recovers on startup | |
| PTP-WAL-2 | WAL stays under 4MB during normal operation | |
| PTP-REGRESSION-1 | `bun test` — 0 failures | |
| PTP-REGRESSION-2 | `bun run typecheck` — 0 errors | |
| PTP-UNIT-1 | `tests/integration/session-hydration.test.ts` passes | |

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| hydrate() slow with many sessions | Medium | Low | EventStore limits to 10000 sessions (stmtListSessions LIMIT) |
| TRUNCATE checkpoint blocks request handling | High | Low | Only runs on startup (no concurrent requests) or single-container periodic |
| Removing rest container breaks existing deployments | Medium | Medium | Document migration: change PING_MEM_TRANSPORT on primary container |
| hydrate() crashes on corrupted events | High | Low | Wrap in try/catch, log warning, continue with empty sessions |

## Acceptance Criteria

**Functional**:
- Sessions persist across container restarts
- WAL file stays under 2MB during normal operation
- Single container serves both SSE and REST transports

**Non-functional**:
- Server startup time increases by < 500ms (hydration)
- Zero data loss on graceful shutdown (SIGTERM)
- Backward compatible: existing MCP clients work without changes

## Complete File Changes

```
Modified files:
  src/http/server.ts              — Add hydrateSessionState() call before start()
  src/http/rest-server.ts         — Add hydrateSessionState() method + sessionManager.close() in stop()
  src/http/sse-server.ts          — Add hydrateSessionState() method (delegates to toolServer)
  src/mcp/PingMemServer.ts        — Add hydrateSessionState() method
  src/storage/EventStore.ts       — Add WAL recovery on startup (TRUNCATE when >1MB)
  src/observability/HealthMonitor.ts — Change PASSIVE -> TRUNCATE, lower threshold 50MB -> 2MB
  docker-compose.yml              — Remove ping-mem-rest service

New files:
  tests/integration/session-hydration.test.ts — Unit test for session hydration across restarts

Deleted files: None
```

## Dependencies

No new external dependencies. All fixes use existing APIs:
- `SessionManager.hydrate()` — already implemented
- `EventStore.walCheckpoint("TRUNCATE")` — already implemented
- `EventStore.getWalSizeBytes()` — already implemented
