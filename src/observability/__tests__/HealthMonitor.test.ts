import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventStore } from "../../storage/EventStore.js";
import { HealthMonitor, createHealthMonitor, type HealthMonitorDeps } from "../HealthMonitor.js";
import type { RuntimeServices } from "../../config/runtime.js";

interface ProbeMetric {
  name: string;
  value: number;
  unit: "bytes" | "count" | "ratio" | "boolean" | "ms";
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
      baselineQdrantCount: number | null;
      lastAlerts: Map<string, number>;
      activeAlerts: Map<string, unknown>;
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

  test("getStatus() reports running=false before start and running=true after start", () => {
    const monitor = makeMonitor();
    expect(monitor.getStatus().running).toBe(false);

    monitor.start();
    expect(monitor.getStatus().running).toBe(true);

    monitor.stop();
    expect(monitor.getStatus().running).toBe(false);
  });

  test("start() is idempotent — calling twice does not create duplicate timers", () => {
    const monitor = makeMonitor();
    monitor.start();
    monitor.start();
    expect(monitor.getStatus().running).toBe(true);
    monitor.stop();
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

    internals.checkThresholds({
      source: "qdrant",
      status: "healthy",
      metrics: [{ name: "point_count_drift_pct", value: 8, unit: "ratio" }],
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
});
