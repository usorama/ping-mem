/**
 * SSE (Server-Sent Events) Transport for ping-mem
 *
 * Provides MCP protocol over HTTP using SSE for server-to-client
 * messages and HTTP POST for client-to-server messages.
 *
 * @module http/sse-server
 * @version 1.0.0
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as crypto from "crypto";

import { PingMemServer } from "../mcp/PingMemServer.js";

import type { SSEServerConfig } from "./types.js";
import type { PingMemServerConfig } from "../mcp/PingMemServer.js";
import { TOOLS } from "../mcp/PingMemServer.js";

// ============================================================================
// SSE Server Class
// ============================================================================

/**
 * SSE-based MCP server for ping-mem
 *
 * Uses StreamableHTTPServerTransport to provide MCP protocol over HTTP
 * with SSE streaming support.
 */
export class SSEPingMemServer {
  private server: Server;
  private transport: StreamableHTTPServerTransport;
  private config: SSEServerConfig & PingMemServerConfig;

  // Delegate tool execution to PingMemServer
  private toolServer: PingMemServer;

  constructor(config: SSEServerConfig & PingMemServerConfig) {
    this.config = {
      dbPath: ":memory:",
      enableVectorSearch: false,
      vectorDimensions: 768,
      ...config,
    };

    this.toolServer = new PingMemServer({
      dbPath: this.config.dbPath,
      enableVectorSearch: this.config.enableVectorSearch,
      vectorDimensions: this.config.vectorDimensions,
      graphManager: config.graphManager,
      hybridSearchEngine: config.hybridSearchEngine,
      lineageEngine: config.lineageEngine,
      evolutionEngine: config.evolutionEngine,
      ingestionService: config.ingestionService,
      diagnosticsStore: config.diagnosticsStore,
      diagnosticsDbPath: config.diagnosticsDbPath,
    });

    // Initialize MCP server
    this.server = new Server(
      {
        name: "ping-mem-sse-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize StreamableHTTP transport
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: this.config.sessionIdGenerator ?? (() => crypto.randomUUID()),
    });

    // Set up MCP tool handlers first
    this.setupHandlers();

    // Connect server to transport
    // Note: Type assertion needed due to optional onclose/onerror in StreamableHTTPServerTransport
    this.server.connect(this.transport as any);
  }

  /**
   * Set up MCP request handlers
   */
  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOLS,
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === "ping") {
          return { content: [{ type: "text", text: "pong" }] };
        }

        const result = await this.toolServer.dispatchToolCall(name, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown error",
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Handle incoming HTTP requests (both GET and POST)
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown
  ): Promise<void> {
    // Add CORS headers
    this.addCorsHeaders(res);

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Validate API key if configured
    // Auth is required only when: (apiKeyManager has seed key) OR (explicit apiKey is set non-empty)
    const authRequired = this.config.apiKeyManager
      ? this.config.apiKeyManager.hasSeedKey()
      : (this.config.apiKey && this.config.apiKey.trim().length > 0);

    if (authRequired) {
      const apiKey = req.headers["x-api-key"] as string | undefined;
      const isValid = this.config.apiKeyManager
        ? this.config.apiKeyManager.isValid(apiKey)
        : apiKey === this.config.apiKey;
      if (!isValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized", message: "Invalid API key" }));
        return;
      }
    }

    try {
      // Delegate to transport
      await this.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error("[SSE Server] Request handling error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Internal Server Error",
            message: error instanceof Error ? error.message : "Unknown error",
          })
        );
      }
    }
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(res: ServerResponse): void {
    const cors = this.config.cors ?? { origin: "*" };
    const origins = Array.isArray(cors.origin) ? cors.origin : [cors.origin ?? "*"];

    res.setHeader("Access-Control-Allow-Origin", origins.join(", "));
    res.setHeader("Access-Control-Allow-Methods", (cors.methods ?? ["GET", "POST", "OPTIONS"]).join(", "));
    res.setHeader(
      "Access-Control-Allow-Headers",
      (cors.headers ?? ["Content-Type", "X-API-Key", "X-Session-ID"]).join(", ")
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  /**
   * Start the SSE server
   *
   * Note: StreamableHTTPServerTransport doesn't need to be started manually.
   * It handles connections per-request. The start() method is a no-op.
   */
  async start(): Promise<void> {
    // Transport doesn't need explicit start for StreamableHTTP
    // It manages connections per-request
    console.log("[SSE Server] Ready (waiting for HTTP requests)");
  }

  /**
   * Stop the SSE server
   */
  async stop(): Promise<void> {
    await this.transport.close();
    await this.toolServer.close();
    console.log("[SSE Server] Stopped");
  }

  /**
   * Get the current session ID (if in stateful mode)
   */
  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  /**
   * Get the underlying MCP server instance
   */
  getMcpServer(): Server {
    return this.server;
  }

  /**
   * Get the underlying tool server instance
   */
  getToolServer(): PingMemServer {
    return this.toolServer;
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Create a default SSE server configuration
 */
export function createDefaultSSEConfig(
  overrides?: Partial<SSEServerConfig>
): SSEServerConfig {
  return {
    port: 3000,
    host: "0.0.0.0",
    transport: "streamable-http",
    cors: {
      origin: "*",
      methods: ["GET", "POST", "OPTIONS"],
      headers: ["Content-Type", "X-API-Key", "X-Session-ID"],
    },
    ...overrides,
  };
}
