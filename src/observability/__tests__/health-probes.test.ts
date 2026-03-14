import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EventStore } from "../../storage/EventStore.js";
import { getUiHealthColor, probeSystemHealth, sanitizeHealthError } from "../health-probes.js";

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

  test("skipIntegrityCheck skips expensive PRAGMA quick_check", async () => {
    const snapshot = await probeSystemHealth({ eventStore, skipIntegrityCheck: true });
    // integrity_ok defaults to 1 when skipped (trusting the database)
    expect(snapshot.components.sqlite.metrics?.integrity_ok).toBe(1);
    expect(snapshot.components.sqlite.status).toBe("healthy");
  });
});

describe("sanitizeHealthError", () => {
  test("sanitizes ECONNREFUSED errors", () => {
    expect(sanitizeHealthError(new Error("connect ECONNREFUSED 127.0.0.1:7687"))).toBe("connection refused");
  });

  test("sanitizes timeout errors", () => {
    expect(sanitizeHealthError(new Error("ETIMEDOUT at 10.0.0.1"))).toBe("connection timeout");
    expect(sanitizeHealthError(new Error("Connection timeout after 5000ms"))).toBe("connection timeout");
  });

  test("sanitizes connection reset errors", () => {
    expect(sanitizeHealthError(new Error("read ECONNRESET"))).toBe("connection reset");
  });

  test("sanitizes authentication errors", () => {
    expect(sanitizeHealthError(new Error("Neo4j authentication failed"))).toBe("authentication failed");
    expect(sanitizeHealthError(new Error("Invalid credentials"))).toBe("authentication failed");
    expect(sanitizeHealthError(new Error("Unauthorized access"))).toBe("authentication failed");
  });

  test("sanitizes disk space errors", () => {
    expect(sanitizeHealthError(new Error("ENOSPC: no space left on device"))).toBe("disk space issue");
    expect(sanitizeHealthError(new Error("disk quota exceeded"))).toBe("disk space issue");
  });

  test("sanitizes TLS/certificate errors", () => {
    expect(sanitizeHealthError(new Error("self-signed certificate"))).toBe("TLS/certificate error");
    expect(sanitizeHealthError(new Error("TLS handshake failed"))).toBe("TLS/certificate error");
    expect(sanitizeHealthError(new Error("SSL_ERROR_SYSCALL"))).toBe("TLS/certificate error");
  });

  test("returns partial message for unknown errors (first 64 chars for diagnostics)", () => {
    // Fallback includes the first 64 sanitized chars so authenticated callers get some context.
    expect(sanitizeHealthError(new Error("something weird happened"))).toBe("something weird happened");
    expect(sanitizeHealthError("string error")).toBe("string error");
    // Very long unknown errors are capped at 64 chars.
    const longMsg = "x".repeat(100);
    expect(sanitizeHealthError(new Error(longMsg))).toBe("x".repeat(64));
    // Empty/blank falls back to generic string.
    expect(sanitizeHealthError(new Error(""))).toBe("service unavailable");
  });

  test("is case-insensitive", () => {
    expect(sanitizeHealthError(new Error("AUTHENTICATION FAILED"))).toBe("authentication failed");
    expect(sanitizeHealthError(new Error("Certificate Error"))).toBe("TLS/certificate error");
  });
});
