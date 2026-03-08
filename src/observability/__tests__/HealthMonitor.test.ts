import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventStore } from "../../storage/EventStore.js";
import { createHealthMonitor } from "../HealthMonitor.js";
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

  test("raises warning/critical alerts from thresholds", () => {
    const services: RuntimeServices = {};
    const monitor = createHealthMonitor({ services, eventStore });

    const internals = monitor as unknown as {
      checkThresholds: (result: ProbeResult) => void;
    };

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
    const services: RuntimeServices = {};
    const monitor = createHealthMonitor({ services, eventStore });

    const internals = monitor as unknown as {
      checkThresholds: (result: ProbeResult) => void;
    };

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
});
