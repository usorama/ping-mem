import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventStore } from "../../storage/EventStore.js";
import { getUiHealthColor, probeSystemHealth } from "../health-probes.js";

describe("health-probes", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = new EventStore({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await eventStore.close();
  });

  test("returns sqlite metrics and not_configured optional services", async () => {
    const snapshot = await probeSystemHealth({ eventStore });

    expect(snapshot.components.sqlite.status).toBe("healthy");
    expect(snapshot.components.sqlite.metrics?.wal_size_bytes).toBe(0);
    expect(snapshot.components.neo4j.status).toBe("not_configured");
    expect(snapshot.components.qdrant.status).toBe("not_configured");
  });

  test("maps status to UI color", async () => {
    const snapshot = await probeSystemHealth({ eventStore });
    expect(getUiHealthColor(snapshot)).toBe("green");

    const degraded = {
      ...snapshot,
      status: "degraded" as const,
    };
    expect(getUiHealthColor(degraded)).toBe("yellow");

    const unhealthy = {
      ...snapshot,
      status: "unhealthy" as const,
    };
    expect(getUiHealthColor(unhealthy)).toBe("red");
  });

  test("sqlite probe measures latency", async () => {
    const snapshot = await probeSystemHealth({ eventStore });
    expect(snapshot.components.sqlite.latencyMs).toBeDefined();
    expect(snapshot.components.sqlite.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("sqlite probe computes freelist ratio", async () => {
    const snapshot = await probeSystemHealth({ eventStore });
    const ratio = snapshot.components.sqlite.metrics?.freelist_ratio;
    expect(ratio).toBeDefined();
    expect(ratio).toBeGreaterThanOrEqual(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  test("sqlite quick_check returns 1 for healthy database", async () => {
    const snapshot = await probeSystemHealth({ eventStore });
    expect(snapshot.components.sqlite.metrics?.integrity_ok).toBe(1);
  });

  test("snapshot overall status is ok when only sqlite is configured and healthy", async () => {
    const snapshot = await probeSystemHealth({ eventStore });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.timestamp).toBeDefined();
  });

  test("diagnostics probe is included when diagnosticsStore is provided", async () => {
    // Create a minimal diagnosticsStore mock
    const { DiagnosticsStore } = await import("../../diagnostics/DiagnosticsStore.js");
    const diagnosticsStore = new DiagnosticsStore();

    const snapshot = await probeSystemHealth({ eventStore, diagnosticsStore });
    expect(snapshot.components.diagnostics).toBeDefined();
    expect(snapshot.components.diagnostics?.status).toBe("healthy");
  });

  test("diagnostics component is absent when diagnosticsStore is not provided", async () => {
    const snapshot = await probeSystemHealth({ eventStore });
    expect(snapshot.components.diagnostics).toBeUndefined();
  });
});
