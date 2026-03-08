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
});
