import type { DiagnosticsStore } from "../diagnostics/DiagnosticsStore.js";
import type { GraphManager } from "../graph/GraphManager.js";
import type { Neo4jClient } from "../graph/Neo4jClient.js";
import type { EventStore } from "../storage/EventStore.js";
import type { QdrantClientWrapper } from "../search/QdrantClient.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("health-probes");

/**
 * Sentinel entity key used by the graphManager Neo4j liveness probe.
 * Querying a non-existent entity is safe (no side effects) and exercises the
 * full Neo4j read path. The "not found" response is the expected healthy signal.
 */
const NEO4J_PING_SENTINEL = "__ping__";

/** Error message substrings that indicate "entity not found" — healthy signal for the liveness probe */
const NEO4J_NOT_FOUND_PATTERNS = ["not found", "no records"] as const;

export type ProbeStatus = "healthy" | "degraded" | "unhealthy" | "not_configured";

export interface HealthComponent {
  status: ProbeStatus;
  configured: boolean;
  latencyMs?: number;
  error?: string;
  metrics?: Record<string, number>;
}

export interface HealthSnapshot {
  status: "ok" | "degraded" | "unhealthy";
  timestamp: string;
  components: {
    sqlite: HealthComponent;
    neo4j: HealthComponent;
    qdrant: HealthComponent;
    diagnostics?: HealthComponent;
  };
}

export interface HealthProbeDeps {
  eventStore: EventStore;
  neo4jClient?: Neo4jClient;
  graphManager?: GraphManager;
  qdrantClient?: QdrantClientWrapper;
  diagnosticsStore?: DiagnosticsStore;
  skipIntegrityCheck?: boolean;
}

export function sanitizeHealthError(error: unknown): string {
  // Extract message: check Error.message first, then structured error objects
  // (e.g., Neo4j/Qdrant may return plain objects with .message or .error),
  // then fall back to String() as last resort.
  let raw: string;
  if (error instanceof Error) {
    raw = error.message;
  } else if (error !== null && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    raw = typeof obj["message"] === "string" ? obj["message"]
        : typeof obj["error"] === "string" ? obj["error"]
        : String(error);
  } else {
    raw = String(error);
  }
  // Strip control characters and BiDi/invisible formatting chars before keyword matching
  // (log injection defence). Matches HealthMonitor.alert() regex for consistency.
  const msg = raw.replace(/[\r\n\t\x00-\x1F\x7F\u061C\uFEFF\u202A-\u202E\u2066-\u2069]/g, "");
  const lower = msg.toLowerCase();
  if (lower.includes("econnrefused")) return "connection refused";
  if (lower.includes("enotfound") || lower.includes("eai_again")) return "hostname not found";
  if (lower.includes("ehostunreach") || lower.includes("enetunreach")) return "host unreachable";
  if (lower.includes("etimedout") || lower.includes("timeout")) return "connection timeout";
  if (lower.includes("econnreset")) return "connection reset";
  // Check TLS/certificate before broad 'auth' substring: a cert error from a spoofed
  // server whose subject DN contains 'auth' would otherwise be misclassified.
  if (lower.includes("certificate") || lower.includes("tls") || lower.includes("ssl")) return "TLS/certificate error";
  if (lower.includes("enospc") || lower.includes("disk")) return "disk space issue";
  if (lower.includes("auth") || lower.includes("credentials") || lower.includes("unauthorized")) return "authentication failed";
  // Fallback: return first 64 sanitized chars for diagnostic context.
  // This endpoint is only accessible to authenticated callers, so partial
  // error text does not leak sensitive data to unauthenticated parties.
  return msg.slice(0, 64) || "service unavailable";
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function toErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Strip control characters and BiDi/invisible formatting chars (log injection defence)
  // and truncate to prevent CPU spikes from large error payloads.
  // Matches HealthMonitor.alert() regex for consistency.
  return raw.replace(/[\r\n\t\x00-\x1F\x7F\u061C\uFEFF\u202A-\u202E\u2066-\u2069]/g, "").slice(0, 512);
}

/** Hard per-probe deadline: prevents a hanging TCP connection (e.g., silent network partition)
 * from blocking the health endpoint indefinitely. Network probes only — SQLite is local. */
const PROBE_TIMEOUT_MS = 8_000;

function withProbeTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS
    );
  });
  // Clear the timer when the primary promise settles to prevent leaked timers
  // from keeping the event loop alive (matters in tests and CLI tools).
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

export async function probeSystemHealth(deps: HealthProbeDeps): Promise<HealthSnapshot> {
  let status: "ok" | "degraded" | "unhealthy" = "ok";

  let sqlite: HealthComponent;
  try {
    const start = performance.now();
    const pingOk = await deps.eventStore.ping();
    if (!pingOk) {
      throw new Error("SQLite ping returned false — database may be unresponsive");
    }
    const walSize = deps.eventStore.getWalSizeBytes();
    const freelistRatio = deps.eventStore.getFreelistRatio();
    const integrityOk = deps.skipIntegrityCheck ? 1 : deps.eventStore.getIntegrityOk();
    sqlite = {
      status: integrityOk === 1 ? "healthy" : "unhealthy",
      configured: true,
      latencyMs: roundMs(performance.now() - start),
      metrics: {
        wal_size_bytes: walSize,
        freelist_ratio: freelistRatio,
        integrity_ok: integrityOk,
      },
    };
    if (integrityOk !== 1) {
      status = "unhealthy";
    }
  } catch (error) {
    log.error("SQLite probe failed", { error: toErrorMessage(error) });
    sqlite = {
      status: "unhealthy",
      configured: true,
      error: sanitizeHealthError(error),
    };
    status = "unhealthy";
  }

  let neo4j: HealthComponent;
  if (deps.neo4jClient) {
    try {
      const start = performance.now();
      const ok = await withProbeTimeout(deps.neo4jClient.ping(), "Neo4j");
      if (!ok) {
        throw new Error("ping returned false");
      }
      neo4j = {
        status: "healthy",
        configured: true,
        latencyMs: roundMs(performance.now() - start),
      };
    } catch (error) {
      log.warn("Neo4j probe failed", { error: toErrorMessage(error) });
      neo4j = {
        status: "unhealthy",
        configured: true,
        error: sanitizeHealthError(error),
      };
      if (status !== "unhealthy") {
        status = "degraded";
      }
    }
  } else if (deps.graphManager) {
    // Fallback: graphManager without direct neo4jClient access
    const gmStart = performance.now();
    try {
      // Use a known-safe operation: querying a non-existent entity
      await withProbeTimeout(deps.graphManager.getEntity(NEO4J_PING_SENTINEL), "Neo4j-graphManager");
      neo4j = {
        status: "healthy",
        configured: true,
        latencyMs: roundMs(performance.now() - gmStart),
      };
    } catch (error) {
      const msg = toErrorMessage(error);
      // Entity-not-found is the expected healthy response; any other error = unhealthy.
      // Pattern list is defined in NEO4J_NOT_FOUND_PATTERNS to avoid fragile inline strings.
      const lowerMsg = msg.toLowerCase();
      const isNotFound = NEO4J_NOT_FOUND_PATTERNS.some((p) => lowerMsg.includes(p));
      if (isNotFound) {
        neo4j = {
          status: "healthy",
          configured: true,
          latencyMs: roundMs(performance.now() - gmStart),
        };
      } else {
        log.warn("Neo4j probe (graphManager) failed", { error: msg });
        neo4j = {
          status: "unhealthy",
          configured: true,
          error: sanitizeHealthError(error),
        };
        if (status !== "unhealthy") {
          status = "degraded";
        }
      }
    }
  } else {
    neo4j = {
      status: "not_configured",
      configured: false,
    };
  }

  let qdrant: HealthComponent;
  if (deps.qdrantClient) {
    try {
      const start = performance.now();
      const healthy = await withProbeTimeout(deps.qdrantClient.healthCheck(), "Qdrant");
      qdrant = {
        status: healthy ? "healthy" : "unhealthy",
        configured: true,
        latencyMs: roundMs(performance.now() - start),
      };
      if (!healthy && status !== "unhealthy") {
        status = "degraded";
      }
    } catch (error) {
      log.warn("Qdrant probe failed", { error: toErrorMessage(error) });
      qdrant = {
        status: "unhealthy",
        configured: true,
        error: sanitizeHealthError(error),
      };
      if (status !== "unhealthy") {
        status = "degraded";
      }
    }
  } else {
    qdrant = {
      status: "not_configured",
      configured: false,
    };
  }

  let diagnostics: HealthComponent | undefined;
  if (deps.diagnosticsStore) {
    try {
      // listRuns() is synchronous (returns DiagnosticRun[]).
      // The return value is intentionally discarded — we only need the call to succeed
      // (throws on DB error) to confirm the diagnostics store is operational.
      deps.diagnosticsStore.listRuns({ limit: 1 });
      diagnostics = {
        status: "healthy",
        configured: true,
      };
    } catch (error) {
      log.warn("Diagnostics probe failed", { error: toErrorMessage(error) });
      diagnostics = {
        status: "unhealthy",
        configured: true,
        error: sanitizeHealthError(error),
      };
      if (status !== "unhealthy") {
        status = "degraded";
      }
    }
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    components: {
      sqlite,
      neo4j,
      qdrant,
      ...(diagnostics ? { diagnostics } : {}),
    },
  };
}

export function getUiHealthColor(snapshot: HealthSnapshot): "green" | "yellow" | "red" {
  if (snapshot.status === "unhealthy") {
    return "red";
  }
  if (snapshot.status === "degraded") {
    return "yellow";
  }
  return "green";
}
