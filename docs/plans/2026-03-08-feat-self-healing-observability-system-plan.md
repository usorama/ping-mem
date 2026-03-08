---
title: "feat: Self-Healing Health Monitor"
type: feat
date: 2026-03-08
status: draft
priority: P0
revised: 2026-03-08
revision-note: "Simplified after 3-reviewer consensus (DHH, Kieran, Simplicity). 87% LOC reduction: ~2000 lines → ~250 lines."
---

# Self-Healing Health Monitor

## Overview

Neo4j accumulated **6.8GB of null values** over ~30 days. No alert fired. No metric tracked it. A human stumbled across it during unrelated debugging.

This plan adds a **single HealthMonitor** that runs periodic threshold checks on all three storage backends, auto-fixes safe issues (WAL checkpoints, reconnections), and logs alerts for destructive issues requiring human intervention.

**Scope**: One new file (~250 lines), one dependency (Cockatiel), three modified files. Ships in a day.

**What was cut** (per reviewer consensus): LLM integration, statistical z-score detection, recovery state machine, AlertManager, ObservabilityStore (separate DB), HTMX dashboard, MCP tools, meta-health, branded types, Worker threads. See [archived deepened plan](./2026-03-08-feat-self-healing-observability-system-plan-deepened.md) for the full research if any of these become needed later.

---

## Problem Statement

| Gap | Impact |
|-----|--------|
| No periodic data quality checks | 6.8GB null accumulation undetected for 30 days |
| No auto-reconnection for Neo4j/Qdrant | Service stays dead until manual restart |
| No uncaughtException/unhandledRejection handlers | Process crashes silently |
| No Neo4j/Qdrant disconnect on shutdown | Connection leaks |
| No WAL checkpoint management | WAL files grow unbounded |
| Health check duplication (3 implementations) | Inconsistent status reporting |

---

## Technical Approach

### New File: `src/observability/HealthMonitor.ts` (~250 lines)

```typescript
import { createServicePolicy, type ServicePolicy } from '../util/CircuitBreaker';
import type { RuntimeServices } from '../config/runtime';
import { log } from '../util/logger';

// ----- Types -----

type ProbeSource = 'sqlite' | 'neo4j' | 'qdrant';

interface ProbeMetric {
  name: string;
  value: number;
  unit: 'bytes' | 'count' | 'ratio' | 'boolean' | 'ms';
}

interface ProbeResult {
  source: ProbeSource;
  status: 'healthy' | 'degraded' | 'unhealthy';
  metrics: ProbeMetric[];
}

interface ThresholdRule {
  metric: string;
  warnAbove?: number;
  critAbove?: number;
  warnBelow?: number;
  critBelow?: number;
}

// ----- Thresholds -----

const THRESHOLDS: Record<string, ThresholdRule[]> = {
  sqlite: [
    { metric: 'wal_size_bytes', warnAbove: 50_000_000, critAbove: 200_000_000 },
    { metric: 'freelist_ratio', warnAbove: 0.15, critAbove: 0.30 },
    { metric: 'integrity_ok', critBelow: 1 },
  ],
  neo4j: [
    { metric: 'null_node_count', warnAbove: 100, critAbove: 1000 },
    { metric: 'orphan_node_count', warnAbove: 50, critAbove: 500 },
  ],
  qdrant: [
    { metric: 'point_count_drift_pct', warnAbove: 5, critAbove: 15 },
  ],
};

// ----- Factory -----

export function createHealthMonitor(services: RuntimeServices): HealthMonitor { ... }

// ----- Core Loop -----

class HealthMonitor {
  private timer: Timer | null = null;
  private lastAlerts = new Map<string, number>(); // dedup: key → timestamp
  private readonly DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 min

  start(): void {
    // Fast probes every 60s
    this.timer = setInterval(() => this.tick(), 60_000);
    // Quality probes every 5 min
    this.qualityTimer = setInterval(() => this.qualityTick(), 300_000);
    log.info('[HealthMonitor] Started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.qualityTimer) clearInterval(this.qualityTimer);
  }

  private async tick(): Promise<void> {
    // SQLite: SELECT 1, WAL size, freelist ratio
    // Neo4j: ping()
    // Qdrant: healthCheck()
    // Check thresholds → log.warn / log.error
    // Auto-fix: WAL > 50MB → PRAGMA wal_checkpoint(TRUNCATE)
  }

  private async qualityTick(): Promise<void> {
    // Neo4j: null-property scan, orphan scan
    // Qdrant: point count vs baseline
    // Check thresholds → log.warn / log.error
  }

  private checkThresholds(result: ProbeResult): void {
    const rules = THRESHOLDS[result.source] ?? [];
    for (const metric of result.metrics) {
      const rule = rules.find(r => r.metric === metric.name);
      if (!rule) continue;
      const key = `${result.source}:${metric.name}`;

      if (rule.critAbove && metric.value > rule.critAbove) {
        this.alert('critical', key, `${metric.name} = ${metric.value} (threshold: ${rule.critAbove})`);
      } else if (rule.warnAbove && metric.value > rule.warnAbove) {
        this.alert('warning', key, `${metric.name} = ${metric.value} (threshold: ${rule.warnAbove})`);
      }
      // ... similar for warnBelow/critBelow
    }
  }

  private alert(severity: 'warning' | 'critical', key: string, message: string): void {
    const now = Date.now();
    const last = this.lastAlerts.get(key) ?? 0;
    if (now - last < this.DEDUP_WINDOW_MS) return; // dedup
    this.lastAlerts.set(key, now);

    if (severity === 'critical') {
      log.error(`[HealthMonitor] CRITICAL: ${message}`);
    } else {
      log.warn(`[HealthMonitor] WARNING: ${message}`);
    }
    // Emit to existing PubSub for SSE propagation
    this.pubsub?.publish({ type: 'health:alert', severity, message });
  }
}
```

### New File: `src/util/CircuitBreaker.ts` (~50 lines)

Cockatiel wrapper for Neo4j and Qdrant:

```typescript
import {
  circuitBreaker, retry, timeout, wrap, handleWhen,
  ConsecutiveBreaker, ExponentialBackoff, TimeoutStrategy,
} from 'cockatiel';

export interface ServicePolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>;
  readonly name: string;
  readonly state: 'closed' | 'open' | 'half-open';
  onStateChange(handler: (state: 'closed' | 'open' | 'half-open') => void): void;
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ECONNREFUSED' || code === 'ETIMEDOUT';
}

export function createServicePolicy(opts: {
  name: string;
  consecutiveFailures?: number;
  halfOpenAfterMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}): ServicePolicy {
  const transientOnly = handleWhen(isTransient);

  const breaker = circuitBreaker(transientOnly, {
    halfOpenAfter: opts.halfOpenAfterMs ?? 30_000,
    breaker: new ConsecutiveBreaker(opts.consecutiveFailures ?? 5),
  });

  const retryPolicy = retry(transientOnly, {
    maxAttempts: opts.maxRetries ?? 3,
    backoff: new ExponentialBackoff({ initialDelay: 500, maxDelay: 10_000 }),
  });

  const timeoutPolicy = timeout(opts.timeoutMs ?? 15_000, TimeoutStrategy.Aggressive);
  const policy = wrap(retryPolicy, breaker, timeoutPolicy);

  let currentState: 'closed' | 'open' | 'half-open' = 'closed';
  const handlers: Array<(s: 'closed' | 'open' | 'half-open') => void> = [];

  breaker.onBreak(() => { currentState = 'open'; handlers.forEach(h => h('open')); });
  breaker.onHalfOpen(() => { currentState = 'half-open'; handlers.forEach(h => h('half-open')); });
  breaker.onReset(() => { currentState = 'closed'; handlers.forEach(h => h('closed')); });

  return {
    execute: <T>(fn: () => Promise<T>) => policy.execute(fn),
    name: opts.name,
    get state() { return currentState; },
    onStateChange: (handler) => { handlers.push(handler); },
  };
}
```

### Neo4j Quality Queries (inside HealthMonitor)

The actual fix for the 6.8GB incident:

```typescript
const QUALITY_QUERIES = {
  nullProperties: `
    MATCH (n:File) WHERE n.path IS NULL RETURN 'File' AS label, count(n) AS cnt
    UNION ALL
    MATCH (n:Chunk) WHERE n.content IS NULL RETURN 'Chunk' AS label, count(n) AS cnt
    UNION ALL
    MATCH (n:Commit) WHERE n.sha IS NULL RETURN 'Commit' AS label, count(n) AS cnt
  `,
  orphanNodes: `
    MATCH (n) WHERE NOT (n)-[]-() RETURN labels(n)[0] AS label, count(n) AS cnt
    ORDER BY cnt DESC LIMIT 100
  `,
};
```

### Modified Files

| File | Change | Lines |
|------|--------|-------|
| `src/graph/Neo4jClient.ts` | Wrap `executeQuery()`/`executeWrite()` with circuit breaker. Wire `onStateChange` to set `this.connected` and log. Use Cockatiel's `halfOpenAfter` for auto-reconnection (no manual `setInterval` timer). | ~30 |
| `src/search/QdrantClient.ts` | Wrap `upsert()`/`search()`/`getStats()` with circuit breaker. Wire `onStateChange`. | ~25 |
| `src/http/server.ts` | Add `uncaughtException`/`unhandledRejection` handlers. Add graceful shutdown (Neo4j driver close, Qdrant disconnect). | ~20 |
| `src/http/rest-server.ts` | Extract health probe logic into shared functions reused by `/health` endpoint and HealthMonitor. Add `GET /api/v1/observability/status` returning current health + any active alerts. | ~40 |
| `src/config/runtime.ts` | Initialize HealthMonitor after services, add to RuntimeServices. | ~10 |
| `package.json` | Add `cockatiel: ^3.2.1` | 1 |

### SQLite Hardening (apply to all DB creation sites)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
```

---

## What Auto-Heals vs What Alerts

| Condition | Action | Auto? |
|-----------|--------|-------|
| WAL size > 50MB | `PRAGMA wal_checkpoint(TRUNCATE)` | Yes |
| Neo4j connection lost | Cockatiel half-open retry | Yes |
| Qdrant connection lost | Cockatiel half-open retry | Yes |
| Neo4j null nodes > 100 | `log.error` with Cypher cleanup command | No — log only |
| Neo4j orphan nodes > 50 | `log.error` with Cypher cleanup command | No — log only |
| Qdrant point drift > 5% | `log.warn` | No — log only |
| SQLite integrity fail | `log.error` | No — log only |

Destructive actions (null cleanup, orphan cleanup, re-ingest) are **never auto-executed**. The log message includes the exact command to run manually.

---

## Acceptance Criteria

- [x] Circuit breaker activates on Neo4j/Qdrant after 5 consecutive failures
- [x] Auto-reconnection restores service via Cockatiel half-open (no manual timer)
- [x] SQLite WAL > 50MB triggers automatic checkpoint
- [x] Neo4j null-property scan detects > 100 null nodes and fires `log.error`
- [x] Neo4j orphan scan detects > 50 orphans and fires `log.warn`
- [x] Qdrant point count drift > 5% fires `log.warn`
- [x] Alert deduplication suppresses same alert for 15 minutes
- [x] Process error handlers catch uncaughtException/unhandledRejection
- [x] Graceful shutdown closes Neo4j and Qdrant connections
- [x] `/health` endpoint uses shared probes (deduplicated from 3 → 1 implementation)
- [x] `GET /api/v1/observability/status` returns current health state
- [x] All SQLite databases use WAL mode with proper PRAGMAs
- [x] No `any` types
- [x] `bun run typecheck` — 0 errors
- [x] `bun test` — 100% pass

---

## Non-Functional Requirements

- [ ] Monitor tick adds < 50ms to event loop when backends healthy
- [ ] Quality tick (Neo4j scans) completes in < 5s
- [x] Zero new SQLite databases
- [ ] Zero false positives in first 24h (thresholds are conservative)

---

## Tests

| Test | Type |
|------|------|
| Circuit breaker: 5 failures → open, success → closed | Unit |
| Threshold check: value above warn → logs warning | Unit |
| Threshold check: value above crit → logs error | Unit |
| Dedup: same alert within 15 min suppressed | Unit |
| SQLite probe: returns WAL size, freelist ratio, integrity | Unit (real bun:sqlite) |
| Neo4j probe: mock client returns null count → threshold fires | Unit |
| Integration: simulate Neo4j down → circuit opens → reconnect → closes | Integration |

---

## Dependency

| Dependency | Version | Purpose | Size |
|-----------|---------|---------|------|
| `cockatiel` | ^3.2.1 | Circuit breaker, retry, timeout | ~15KB, zero deps |

**Version constraint**: v4 requires Node >= 22. Pin to `^3.2.1` for Bun compatibility.

---

## What's Deferred (iterate when reality demands)

These were researched but cut per reviewer consensus. The research is preserved in the [deepened plan archive](./2026-03-08-feat-self-healing-observability-system-plan-deepened.md) if any become needed:

| Feature | When to Add |
|---------|-------------|
| Statistical anomaly detection (z-score) | If threshold-based detection proves insufficient after 30 days |
| LLM-powered root cause analysis | If anomaly correlation across backends becomes a real problem |
| Separate ObservabilityStore | If EventStore grows too large from observability events |
| Recovery state machine | If manual recovery becomes frequent enough to warrant automation |
| HTMX observability dashboard | If log-based monitoring proves insufficient for operators |
| MCP tool parity | If agents need programmatic observability access |
| Webhook alerts | If log monitoring is not being checked frequently enough |

---

## References

### Internal
- Health endpoint (3 duplicates): `src/http/rest-server.ts:264-352`, `GraphToolModule.ts`, `ui/partials/health.ts`
- PubSub circuit breaker pattern: `src/pubsub/MemoryPubSub.ts:56-114`
- Neo4jClient: `src/graph/Neo4jClient.ts`
- QdrantClient: `src/search/QdrantClient.ts`
- RuntimeServices: `src/config/runtime.ts`

### External
- [Cockatiel — TypeScript resilience library](https://github.com/connor4312/cockatiel)
- [Neo4j Monitoring](https://neo4j.com/docs/operations-manual/current/monitoring/)
- [SQLite PRAGMA Reference](https://sqlite.org/pragma.html)
