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
  const transport = (process.env.PING_MEM_TRANSPORT as HTTPTransportType) ?? "streamable-http";
  const port = parseInt(process.env.PING_MEM_PORT ?? "3000");
  const host = process.env.PING_MEM_HOST ?? "0.0.0.0";
  const apiKey = process.env.PING_MEM_API_KEY;

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

    serverInstance = new RESTPingMemServer(restConfig);
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

    serverInstance = new SSEPingMemServer(sseConfig);
  }

  // Start the server
  await serverInstance.start();

  // Create Node.js HTTP server
  const httpServer = createServer((req, res) => {
    serverInstance.handleRequest(req, res).catch((error) => {
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
