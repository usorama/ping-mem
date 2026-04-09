/**
 * MCP stdio REST proxy for ping-mem.
 *
 * This is a thin proxy that forwards MCP tool calls to the Docker REST server.
 * It has ZERO imports from Database, EventStore, MemoryManager, or any service classes.
 * All tool state is owned by the Docker process; this process is stateless.
 *
 * Configuration via environment variables:
 *   PING_MEM_REST_URL    Base URL for the Docker REST server (default: http://localhost:3003)
 *   PING_MEM_ADMIN_USER  HTTP Basic Auth username (optional)
 *   PING_MEM_ADMIN_PASS  HTTP Basic Auth password (optional)
 *
 * @module mcp/proxy-cli
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tool-schemas.js";

// ============================================================================
// Configuration
// ============================================================================

const BASE_URL = process.env.PING_MEM_REST_URL ?? "http://localhost:3003";
const ADMIN_USER = process.env.PING_MEM_ADMIN_USER ?? "";
const ADMIN_PASS = process.env.PING_MEM_ADMIN_PASS ?? "";

// Configurable tool call timeout (default: 15s for interactive tools)
const TOOL_TIMEOUT_MS = parseInt(process.env["MCP_TOOL_TIMEOUT_MS"] ?? "15000", 10);

// Long-running tools get a fixed 120s budget regardless of TOOL_TIMEOUT_MS
const LONG_RUNNING_TOOLS = new Set([
  "codebase_ingest",
  "codebase_verify",
  "transcript_mine",
  "dreaming_run",
  "memory_consolidate",
  "memory_compress",
  "memory_maintain",
]);

const AUTH_HEADER =
  ADMIN_USER
    ? "Basic " + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64")
    : undefined;

// ============================================================================
// Health check
// ============================================================================

/** Check if the Docker ping-mem REST server is reachable */
export async function checkDockerHealth(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Attempt to start Docker ping-mem service (fire-and-forget) */
export async function tryStartDocker(): Promise<void> {
  try {
    const proc = Bun.spawn(["docker", "compose", "up", "-d", "ping-mem"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // Don't await — fire and forget so proxy startup is not blocked
    proc.exited.catch(() => {
      // Ignore errors — Docker may not be installed or compose file may not exist
    });
  } catch {
    // Ignore — docker command not available
  }
}

/**
 * Poll /health every pollIntervalMs until it returns 200 or maxWaitMs elapses.
 * Returns true if the server becomes healthy within the window, false on timeout.
 */
export async function waitForServer(
  baseUrl: string,
  maxWaitMs: number = 10_000,
  pollIntervalMs: number = 2_000
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const healthy = await checkDockerHealth(baseUrl);
    if (healthy) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remaining))
    );
  }
  return false;
}

// ============================================================================
// Tool call proxy
// ============================================================================

/** Proxy a single MCP tool call to the Docker REST server */
export async function proxyToolCall(
  name: string,
  args: Record<string, unknown>,
  baseUrl: string,
  authHeader?: string
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  // Long-running tools get a fixed 120s budget; interactive tools use TOOL_TIMEOUT_MS
  const timeoutMs = LONG_RUNNING_TOOLS.has(name) ? 120_000 : TOOL_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/api/v1/tools/${encodeURIComponent(name)}/invoke`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ args }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes("timed out") || message.includes("timeout");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: isTimeout ? "PROXY_TIMEOUT" : "PROXY_NETWORK_ERROR",
            message,
            hint: `Is ping-mem Docker running at ${baseUrl}? Try: docker compose up -d ping-mem`,
          }),
        },
      ],
      isError: true,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "PROXY_PARSE_ERROR",
            message: `HTTP ${response.status} — could not parse response body`,
          }),
        },
      ],
      isError: true,
    };
  }

  if (!response.ok) {
    const body = json as Record<string, unknown>;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: body["error"] ?? "PROXY_HTTP_ERROR",
            message: body["message"] ?? `HTTP ${response.status}`,
            status: response.status,
          }),
        },
      ],
      isError: true,
    };
  }

  const body = json as Record<string, unknown>;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(body["data"] ?? body, null, 2),
      },
    ],
  };
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  { name: "ping-mem", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } }
);

// List tools: serve static schemas locally (no HTTP round-trip)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Call tool: proxy to Docker REST
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return proxyToolCall(name, (args as Record<string, unknown>) ?? {}, BASE_URL, AUTH_HEADER);
});

// ============================================================================
// Startup
// ============================================================================

let isHealthy = await checkDockerHealth(BASE_URL);
if (!isHealthy) {
  process.stderr.write(`[ping-mem proxy] Docker not reachable at ${BASE_URL} — starting containers...\n`);
  await tryStartDocker();
  isHealthy = await waitForServer(BASE_URL, 10_000);
  if (!isHealthy) {
    process.stderr.write(
      `[ping-mem proxy] WARNING: Server not ready within 10s. Tool calls will fail until Docker is up.\n`
    );
  } else {
    process.stderr.write(`[ping-mem proxy] Server ready after startup wait.\n`);
  }
} else {
  process.stderr.write(`[ping-mem proxy] Connected to ${BASE_URL}\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
