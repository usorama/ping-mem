import type { DiagnosticsStore } from "../diagnostics/DiagnosticsStore.js";
import type { GraphManager } from "../graph/GraphManager.js";
import type { Neo4jClient } from "../graph/Neo4jClient.js";
import type { EventStore } from "../storage/EventStore.js";
import type { QdrantClientWrapper } from "../search/QdrantClient.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("health-probes");

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
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  if (lower.includes("econnrefused")) return "connection refused";
  if (lower.includes("etimedout") || lower.includes("timeout")) return "connection timeout";
  if (lower.includes("econnreset")) return "connection reset";
  if (lower.includes("auth") || lower.includes("credentials") || lower.includes("unauthorized")) return "authentication failed";
  if (lower.includes("enospc") || lower.includes("disk")) return "disk space issue";
  if (lower.includes("certificate") || lower.includes("tls") || lower.includes("ssl")) return "TLS/certificate error";
  return "service unavailable";
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function probeSystemHealth(deps: HealthProbeDeps): Promise<HealthSnapshot> {
  let status: "ok" | "degraded" | "unhealthy" = "ok";

  let sqlite: HealthComponent;
  try {
    const start = performance.now();
    await deps.eventStore.ping();
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
      const ok = await deps.neo4jClient.ping();
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
      // Use a known-safe operation: listing empty set
      await deps.graphManager.getEntity("__ping__");
      neo4j = {
        status: "healthy",
        configured: true,
        latencyMs: roundMs(performance.now() - gmStart),
      };
    } catch (error) {
      const msg = toErrorMessage(error);
      // Entity-not-found is expected; any other error = unhealthy
      const isNotFound = msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("no records");
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
      const healthy = await deps.qdrantClient.healthCheck();
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
