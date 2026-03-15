/**
 * HTTP Server Main Entry Point
 *
 * Starts ping-mem HTTP server using either SSE or REST transport.
 *
 * @module http/server
 * @version 1.0.0
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SSEPingMemServer, createDefaultSSEConfig } from "./sse-server.js";
import { RESTPingMemServer, createDefaultRESTConfig } from "./rest-server.js";
import type { HTTPTransportType } from "./types.js";
import { createRuntimeServices, loadRuntimeConfig } from "../config/runtime.js";
import { validateEnv } from "../config/env-validation.js";
import { IngestionService } from "../ingest/IngestionService.js";
import { AdminStore } from "../admin/AdminStore.js";
import { ApiKeyManager } from "../admin/ApiKeyManager.js";
import { DiagnosticsStore } from "../diagnostics/DiagnosticsStore.js";
import { EventStore } from "../storage/EventStore.js";
import { handleAdminRequest } from "./admin.js";
import { createLogger } from "../util/logger.js";
import { createHealthMonitor } from "../observability/HealthMonitor.js";

const log = createLogger("HTTP Server");

// ============================================================================
// Server Factory
// ============================================================================

/**
 * Start ping-mem HTTP server
 *
 * Automatically detects transport type from environment variable
 * PING_MEM_TRANSPORT (sse, rest, or streamable-http).
 */
export async function startHTTPServer(): Promise<void> {
  validateEnv();

  const runtimeConfig = loadRuntimeConfig();
  const services = await createRuntimeServices();

  // Create IngestionService only when both Neo4j and Qdrant are available
  let ingestionService: IngestionService | undefined;
  if (services.neo4jClient && services.qdrantClient) {
    ingestionService = new IngestionService({
      neo4jClient: services.neo4jClient,
      qdrantClient: services.qdrantClient,
    });
    // Ensure Neo4j uniqueness constraints exist before accepting any ingest requests.
    // MCP path calls this after construction; HTTP path must mirror that behaviour.
    await ingestionService.ensureConstraints().catch((err) => {
      log.warn("ensureConstraints failed at HTTP startup — ingestion may degrade", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  const transport = (process.env.PING_MEM_TRANSPORT as HTTPTransportType) ?? "streamable-http";
  const rawPort = parseInt(process.env.PING_MEM_PORT ?? "3000", 10);
  const port = Number.isNaN(rawPort) ? 3000 : rawPort;
  const host = process.env.PING_MEM_HOST ?? "0.0.0.0";
  const apiKey = process.env.PING_MEM_API_KEY;
  const diagnosticsDbPath = process.env.PING_MEM_DIAGNOSTICS_DB_PATH;
  const adminDbPath = process.env.PING_MEM_ADMIN_DB_PATH ?? runtimeConfig.pingMem.dbPath;

  const adminStore = new AdminStore({ dbPath: adminDbPath });
  const apiKeyManager = new ApiKeyManager(adminStore);
  apiKeyManager.ensureSeedKey(apiKey);

  const diagnosticsStore = new DiagnosticsStore(
    diagnosticsDbPath ? { dbPath: diagnosticsDbPath } : undefined
  );
  const eventStore = new EventStore({ dbPath: runtimeConfig.pingMem.dbPath });
  const healthMonitor = createHealthMonitor({ services, eventStore, diagnosticsStore });

  log.info(`Starting with transport: ${transport}`);
  log.info(`Listening on ${host}:${port}`);

  // Create server instance based on transport type
  let serverInstance: SSEPingMemServer | RESTPingMemServer;

  if (transport === "rest") {
    // REST API mode
    const restConfig = createDefaultRESTConfig({
      port,
      host,
    });

    if (apiKey) {
      restConfig.apiKey = apiKey;
    }
    restConfig.apiKeyManager = apiKeyManager;
    restConfig.adminStore = adminStore;

    serverInstance = new RESTPingMemServer({
      ...restConfig,
      dbPath: runtimeConfig.pingMem.dbPath,
      diagnosticsStore,
      graphManager: services.graphManager,
      lineageEngine: services.lineageEngine,
      evolutionEngine: services.evolutionEngine,
      ingestionService,
      qdrantClient: services.qdrantClient,
      healthMonitor,
      eventStore,
    });
  } else {
    // SSE / Streamable HTTP mode
    const sseConfig = createDefaultSSEConfig({
      port,
      host,
      transport,
    });

    if (apiKey) {
      sseConfig.apiKey = apiKey;
    }
    sseConfig.apiKeyManager = apiKeyManager;

    serverInstance = new SSEPingMemServer({
      ...sseConfig,
      dbPath: runtimeConfig.pingMem.dbPath,
      diagnosticsDbPath,
      graphManager: services.graphManager,
      lineageEngine: services.lineageEngine,
      evolutionEngine: services.evolutionEngine,
      ingestionService,
      qdrantClient: services.qdrantClient,
      eventStore,
    });
  }

  // Hydrate sessions from persisted events before accepting requests
  await serverInstance.hydrateSessionState();

  // Start the server
  await serverInstance.start();
  healthMonitor.start();

  // Create Node.js HTTP server
  const httpServer = createServer((req, res) => {
    handleAdminRequest(req, res, {
      adminStore,
      apiKeyManager,
      ingestionService,
      diagnosticsStore,
      eventStore,
    })
      .then((handled) => {
        if (handled) {
          return;
        }
        return serverInstance.handleRequest(req, res);
      })
      .catch((error) => {
        log.error("Unhandled error", { error: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        } else {
          res.destroy();
        }
      });
  });

  // Handle graceful shutdown
  let shuttingDown = false;
  const isCrashSignal = (signal: string) =>
    signal === "uncaughtException" || signal === "unhandledRejection";

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log.info("Shutting down...");
    log.info("Shutdown signal received", { signal });
    await healthMonitor.stop();

    const shutdownErrors: string[] = [];

    // Stop the app server first to drain SSE streams and in-flight requests.
    // httpServer.close() blocks until all connections end, so stopping SSE streams
    // before closing the HTTP listener prevents indefinite shutdown hangs.
    try { await serverInstance.stop(); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); shutdownErrors.push(`serverInstance: ${msg}`); }

    try { await new Promise<void>((resolve, reject) => { httpServer.close((err) => (err ? reject(err) : resolve())); }); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); shutdownErrors.push(`httpServer: ${msg}`); }

    try { if (services.neo4jClient) await services.neo4jClient.disconnect(); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); shutdownErrors.push(`neo4j: ${msg}`); }

    try { if (services.qdrantClient) await services.qdrantClient.disconnect(); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); shutdownErrors.push(`qdrant: ${msg}`); }

    try { await eventStore.close(); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); shutdownErrors.push(`eventStore: ${msg}`); }

    try { diagnosticsStore.close(); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); shutdownErrors.push(`diagnosticsStore: ${msg}`); }

    try { adminStore.close(); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); shutdownErrors.push(`adminStore: ${msg}`); }

    if (shutdownErrors.length > 0) {
      log.error("Shutdown completed with errors", { errors: shutdownErrors });
      process.exit(1);
    }
    log.info("Shutdown complete");
    // Crash signals (uncaughtException, unhandledRejection) must exit non-zero
    process.exit(isCrashSignal(signal) ? 1 : 0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("uncaughtException", (error) => {
    log.error("Uncaught exception", { error: error.message, stack: error.stack });
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    void shutdown("unhandledRejection");
  });

  // Start listening (signal handlers registered first so SIGINT during listen is handled)
  httpServer.on("error", (error: NodeJS.ErrnoException) => {
    log.error("HTTP server error", { code: error.code, message: error.message });
    if (error.code === "EADDRINUSE") {
      log.error(`Port ${port} is already in use. Exiting.`);
    }
    // All fatal server errors trigger graceful shutdown (not process.exit directly
    // so that eventStore, adminStore, diagnosticsStore are closed cleanly)
    void shutdown("http_server_error");
  });

  httpServer.listen(port, host, () => {
    log.info(`Server listening on http://${host}:${port}`);
    log.info(`Transport: ${transport}`);
    if (apiKey) {
      log.info("API key authentication enabled");
    }
    log.info("Press Ctrl+C to stop");
  });
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  startHTTPServer().catch((error) => {
    log.error("Failed to start", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
