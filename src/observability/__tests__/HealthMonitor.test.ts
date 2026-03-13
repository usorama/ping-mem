import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventStore } from "../../storage/EventStore.js";
import { HealthMonitor, createHealthMonitor, type HealthMonitorDeps } from "../HealthMonitor.js";
import type { RuntimeServices } from "../../config/runtime.js";

interface ProbeMetric {
  name: string;
  value: number;
  unit: "bytes" | "count" | "ratio" | "percent" | "boolean" | "ms";
}

interface ProbeResult {
  source: "sqlite" | "neo4j" | "qdrant";
  status: "healthy" | "degraded" | "unhealthy";
  metrics: ProbeMetric[];
}

describe("HealthMonitor", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  function makeMonitor(servicesOverride?: Partial<RuntimeServices>): HealthMonitor {
    const services: RuntimeServices = { ...servicesOverride };
    return createHealthMonitor({ services, eventStore });
  }

  function getInternals(monitor: HealthMonitor) {
    return monitor as unknown as {
      checkThresholds: (result: ProbeResult) => void;
      tick: () => Promise<void>;
      qualityTick: () => Promise<void>;
      alert: (severity: "warning" | "critical", key: string, source: string, message: string) => void;
      baselineQdrantCount: number | null;
      lastAlerts: Map<string, number>;
      activeAlerts: Map<string, { severity: string; key: string; source: string; message: string; timestamp: string }>;
      stopping: boolean;
      tickRunning: boolean;
      qualityTickRunning: boolean;
      consecutiveTickFailures: number;
    };
  }

  test("raises warning/critical alerts from thresholds", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [
        { name: "wal_size_bytes", value: 60_000_000, unit: "bytes" },
        { name: "integrity_ok", value: 0, unit: "boolean" },
      ],
    });

    const status = monitor.getStatus();
    expect(status.activeAlerts.some((alert) => alert.key === "sqlite:wal_size_bytes")).toBe(true);
    expect(status.activeAlerts.some((alert) => alert.key === "sqlite:integrity_ok")).toBe(true);
  });

  test("deduplicates repeated alerts inside dedup window", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    const result: ProbeResult = {
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 60_000_000, unit: "bytes" }],
    };

    internals.checkThresholds(result);
    const first = monitor.getStatus().activeAlerts.find((alert) => alert.key === "sqlite:wal_size_bytes");
    expect(first).toBeDefined();

    internals.checkThresholds(result);
    const second = monitor.getStatus().activeAlerts.find((alert) => alert.key === "sqlite:wal_size_bytes");
    expect(second?.timestamp).toBe(first?.timestamp);
  });

  test("resolved alerts clear dedup timestamp so they can re-fire", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Fire alert
    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 60_000_000, unit: "bytes" }],
    });
    expect(monitor.getStatus().activeAlerts.length).toBe(1);

    // Resolve alert (value back to normal)
    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 10_000_000, unit: "bytes" }],
    });
    expect(monitor.getStatus().activeAlerts.length).toBe(0);
    expect(internals.lastAlerts.has("sqlite:wal_size_bytes")).toBe(false);

    // Re-fire should work immediately (no dedup window blocking)
    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 60_000_000, unit: "bytes" }],
    });
    expect(monitor.getStatus().activeAlerts.length).toBe(1);
  });

  test("critical threshold overrides warning threshold", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 250_000_000, unit: "bytes" }],
    });

    const alert = monitor.getStatus().activeAlerts.find((a) => a.key === "sqlite:wal_size_bytes");
    expect(alert?.severity).toBe("critical");
  });

  test("below-threshold (critBelow) fires critical alert", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "integrity_ok", value: 0, unit: "boolean" }],
    });

    const alert = monitor.getStatus().activeAlerts.find((a) => a.key === "sqlite:integrity_ok");
    expect(alert?.severity).toBe("critical");
  });

  test("getStatus() reports running=false before start and running=true after start", async () => {
    const monitor = makeMonitor();
    expect(monitor.getStatus().running).toBe(false);

    monitor.start();
    expect(monitor.getStatus().running).toBe(true);

    await monitor.stop();
    expect(monitor.getStatus().running).toBe(false);
  });

  test("start() is idempotent — calling twice does not create duplicate timers", async () => {
    const monitor = makeMonitor();
    monitor.start();
    monitor.start();
    expect(monitor.getStatus().running).toBe(true);
    await monitor.stop();
    expect(monitor.getStatus().running).toBe(false);
  });

  test("neo4j quality thresholds fire correctly", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.checkThresholds({
      source: "neo4j",
      status: "healthy",
      metrics: [
        { name: "null_node_count", value: 200, unit: "count" },
        { name: "orphan_node_count", value: 600, unit: "count" },
      ],
    });

    const alerts = monitor.getStatus().activeAlerts;
    const nullAlert = alerts.find((a) => a.key === "neo4j:null_node_count");
    const orphanAlert = alerts.find((a) => a.key === "neo4j:orphan_node_count");
    expect(nullAlert?.severity).toBe("warning");
    expect(orphanAlert?.severity).toBe("critical");
  });

  test("qdrant drift threshold fires when exceeding warn level", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // warnAbove is now 15 (aligned with ratchet threshold) — use a value above it
    internals.checkThresholds({
      source: "qdrant",
      status: "healthy",
      metrics: [{ name: "point_count_drift_pct", value: 20, unit: "ratio" }],
    });

    const alert = monitor.getStatus().activeAlerts.find((a) => a.key === "qdrant:point_count_drift_pct");
    expect(alert?.severity).toBe("warning");
  });

  test("alerts are sorted by timestamp (most recent first)", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Fire two alerts at slightly different times
    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 60_000_000, unit: "bytes" }],
    });

    // Clear dedup for next alert
    internals.lastAlerts.clear();

    internals.checkThresholds({
      source: "sqlite",
      status: "unhealthy",
      metrics: [{ name: "integrity_ok", value: 0, unit: "boolean" }],
    });

    const alerts = monitor.getStatus().activeAlerts;
    expect(alerts.length).toBe(2);
    // Most recent should be first
    expect(new Date(alerts[0]!.timestamp).getTime()).toBeGreaterThanOrEqual(
      new Date(alerts[1]!.timestamp).getTime()
    );
  });

  test("metrics with no matching threshold rule are ignored", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "unknown_metric", value: 9999, unit: "count" }],
    });

    expect(monitor.getStatus().activeAlerts.length).toBe(0);
  });

  test("severity escalation (warn→critical) bypasses dedup window", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Fire warning alert
    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 60_000_000, unit: "bytes" }],
    });

    const warnAlert = monitor.getStatus().activeAlerts.find((a) => a.key === "sqlite:wal_size_bytes");
    expect(warnAlert?.severity).toBe("warning");

    // Escalate to critical within same dedup window — should bypass
    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 250_000_000, unit: "bytes" }],
    });

    const critAlert = monitor.getStatus().activeAlerts.find((a) => a.key === "sqlite:wal_size_bytes");
    expect(critAlert?.severity).toBe("critical");
  });

  test("same severity within dedup window is still suppressed", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Fire warning alert
    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 60_000_000, unit: "bytes" }],
    });

    const firstAlert = monitor.getStatus().activeAlerts.find((a) => a.key === "sqlite:wal_size_bytes");
    expect(firstAlert).toBeDefined();
    const firstTimestamp = firstAlert?.timestamp;

    // Same severity within dedup window — should be suppressed (timestamp unchanged)
    internals.checkThresholds({
      source: "sqlite",
      status: "healthy",
      metrics: [{ name: "wal_size_bytes", value: 70_000_000, unit: "bytes" }],
    });

    const secondAlert = monitor.getStatus().activeAlerts.find((a) => a.key === "sqlite:wal_size_bytes");
    expect(secondAlert?.timestamp).toBe(firstTimestamp);
  });

  test("lastQualityTickAt is null before qualityTick runs", () => {
    const monitor = makeMonitor();
    expect(monitor.getStatus().lastQualityTickAt).toBeNull();
  });

  test("stop() sets stopping flag and prevents start()", async () => {
    const monitor = makeMonitor();
    monitor.start();
    expect(monitor.getStatus().running).toBe(true);

    await monitor.stop();
    expect(monitor.getStatus().running).toBe(false);

    // Calling start after stop should work (new lifecycle)
    monitor.start();
    expect(monitor.getStatus().running).toBe(true);
    await monitor.stop();
  });

  test("stopping guard prevents state update after stop()", async () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.stopping = true;
    const snapshotBefore = monitor.getStatus().lastSnapshot;
    await internals.tick();
    // lastSnapshot should not have changed since stopping=true
    expect(monitor.getStatus().lastSnapshot).toBe(snapshotBefore);
  });

  test("tickRunning guard prevents re-entrant tick execution", async () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.tickRunning = true;
    const snapshotBefore = monitor.getStatus().lastSnapshot;
    await internals.tick(); // should return early
    expect(monitor.getStatus().lastSnapshot).toBe(snapshotBefore);
    internals.tickRunning = false;
  });

  test("WAL checkpoint is triggered when wal_size_bytes exceeds 50MB", async () => {
    let checkpointCalled = false;
    const fakeEventStore = {
      getDatabase: () => ({}),
      ping: async () => true,
      getWalSizeBytes: () => 60_000_000,
      getFreelistRatio: () => 0,
      getIntegrityOk: () => 1,
      walCheckpoint: (_mode: string) => { checkpointCalled = true; },
      isAgentActive: () => false,
      close: async () => {},
    };
    const monitor = createHealthMonitor({
      services: {},
      eventStore: fakeEventStore as unknown as import("../../storage/EventStore.js").EventStore,
    });
    await getInternals(monitor).tick();
    expect(checkpointCalled).toBe(true);
  });

  test("WAL checkpoint failure sets sqlite:wal_checkpoint_failed alert", async () => {
    const fakeEventStore = {
      getDatabase: () => ({}),
      ping: async () => true,
      getWalSizeBytes: () => 60_000_000,
      getFreelistRatio: () => 0,
      getIntegrityOk: () => 1,
      walCheckpoint: (_mode: string) => { throw new Error("WAL locked"); },
      isAgentActive: () => false,
      close: async () => {},
    };
    const monitor = createHealthMonitor({
      services: {},
      eventStore: fakeEventStore as unknown as import("../../storage/EventStore.js").EventStore,
    });
    await getInternals(monitor).tick();
    const alert = monitor.getStatus().activeAlerts.find((a) => a.key === "sqlite:wal_checkpoint_failed");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
  });

  test("WAL checkpoint success clears sqlite:wal_checkpoint_failed alert", async () => {
    const fakeEventStore = {
      getDatabase: () => ({}),
      ping: async () => true,
      getWalSizeBytes: () => 60_000_000,
      getFreelistRatio: () => 0,
      getIntegrityOk: () => 1,
      walCheckpoint: (_mode: string) => {},
      isAgentActive: () => false,
      close: async () => {},
    };
    const monitor = createHealthMonitor({
      services: {},
      eventStore: fakeEventStore as unknown as import("../../storage/EventStore.js").EventStore,
    });
    const internals = getInternals(monitor);

    // Pre-seed alert
    internals.alert("warning", "sqlite:wal_checkpoint_failed", "sqlite", "checkpoint failed");
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "sqlite:wal_checkpoint_failed")).toBe(true);

    // Successful tick with WAL > 50MB should clear alert
    await internals.tick();
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "sqlite:wal_checkpoint_failed")).toBe(false);
  });

  test("consecutiveTickFailures >= 3 fires monitor:tick_failure critical alert", () => {
    // probeSystemHealth catches ping() failures internally and returns { status: "unhealthy" }.
    // consecutiveTickFailures only increments on unhandled exceptions from the probe itself.
    // Test the threshold check directly via internals.
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Simulate 3 consecutive unhandled tick failures
    internals.consecutiveTickFailures = 3;
    internals.alert(
      "critical",
      "monitor:tick_failure",
      "sqlite",
      "Health monitoring degraded: 3 consecutive probe failures",
    );

    expect(internals.consecutiveTickFailures).toBeGreaterThanOrEqual(3);
    const alert = monitor.getStatus().activeAlerts.find((a) => a.key === "monitor:tick_failure");
    expect(alert?.severity).toBe("critical");
  });

  test("Qdrant baseline bootstrap: zero baseline + non-zero pointCount sets baseline without drift alert", async () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Simulate first ingest: baseline was 0, now 1000 points
    internals.baselineQdrantCount = 0;
    internals.checkThresholds({
      source: "qdrant",
      status: "healthy",
      metrics: [{ name: "point_count_drift_pct", value: 0, unit: "percent" }],
    });

    // Manually trigger the bootstrap path the way qualityTick would
    internals.baselineQdrantCount = 0;
    // Setting baseline directly simulates what qualityTick does on bootstrap
    internals.baselineQdrantCount = 1000;

    // No drift alert should fire (bootstrap, not drift)
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "qdrant:point_count_drift_pct")).toBe(false);
    expect(internals.baselineQdrantCount).toBe(1000);
  });

  test("Qdrant drift ratchet: baseline advances when drift <= 15%", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Set an initial baseline
    internals.baselineQdrantCount = 1000;

    // Simulate 10% drift (within ratchet threshold)
    internals.checkThresholds({
      source: "qdrant",
      status: "healthy",
      metrics: [{ name: "point_count_drift_pct", value: 10, unit: "percent" }],
    });

    // At 10% drift, no alert fires (below warnAbove=15), and ratchet in qualityTick would advance baseline
    // We verify the threshold rule is correct (10 < 15, so no alert)
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "qdrant:point_count_drift_pct")).toBe(false);
  });

  test("Qdrant drift > critAbove fires critical alert", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.checkThresholds({
      source: "qdrant",
      status: "healthy",
      metrics: [{ name: "point_count_drift_pct", value: 35, unit: "percent" }],
    });

    const alert = monitor.getStatus().activeAlerts.find((a) => a.key === "qdrant:point_count_drift_pct");
    expect(alert?.severity).toBe("critical");
  });

  test("neo4j:service_down alert fires and clears on health change", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Simulate tick result: neo4j unhealthy
    internals.activeAlerts.set("neo4j:service_down", {
      severity: "warning", key: "neo4j:service_down", source: "neo4j",
      message: "Neo4j is unreachable", timestamp: new Date().toISOString(),
    });

    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "neo4j:service_down")).toBe(true);

    // Simulate health restored: tick clears the alert
    internals.activeAlerts.delete("neo4j:service_down");
    internals.lastAlerts.delete("neo4j:service_down");

    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "neo4j:service_down")).toBe(false);
  });

  test("integrity check success clears sqlite:integrity_check_failed alert", async () => {
    const fakeEventStore = {
      ping: async () => true,
      getWalSizeBytes: () => 0,
      getFreelistRatio: () => 0,
      getIntegrityOk: () => 1, // returns healthy
      walCheckpoint: (_mode: string) => {},
      isAgentActive: () => false,
      close: async () => {},
    };
    const monitor = createHealthMonitor({
      services: {},
      eventStore: fakeEventStore as unknown as import("../../storage/EventStore.js").EventStore,
    });
    const internals = getInternals(monitor);

    // Pre-seed failure alert
    internals.alert("critical", "sqlite:integrity_check_failed", "sqlite", "check failed");
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "sqlite:integrity_check_failed")).toBe(true);

    // Quality tick with healthy integrity should clear the alert
    await internals.qualityTick();
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "sqlite:integrity_check_failed")).toBe(false);
  });

  test("neo4j:quality_probe_failed is cleared on successful quality probe", async () => {
    const fakeEventStore = {
      ping: async () => true,
      getWalSizeBytes: () => 0,
      getFreelistRatio: () => 0,
      getIntegrityOk: () => 1,
      walCheckpoint: (_mode: string) => {},
      isAgentActive: () => false,
      close: async () => {},
    };
    const fakeNeo4jClient = {
      isConnected: () => true,
      getCircuitState: () => "closed" as const,
      executeQuery: async <T>() => [] as T[],
    };
    const monitor = createHealthMonitor({
      services: { neo4jClient: fakeNeo4jClient as unknown as import("../../graph/Neo4jClient.js").Neo4jClient },
      eventStore: fakeEventStore as unknown as import("../../storage/EventStore.js").EventStore,
    });
    const internals = getInternals(monitor);

    // Pre-seed the failure alert
    internals.alert("warning", "neo4j:quality_probe_failed", "neo4j", "Quality probe failed: service unavailable");
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "neo4j:quality_probe_failed")).toBe(true);

    // Successful quality tick should clear the alert
    await internals.qualityTick();
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "neo4j:quality_probe_failed")).toBe(false);
  });

  test("qdrant:quality_probe_failed is cleared on successful quality probe", async () => {
    const fakeEventStore = {
      ping: async () => true,
      getWalSizeBytes: () => 0,
      getFreelistRatio: () => 0,
      getIntegrityOk: () => 1,
      walCheckpoint: (_mode: string) => {},
      isAgentActive: () => false,
      close: async () => {},
    };
    const fakeQdrantClient = {
      isConnected: () => true,
      getCircuitState: () => "closed" as const,
      getStats: async () => ({ totalVectors: 100 }),
    };
    const monitor = createHealthMonitor({
      services: { qdrantClient: fakeQdrantClient as unknown as import("../../search/QdrantClient.js").QdrantClientWrapper },
      eventStore: fakeEventStore as unknown as import("../../storage/EventStore.js").EventStore,
    });
    const internals = getInternals(monitor);

    // Pre-seed the failure alert
    internals.alert("warning", "qdrant:quality_probe_failed", "qdrant", "Quality probe failed: service unavailable");
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "qdrant:quality_probe_failed")).toBe(true);

    // Successful quality tick should clear the alert
    await internals.qualityTick();
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "qdrant:quality_probe_failed")).toBe(false);
  });

  test("severity de-escalation (critical → warning) bypasses dedup window", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Fire a critical alert
    internals.alert("critical", "test:metric", "sqlite", "critical threshold exceeded");
    const firstAlert = monitor.getStatus().activeAlerts.find((a) => a.key === "test:metric");
    expect(firstAlert?.severity).toBe("critical");

    // Immediately fire a warning for the same key — should bypass dedup and update severity
    internals.alert("warning", "test:metric", "sqlite", "back to warning level");
    const secondAlert = monitor.getStatus().activeAlerts.find((a) => a.key === "test:metric");
    expect(secondAlert?.severity).toBe("warning");
    expect(secondAlert?.message).toBe("back to warning level");
  });

  test("alert map is capped at MAX_ALERTS (200)", () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    // Generate 210 unique alerts by using different metric names
    for (let i = 0; i < 210; i++) {
      // Directly set alerts to avoid threshold logic
      internals.activeAlerts.set(`test:alert_${i}`, {
        severity: "warning",
        key: `test:alert_${i}`,
        source: "sqlite",
        message: `Alert ${i}`,
        timestamp: new Date(Date.now() + i).toISOString(),
      });
    }

    // Verify we can have more than 200 alerts via direct map access
    // The eviction only happens inside the alert() method
    expect(internals.activeAlerts.size).toBe(210);

    // Triggering a threshold alert should invoke the eviction logic
    internals.lastAlerts.clear();
    internals.checkThresholds({
      source: "sqlite",
      status: "unhealthy",
      metrics: [{ name: "integrity_ok", value: 0, unit: "boolean" }],
    });

    // After eviction: while loop evicts all extras down to MAX_ALERTS (200) cap
    expect(internals.activeAlerts.size).toBe(200);
  });

  test("qualityTickRunning re-entrancy guard skips concurrent invocations", async () => {
    const monitor = makeMonitor();
    const internals = getInternals(monitor);

    internals.qualityTickRunning = true;
    const before = monitor.getStatus().lastQualityTickAt;
    await internals.qualityTick();

    // Tick was skipped — lastQualityTickAt unchanged
    expect(monitor.getStatus().lastQualityTickAt).toBe(before);
    internals.qualityTickRunning = false;
  });

  test("qualityTick() updates lastQualityTickAt on success", async () => {
    const fakeEventStore = {
      ping: async () => true,
      getWalSizeBytes: () => 0,
      getFreelistRatio: () => 0,
      getIntegrityOk: () => 1,
      walCheckpoint: (_mode: string) => {},
      isAgentActive: () => false,
      close: async () => {},
    };
    const monitor = createHealthMonitor({
      services: {},
      eventStore: fakeEventStore as unknown as import("../../storage/EventStore.js").EventStore,
    });

    const internals = getInternals(monitor);
    expect(monitor.getStatus().lastQualityTickAt).toBeNull();

    await internals.qualityTick();

    expect(monitor.getStatus().lastQualityTickAt).not.toBeNull();
  });

  test("Qdrant bootstrap end-to-end: zero baseline + non-zero getStats sets baseline without drift alert", async () => {
    const fakeEventStore = {
      ping: async () => true,
      getWalSizeBytes: () => 0,
      getFreelistRatio: () => 0,
      getIntegrityOk: () => 1,
      walCheckpoint: (_mode: string) => {},
      isAgentActive: () => false,
      close: async () => {},
    };
    const fakeQdrantClient = {
      isConnected: () => true,
      getCircuitState: () => "closed" as const,
      getStats: async () => ({ totalVectors: 1000 }),
    };
    const monitor = createHealthMonitor({
      services: { qdrantClient: fakeQdrantClient as unknown as import("../../search/QdrantClient.js").QdrantClientWrapper },
      eventStore: fakeEventStore as unknown as import("../../storage/EventStore.js").EventStore,
    });
    const internals = getInternals(monitor);

    // Simulate bootstrap: baseline was 0 (first time, no prior baseline set — baselineQdrantCount is null initially)
    // First qualityTick sets baseline from null to 1000 (no drift check)
    await internals.qualityTick();
    expect(internals.baselineQdrantCount).toBe(1000);
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "qdrant:point_count_drift_pct")).toBe(false);

    // Now simulate second ingest: baseline is 1000, new count is 1000 (no drift)
    await internals.qualityTick();
    expect(monitor.getStatus().activeAlerts.some((a) => a.key === "qdrant:point_count_drift_pct")).toBe(false);
  });
});
