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
import { IngestionService } from "../ingest/IngestionService.js";
import { AdminStore } from "../admin/AdminStore.js";
import { ApiKeyManager } from "../admin/ApiKeyManager.js";
import { DiagnosticsStore } from "../diagnostics/DiagnosticsStore.js";
import { EventStore } from "../storage/EventStore.js";
import { handleAdminRequest } from "./admin.js";

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
  const runtimeConfig = loadRuntimeConfig();
  const services = await createRuntimeServices();

  // Create IngestionService only when both Neo4j and Qdrant are available
  let ingestionService: IngestionService | undefined;
  if (services.neo4jClient && services.qdrantClient) {
    ingestionService = new IngestionService({
      neo4jClient: services.neo4jClient,
      qdrantClient: services.qdrantClient,
    });
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

  console.log(`[HTTP Server] Starting with transport: ${transport}`);
  console.log(`[HTTP Server] Listening on ${host}:${port}`);

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
      console.error("[HTTP Server] Unhandled error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Internal Server Error",
            message: error instanceof Error ? error.message : "Unknown error",
          })
        );
      }
      });
  });

  // Start listening
  httpServer.listen(port, host, () => {
    console.log(`[HTTP Server] Server listening on http://${host}:${port}`);
    console.log(`[HTTP Server] Transport: ${transport}`);
    if (apiKey) {
      console.log(`[HTTP Server] API key authentication enabled`);
    }
    console.log(`[HTTP Server] Press Ctrl+C to stop`);
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\n[HTTP Server] Shutting down...");
    httpServer.close();
    await serverInstance.stop();
    await eventStore.close();
    adminStore.close();
    console.log("[HTTP Server] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  startHTTPServer().catch((error) => {
    console.error("[HTTP Server] Failed to start:", error);
    process.exit(1);
  });
}
