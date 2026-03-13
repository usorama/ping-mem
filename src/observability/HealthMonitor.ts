import type { RuntimeServices } from "../config/runtime.js";
import { probeSystemHealth, type HealthSnapshot } from "./health-probes.js";
import type { EventStore } from "../storage/EventStore.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("HealthMonitor");

type ProbeSource = "sqlite" | "neo4j" | "qdrant";

interface ProbeMetric {
  name: string;
  value: number;
  unit: "bytes" | "count" | "ratio" | "percent" | "boolean" | "ms";
}

interface ProbeResult {
  source: ProbeSource;
  status: "healthy" | "degraded" | "unhealthy";
  metrics: ProbeMetric[];
}

interface ThresholdRule {
  metric: string;
  warnAbove?: number;
  critAbove?: number;
  warnBelow?: number;
  critBelow?: number;
}

type AlertSeverity = "warning" | "critical";

export interface HealthAlert {
  key: string;
  severity: AlertSeverity;
  message: string;
  source: ProbeSource;
  timestamp: string;
}

export interface HealthMonitorStatus {
  running: boolean;
  lastSnapshot: HealthSnapshot | null;
  lastFastTickAt: string | null;
  lastQualityTickAt: string | null;
  activeAlerts: HealthAlert[];
}

const THRESHOLDS: Record<ProbeSource, ThresholdRule[]> = {
  sqlite: [
    { metric: "wal_size_bytes", warnAbove: 50_000_000, critAbove: 200_000_000 },
    { metric: "freelist_ratio", warnAbove: 0.15, critAbove: 0.3 },
    { metric: "integrity_ok", critBelow: 1 },
  ],
  neo4j: [
    { metric: "null_node_count", warnAbove: 100, critAbove: 1_000 },
    { metric: "orphan_node_count", warnAbove: 50, critAbove: 500 },
  ],
  qdrant: [
    // warnAbove matches the ratchet threshold so normal growth (<=15%) never triggers spurious alerts
    { metric: "point_count_drift_pct", warnAbove: 15, critAbove: 30 },
  ],
};

const QUALITY_QUERIES = {
  nullProperties: `
    MATCH (n:File) WHERE n.path IS NULL RETURN count(n) AS cnt
    UNION ALL
    MATCH (n:Chunk) WHERE n.content IS NULL RETURN count(n) AS cnt
    UNION ALL
    MATCH (n:Commit) WHERE n.sha IS NULL RETURN count(n) AS cnt
  `,
  orphanNodes: `
    MATCH (n) WHERE (n:File OR n:Chunk OR n:Commit OR n:Project) AND NOT (n)-[]-() RETURN count(n) AS cnt
  `,
};

export interface HealthMonitorDeps {
  services: RuntimeServices;
  eventStore: EventStore;
  diagnosticsStore?: import("../diagnostics/DiagnosticsStore.js").DiagnosticsStore;
}

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  return new HealthMonitor(deps);
}

export class HealthMonitor {
  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private tickRunning = false;
  private qualityTickRunning = false;
  private consecutiveTickFailures = 0;
  private lastAlerts = new Map<string, number>();
  private activeAlerts = new Map<string, HealthAlert>();
  private static readonly MAX_ALERTS = 200;
  private lastSnapshot: HealthSnapshot | null = null;
  private lastFastTickAt: string | null = null;
  private lastQualityTickAt: string | null = null;
  private baselineQdrantCount: number | null = null;
  private readonly dedupWindowMs = 15 * 60 * 1000;

  constructor(private readonly deps: HealthMonitorDeps) {}

  start(): void {
    if (this.fastTimer || this.qualityTimer) {
      return;
    }

    this.stopping = false;
    this.consecutiveTickFailures = 0;

    this.fastTimer = setInterval(() => {
      this.tick().catch((err) => {
        log.error("Fast tick threw unexpectedly", { error: err instanceof Error ? err.message : String(err) });
      });
    }, 60_000);

    this.qualityTimer = setInterval(() => {
      this.qualityTick().catch((err) => {
        log.error("Quality tick threw unexpectedly", { error: err instanceof Error ? err.message : String(err) });
      });
    }, 300_000);

    this.tick().catch((err) => {
      log.error("Initial fast tick failed", { error: err instanceof Error ? err.message : String(err) });
    });
    this.qualityTick().catch((err) => {
      log.error("Initial quality tick failed", { error: err instanceof Error ? err.message : String(err) });
    });
    log.info("Started");
  }

  stop(): void {
    this.stopping = true;
    if (this.fastTimer) {
      clearInterval(this.fastTimer);
      this.fastTimer = null;
    }
    if (this.qualityTimer) {
      clearInterval(this.qualityTimer);
      this.qualityTimer = null;
    }
  }

  getStatus(): HealthMonitorStatus {
    return {
      running: this.fastTimer !== null && this.qualityTimer !== null,
      lastSnapshot: this.lastSnapshot,
      lastFastTickAt: this.lastFastTickAt,
      lastQualityTickAt: this.lastQualityTickAt,
      activeAlerts: Array.from(this.activeAlerts.values()).sort((a, b) =>
        a.timestamp < b.timestamp ? 1 : -1
      ),
    };
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.tickRunning) return;
    this.tickRunning = true;

    try {
      try {
        const snapshot = await probeSystemHealth({
          eventStore: this.deps.eventStore,
          ...(this.deps.services.neo4jClient ? { neo4jClient: this.deps.services.neo4jClient } : {}),
          ...(this.deps.services.graphManager ? { graphManager: this.deps.services.graphManager } : {}),
          ...(this.deps.services.qdrantClient ? { qdrantClient: this.deps.services.qdrantClient } : {}),
          ...(this.deps.diagnosticsStore ? { diagnosticsStore: this.deps.diagnosticsStore } : {}),
          skipIntegrityCheck: true,
        });
        this.lastSnapshot = snapshot;
        this.lastFastTickAt = new Date().toISOString();
        this.consecutiveTickFailures = 0;
        this.activeAlerts.delete("monitor:tick_failure");

        const sqliteMetrics = snapshot.components.sqlite.metrics;
        if (sqliteMetrics) {
          // integrity_ok is excluded from the fast tick: skipIntegrityCheck=true always returns 1,
          // so there's nothing meaningful to threshold-check here. It runs in qualityTick only.
          this.checkThresholds({
            source: "sqlite",
            status: this.componentToProbeStatus(snapshot.components.sqlite.status),
            metrics: [
              { name: "wal_size_bytes", value: sqliteMetrics.wal_size_bytes ?? 0, unit: "bytes" },
              { name: "freelist_ratio", value: sqliteMetrics.freelist_ratio ?? 0, unit: "ratio" },
            ],
          });
        }

        // Alert on service-down states (Neo4j/Qdrant unhealthy in snapshot)
        if (snapshot.components.neo4j.configured && snapshot.components.neo4j.status === "unhealthy") {
          this.alert("warning", "neo4j:service_down", "neo4j", "Neo4j is unreachable");
        } else {
          this.activeAlerts.delete("neo4j:service_down");
          this.lastAlerts.delete("neo4j:service_down");
        }
        if (snapshot.components.qdrant.configured && snapshot.components.qdrant.status === "unhealthy") {
          this.alert("warning", "qdrant:service_down", "qdrant", "Qdrant is unreachable");
        } else {
          this.activeAlerts.delete("qdrant:service_down");
          this.lastAlerts.delete("qdrant:service_down");
        }
      } catch (error) {
        this.consecutiveTickFailures++;
        log.error("Fast tick probe failed", {
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures: this.consecutiveTickFailures,
        });
        if (this.consecutiveTickFailures >= 3) {
          this.alert("critical", "monitor:tick_failure", "sqlite",
            `Health monitoring degraded: ${this.consecutiveTickFailures} consecutive probe failures`);
        }
      }

      if (this.stopping) return;

      // WAL checkpoint in separate try-catch so probe data is preserved even if checkpoint fails
      try {
        const walSize = this.lastSnapshot?.components.sqlite.metrics?.wal_size_bytes ?? 0;
        if (walSize > 50_000_000) {
          // PASSIVE mode never blocks writers (unlike TRUNCATE which waits for all readers)
          this.deps.eventStore.walCheckpoint("PASSIVE");
          log.info("SQLite WAL checkpoint completed", { walSizeBytes: walSize });
          // Clear any prior checkpoint failure alert now that checkpoint succeeded
          this.activeAlerts.delete("sqlite:wal_checkpoint_failed");
          this.lastAlerts.delete("sqlite:wal_checkpoint_failed");
        }
      } catch (error) {
        const lastWalSize = this.lastSnapshot?.components.sqlite.metrics?.wal_size_bytes ?? 0;
        log.error("WAL checkpoint failed — WAL may grow unbounded", {
          error: error instanceof Error ? error.message : String(error),
          walSizeBytes: lastWalSize,
        });
        this.alert("warning", "sqlite:wal_checkpoint_failed", "sqlite",
          `WAL checkpoint failed at ${lastWalSize} bytes`);
      }
    } finally {
      this.tickRunning = false;
    }
  }

  private async qualityTick(): Promise<void> {
    if (this.stopping || this.qualityTickRunning) return;
    this.qualityTickRunning = true;

    try {
      let probeSucceeded = false;

      // SQLite integrity check (expensive — only runs in quality tick, not fast tick)
      try {
        const integrityOk = this.deps.eventStore.getIntegrityOk();
        this.checkThresholds({
          source: "sqlite",
          status: integrityOk === 1 ? "healthy" : "unhealthy",
          metrics: [{ name: "integrity_ok", value: integrityOk, unit: "boolean" }],
        });
        // Clear any prior integrity failure alert on successful check
        this.activeAlerts.delete("sqlite:integrity_check_failed");
        this.lastAlerts.delete("sqlite:integrity_check_failed");
        probeSucceeded = true;
      } catch (error) {
        log.warn("SQLite integrity check failed", { error: error instanceof Error ? error.message : String(error) });
        this.alert("critical", "sqlite:integrity_check_failed", "sqlite",
          `SQLite integrity check failed: ${error instanceof Error ? error.message : "unknown"}`);
      }

      if (this.stopping) return;

      if (this.deps.services.neo4jClient && this.deps.services.neo4jClient.isConnected()) {
        try {
          const nullRows = await this.deps.services.neo4jClient.executeQuery<{ cnt: number | string }>(QUALITY_QUERIES.nullProperties);
          const nullNodeCount = nullRows.reduce((sum, row) => sum + Number(row.cnt), 0);

          const orphanRows = await this.deps.services.neo4jClient.executeQuery<{ cnt: number | string }>(QUALITY_QUERIES.orphanNodes);
          const orphanNodeCount = Number(orphanRows[0]?.cnt ?? 0);

          this.checkThresholds({
            source: "neo4j",
            status: "healthy",
            metrics: [
              { name: "null_node_count", value: nullNodeCount, unit: "count" },
              { name: "orphan_node_count", value: orphanNodeCount, unit: "count" },
            ],
          });
          probeSucceeded = true;
        } catch (error) {
          log.warn("Neo4j quality tick failed", { error: error instanceof Error ? error.message : String(error) });
          this.alert("warning", "neo4j:quality_probe_failed", "neo4j",
            `Quality probe failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }

      if (this.stopping) return;

      if (this.deps.services.qdrantClient && this.deps.services.qdrantClient.isConnected()) {
        try {
          const stats = await this.deps.services.qdrantClient.getStats();
          const pointCount = stats.totalVectors;

          if (this.baselineQdrantCount === null) {
            // First tick: establish baseline, skip drift check
            this.baselineQdrantCount = pointCount;
          } else if (this.baselineQdrantCount === 0 && pointCount > 0) {
            // Bootstrap: first ingest happened since baseline was set at 0 — treat as normal growth
            this.baselineQdrantCount = pointCount;
            log.info("Qdrant baseline bootstrapped after first ingest", { pointCount });
          } else {
            const driftPct = this.baselineQdrantCount === 0
              ? 0
              : Math.abs(pointCount - this.baselineQdrantCount) / this.baselineQdrantCount * 100;

            // Ratchet baseline forward when drift is within the critical threshold.
            // This allows legitimate large growth to be tracked without permanent alert floods.
            if (driftPct <= 15) {
              this.baselineQdrantCount = pointCount;
            }
            this.checkThresholds({
              source: "qdrant",
              status: "healthy",
              metrics: [{ name: "point_count_drift_pct", value: driftPct, unit: "percent" }],
            });
          }
          probeSucceeded = true;
        } catch (error) {
          log.warn("Qdrant quality tick failed", { error: error instanceof Error ? error.message : String(error) });
          this.alert("warning", "qdrant:quality_probe_failed", "qdrant",
            `Quality probe failed: ${error instanceof Error ? error.message : "unknown"}`);
        }
      }

      if (probeSucceeded) {
        this.lastQualityTickAt = new Date().toISOString();
      }
    } finally {
      this.qualityTickRunning = false;
    }
  }

  private componentToProbeStatus(status: HealthSnapshot["components"]["sqlite"]["status"]): "healthy" | "degraded" | "unhealthy" {
    if (status === "healthy") {
      return "healthy";
    }
    if (status === "degraded") {
      return "degraded";
    }
    return "unhealthy";
  }

  private checkThresholds(result: ProbeResult): void {
    const rules = THRESHOLDS[result.source];

    for (const metric of result.metrics) {
      const rule = rules.find((entry) => entry.metric === metric.name);
      if (!rule) {
        continue;
      }

      const key = `${result.source}:${metric.name}`;
      if (rule.critAbove !== undefined && metric.value > rule.critAbove) {
        this.alert("critical", key, result.source, `${metric.name}=${metric.value} exceeds ${rule.critAbove}`);
      } else if (rule.warnAbove !== undefined && metric.value > rule.warnAbove) {
        this.alert("warning", key, result.source, `${metric.name}=${metric.value} exceeds ${rule.warnAbove}`);
      } else if (rule.critBelow !== undefined && metric.value < rule.critBelow) {
        this.alert("critical", key, result.source, `${metric.name}=${metric.value} below ${rule.critBelow}`);
      } else if (rule.warnBelow !== undefined && metric.value < rule.warnBelow) {
        this.alert("warning", key, result.source, `${metric.name}=${metric.value} below ${rule.warnBelow}`);
      } else {
        this.activeAlerts.delete(key);
        // Clear dedup timestamp so the alert can re-fire if the condition recurs
        this.lastAlerts.delete(key);
      }
    }
  }

  private alert(severity: AlertSeverity, key: string, source: ProbeSource, message: string): void {
    const now = Date.now();
    const previous = this.lastAlerts.get(key) ?? 0;

    // Allow severity escalation (warn→critical) to bypass dedup window
    const existingAlert = this.activeAlerts.get(key);
    const isSeverityEscalation = existingAlert !== undefined
      && existingAlert.severity === "warning"
      && severity === "critical";

    if (!isSeverityEscalation && now - previous < this.dedupWindowMs) {
      return;
    }

    this.lastAlerts.set(key, now);
    const alert: HealthAlert = {
      key,
      severity,
      source,
      message,
      timestamp: new Date(now).toISOString(),
    };
    this.activeAlerts.set(key, alert);

    // Evict oldest alerts if map exceeds cap
    if (this.activeAlerts.size > HealthMonitor.MAX_ALERTS) {
      const oldest = Array.from(this.activeAlerts.entries())
        .sort(([, a], [, b]) => (a.timestamp < b.timestamp ? -1 : 1))[0];
      if (oldest) {
        this.activeAlerts.delete(oldest[0]);
        this.lastAlerts.delete(oldest[0]);
      }
    }

    if (severity === "critical") {
      log.error(`CRITICAL ${message}`, { key, source });
      return;
    }
    log.warn(`WARNING ${message}`, { key, source });
  }
}
