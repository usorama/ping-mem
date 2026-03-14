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
import { createLogger } from "../util/logger.js";
import { timingSafeStringEqual } from "../util/auth-utils.js";

const log = createLogger("SSE Server");

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
      eventStore: config.eventStore,
      qdrantClient: config.qdrantClient,
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
    this.server.connect(this.transport as Parameters<typeof this.server.connect>[0]);
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
    this.addCorsHeaders(req, res);

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Validate API key if configured
    // Auth is required only when: (apiKeyManager has seed key) OR (explicit apiKey is set non-empty)
    // Supports both X-API-Key header and Authorization: Bearer <token> header
    const authRequired = this.config.apiKeyManager
      ? this.config.apiKeyManager.hasSeedKey()
      : (this.config.apiKey && this.config.apiKey.trim().length > 0);

    if (authRequired) {
      // Check X-API-Key header first, then fall back to Authorization: Bearer
      let apiKey = req.headers["x-api-key"] as string | undefined;
      if (!apiKey) {
        const authHeader = req.headers["authorization"] as string | undefined;
        if (authHeader?.startsWith("Bearer ")) {
          apiKey = authHeader.slice(7);
        }
      }
      const isValid = this.config.apiKeyManager
        ? this.config.apiKeyManager.isValid(apiKey)
        : (this.config.apiKey ? timingSafeStringEqual(apiKey ?? "", this.config.apiKey) : false);
      if (!isValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized", message: "Invalid or missing API key. Use X-API-Key header or Authorization: Bearer <token>." }));
        return;
      }
    }

    try {
      // Delegate to transport
      await this.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      log.error("Request handling error", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Internal Server Error",
            message: "An unexpected error occurred",
          })
        );
      }
    }
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const envOrigin = process.env.PING_MEM_CORS_ORIGIN;
    const defaultOrigin = envOrigin ? envOrigin.split(",").map(s => s.trim()) : [];
    const corsConfig = this.config.cors ?? { origin: defaultOrigin };
    const resolvedOrigin = corsConfig.origin ?? defaultOrigin;
    const origins = Array.isArray(resolvedOrigin) ? resolvedOrigin : [resolvedOrigin];

    // Only set CORS headers if origins are configured
    if (origins.length === 0 || origins[0] === "") return;

    const requestOrigin = req.headers.origin;
    if (requestOrigin && origins.includes(requestOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    res.setHeader("Access-Control-Allow-Methods", (corsConfig.methods ?? ["GET", "POST", "OPTIONS"]).join(", "));
    res.setHeader(
      "Access-Control-Allow-Headers",
      (corsConfig.headers ?? ["Content-Type", "X-API-Key", "X-Session-ID", "Authorization"]).join(", ")
    );
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
    log.info("Ready (waiting for HTTP requests)");
  }

  /**
   * Stop the SSE server
   */
  async stop(): Promise<void> {
    await this.transport.close();
    await this.toolServer.close();
    log.info("Stopped");
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
      origin: process.env.PING_MEM_CORS_ORIGIN
        ? process.env.PING_MEM_CORS_ORIGIN.split(",").map(s => s.trim())
        : [],
      methods: ["GET", "POST", "OPTIONS"],
      headers: ["Content-Type", "X-API-Key", "X-Session-ID"],
    },
    ...overrides,
  };
}
