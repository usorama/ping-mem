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
    try {
      await ingestionService.ensureConstraints();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to create Neo4j constraints. Check Neo4j version, permissions, and connectivity.", { error: message });
      throw new Error(`Neo4j constraint setup failed: ${message}`);
    }
  }

  const transport = (process.env.PING_MEM_TRANSPORT as HTTPTransportType) ?? "streamable-http";
  const port = parseInt(process.env.PING_MEM_PORT ?? "3000");
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
      diagnosticsDbPath,
      graphManager: services.graphManager,
      lineageEngine: services.lineageEngine,
      evolutionEngine: services.evolutionEngine,
      ingestionService,
      qdrantClient: services.qdrantClient,
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
    });
  }

  // Start the server
  await serverInstance.start();

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
        res.writeHead(500, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
        res.end(
          JSON.stringify({
            error: "Internal Server Error",
            message: "An internal error occurred",
          })
        );
      }
      });
  });

  // Start listening
  httpServer.listen(port, host, () => {
    log.info(`Server listening on http://${host}:${port}`);
    log.info(`Transport: ${transport}`);
    if (apiKey) {
      log.info("API key authentication enabled");
    }
    log.info("Press Ctrl+C to stop");
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    httpServer.close();

    const shutdownErrors: string[] = [];
    try {
      await serverInstance.stop();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("Shutdown: serverInstance.stop() failed", { error: msg });
      shutdownErrors.push(`serverInstance: ${msg}`);
    }
    try {
      await eventStore.close();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("Shutdown: eventStore.close() failed", { error: msg });
      shutdownErrors.push(`eventStore: ${msg}`);
    }
    try {
      diagnosticsStore.close();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("Shutdown: diagnosticsStore.close() failed", { error: msg });
      shutdownErrors.push(`diagnosticsStore: ${msg}`);
    }
    try {
      adminStore.close();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("Shutdown: adminStore.close() failed", { error: msg });
      shutdownErrors.push(`adminStore: ${msg}`);
    }

    if (shutdownErrors.length > 0) {
      log.warn("Shutdown completed with errors", { errors: shutdownErrors });
    } else {
      log.info("Shutdown complete");
    }
    process.exit(shutdownErrors.length > 0 ? 1 : 0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
