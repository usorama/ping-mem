import * as fs from "node:fs";
import type { DiagnosticsStore } from "../diagnostics/DiagnosticsStore.js";
import type { GraphManager } from "../graph/GraphManager.js";
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

function getWalSizeBytes(eventStore: EventStore): number {
  const dbPath = eventStore.getDbPath();
  if (dbPath === ":memory:") {
    return 0;
  }

  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.warn("Cannot read WAL file", { path: `${dbPath}-wal`, code });
    }
    return 0;
  }
}

function getFreelistRatio(eventStore: EventStore): number {
  const db = eventStore.getDatabase();
  const pageCountRow = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
  const freelistRow = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
  const pageCount = pageCountRow?.page_count ?? 0;
  const freelistCount = freelistRow?.freelist_count ?? 0;
  if (pageCount <= 0) {
    return 0;
  }
  return freelistCount / pageCount;
}

export function getIntegrityOk(eventStore: EventStore): number {
  const db = eventStore.getDatabase();
  // Use quick_check instead of integrity_check — orders of magnitude faster
  // (integrity_check reads every page; quick_check only verifies b-tree structure)
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return row?.quick_check === "ok" ? 1 : 0;
}

export async function probeSystemHealth(deps: HealthProbeDeps): Promise<HealthSnapshot> {
  let status: "ok" | "degraded" | "unhealthy" = "ok";

  let sqlite: HealthComponent;
  try {
    const start = performance.now();
    deps.eventStore.getDatabase().prepare("SELECT 1").get();
    const walSize = getWalSizeBytes(deps.eventStore);
    const freelistRatio = getFreelistRatio(deps.eventStore);
    const integrityOk = deps.skipIntegrityCheck ? 1 : getIntegrityOk(deps.eventStore);
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
    sqlite = {
      status: "unhealthy",
      configured: true,
      error: toErrorMessage(error),
    };
    status = "unhealthy";
  }

  let neo4j: HealthComponent;
  if (deps.graphManager) {
    try {
      const start = performance.now();
      await deps.graphManager.getEntity("__health_check_nonexistent__");
      neo4j = {
        status: "healthy",
        configured: true,
        latencyMs: roundMs(performance.now() - start),
      };
    } catch (error) {
      neo4j = {
        status: "unhealthy",
        configured: true,
        error: toErrorMessage(error),
      };
      if (status !== "unhealthy") {
        status = "degraded";
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
      qdrant = {
        status: "unhealthy",
        configured: true,
        error: toErrorMessage(error),
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
      diagnostics = {
        status: "unhealthy",
        configured: true,
        error: toErrorMessage(error),
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
