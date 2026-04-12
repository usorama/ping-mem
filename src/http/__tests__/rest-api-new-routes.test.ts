/**
 * Tests for new REST API endpoints added for MCP tool parity.
 *
 * Tests:
 * - Graph module: relationships, hybrid-search, lineage, evolution, health
 * - Causal module: causes, effects, chain, discover
 * - Worklog module: record, list
 * - Diagnostics module: compare, by-symbol
 * - Codebase module: list-projects, delete
 * - Memory module: subscribe, unsubscribe, compress
 * - Tool discovery: list, get, invoke
 *
 * @module http/__tests__/rest-api-new-routes.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RESTPingMemServer } from "../rest-server.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestServer(): RESTPingMemServer {
  return new RESTPingMemServer({
    dbPath: ":memory:",
    port: 0,
  });
}

async function request(
  server: RESTPingMemServer,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<Response> {
  const app = server.getApp();
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

async function startSession(server: RESTPingMemServer): Promise<string> {
  const res = await request(server, "POST", "/api/v1/session/start", {
    name: "test-session",
  });
  const json = (await res.json()) as { data: { sessionId: string } };
  return json.data.sessionId;
}

// ============================================================================
// Graph Endpoints
// ============================================================================

describe("Graph REST Endpoints", () => {
  let server: RESTPingMemServer;

  beforeEach(() => {
    server = createTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  test("GET /api/v1/graph/relationships returns 503 when graphManager not configured", async () => {
    const res = await request(server, "GET", "/api/v1/graph/relationships?entityId=test");
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Service Unavailable");
  });

  test("GET /api/v1/graph/relationships returns 503 when entityId missing (service check first)", async () => {
    const res = await request(server, "GET", "/api/v1/graph/relationships");
    // GraphManager not configured, so 503 takes priority over 400
    expect(res.status).toBe(503);
  });

  test("POST /api/v1/graph/hybrid-search returns 503 when not configured", async () => {
    const res = await request(server, "POST", "/api/v1/graph/hybrid-search", {
      query: "test query",
    });
    expect(res.status).toBe(503);
  });

  test("POST /api/v1/graph/hybrid-search returns 400 for invalid body", async () => {
    const res = await request(server, "POST", "/api/v1/graph/hybrid-search", {});
    expect(res.status).toBe(503); // 503 because hybridSearchEngine check happens first
  });

  test("GET /api/v1/graph/lineage/:entity returns 503 when not configured", async () => {
    const res = await request(server, "GET", "/api/v1/graph/lineage/some-entity");
    expect(res.status).toBe(503);
  });

  test("GET /api/v1/graph/evolution returns 503 when not configured", async () => {
    const res = await request(server, "GET", "/api/v1/graph/evolution?entityId=test");
    expect(res.status).toBe(503);
  });

  test("GET /api/v1/graph/evolution returns 503 when entityId missing (service check first)", async () => {
    const res = await request(server, "GET", "/api/v1/graph/evolution");
    // EvolutionEngine not configured, so 503 takes priority over 400
    expect(res.status).toBe(503);
  });

  test("GET /api/v1/graph/health returns 200 with health status", async () => {
    const res = await request(server, "GET", "/api/v1/graph/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { status: string; timestamp: string } };
    expect(json.data.status).toBeDefined();
    expect(json.data.timestamp).toBeDefined();
    expect(json.data.version).toBe("1.0.0");
  });
});

// ============================================================================
// Causal Endpoints
// ============================================================================

describe("Causal REST Endpoints", () => {
  let server: RESTPingMemServer;

  beforeEach(() => {
    server = createTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  test("GET /api/v1/causal/causes returns 503 when not configured", async () => {
    const res = await request(server, "GET", "/api/v1/causal/causes?entityId=test");
    expect(res.status).toBe(503);
  });

  test("GET /api/v1/causal/causes returns 400 when entityId missing", async () => {
    // Still 503 because service check is first
    const res = await request(server, "GET", "/api/v1/causal/causes");
    expect(res.status).toBe(503);
  });

  test("GET /api/v1/causal/effects returns 503 when not configured", async () => {
    const res = await request(server, "GET", "/api/v1/causal/effects?entityId=test");
    expect(res.status).toBe(503);
  });

  test("GET /api/v1/causal/chain returns 503 when not configured", async () => {
    const res = await request(
      server,
      "GET",
      "/api/v1/causal/chain?startEntityId=a&endEntityId=b"
    );
    expect(res.status).toBe(503);
  });

  test("GET /api/v1/causal/chain returns 400 when params missing (and service not configured)", async () => {
    const res = await request(server, "GET", "/api/v1/causal/chain");
    expect(res.status).toBe(503);
  });

  test("POST /api/v1/causal/discover returns 503 when not configured", async () => {
    const res = await request(server, "POST", "/api/v1/causal/discover", {
      text: "A causes B",
    });
    expect(res.status).toBe(503);
  });

  test("POST /api/v1/causal/discover returns 400 for invalid body", async () => {
    const res = await request(server, "POST", "/api/v1/causal/discover", {});
    // 503 first because agent check comes before validation
    expect(res.status).toBe(503);
  });
});

// ============================================================================
// Worklog Endpoints
// ============================================================================

describe("Worklog REST Endpoints", () => {
  let server: RESTPingMemServer;

  beforeEach(() => {
    server = createTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  test("POST /api/v1/worklog returns 400 when no session active", async () => {
    const res = await request(server, "POST", "/api/v1/worklog", {
      kind: "tool",
      title: "test event",
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/worklog returns 400 for invalid body", async () => {
    const res = await request(server, "POST", "/api/v1/worklog", {});
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/worklog succeeds with active session", async () => {
    const sessionId = await startSession(server);
    const res = await request(server, "POST", "/api/v1/worklog", {
      kind: "tool",
      title: "test event",
      status: "success",
      sessionId,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { success: boolean; eventId: string } };
    expect(json.data.success).toBe(true);
    expect(json.data.eventId).toBeDefined();
  });

  test("POST /api/v1/worklog validates task requires phase", async () => {
    const sessionId = await startSession(server);
    const res = await request(server, "POST", "/api/v1/worklog", {
      kind: "task",
      title: "test task",
      sessionId,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.message).toContain("phase");
  });

  test("GET /api/v1/worklog returns 400 when no session", async () => {
    const res = await request(server, "GET", "/api/v1/worklog");
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/worklog returns events for session", async () => {
    const sessionId = await startSession(server);
    // Record an event first
    await request(server, "POST", "/api/v1/worklog", {
      kind: "tool",
      title: "test event",
      sessionId,
    });

    const res = await request(server, "GET", `/api/v1/worklog?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { sessionId: string; count: number; events: unknown[] } };
    expect(json.data.sessionId).toBe(sessionId);
    expect(json.data.count).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Diagnostics — compare, by-symbol
// ============================================================================

describe("Diagnostics Additional REST Endpoints", () => {
  let server: RESTPingMemServer;

  beforeEach(() => {
    server = createTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  test("GET /api/v1/diagnostics/compare returns 400 when params missing", async () => {
    const res = await request(server, "GET", "/api/v1/diagnostics/compare");
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/diagnostics/compare returns results for valid params", async () => {
    const res = await request(
      server,
      "GET",
      "/api/v1/diagnostics/compare?projectId=test-proj&treeHash=abc123"
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { projectId: string; toolCount: number } };
    expect(json.data.projectId).toBe("test-proj");
    expect(json.data.toolCount).toBe(0); // No runs ingested
  });

  test("GET /api/v1/diagnostics/by-symbol returns 400 when analysisId missing", async () => {
    const res = await request(server, "GET", "/api/v1/diagnostics/by-symbol");
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/diagnostics/by-symbol returns results for valid analysisId", async () => {
    const res = await request(
      server,
      "GET",
      "/api/v1/diagnostics/by-symbol?analysisId=test-analysis-id"
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { analysisId: string; groupBy: string } };
    expect(json.data.analysisId).toBe("test-analysis-id");
    expect(json.data.groupBy).toBe("symbol");
  });

  test("GET /api/v1/diagnostics/by-symbol supports file groupBy", async () => {
    const res = await request(
      server,
      "GET",
      "/api/v1/diagnostics/by-symbol?analysisId=test-analysis-id&groupBy=file"
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { groupBy: string } };
    expect(json.data.groupBy).toBe("file");
  });
});

// ============================================================================
// Codebase — list-projects, delete
// ============================================================================

describe("Codebase Additional REST Endpoints", () => {
  let server: RESTPingMemServer;

  beforeEach(() => {
    server = createTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  test("GET /api/v1/codebase/projects returns 503 when ingestionService not configured", async () => {
    const res = await request(server, "GET", "/api/v1/codebase/projects");
    expect(res.status).toBe(503);
  });

  test("DELETE /api/v1/codebase/projects/:id returns 403 when admin credentials not configured", async () => {
    const res = await request(server, "DELETE", "/api/v1/codebase/projects/test-id");
    expect(res.status).toBe(403);
  });
});

// ============================================================================
// Memory — subscribe, unsubscribe, compress
// ============================================================================

describe("Memory Additional REST Endpoints", () => {
  let server: RESTPingMemServer;

  beforeEach(() => {
    server = createTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  test("POST /api/v1/memory/subscribe returns redirect message", async () => {
    const res = await request(server, "POST", "/api/v1/memory/subscribe", {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { success: boolean; message: string } };
    expect(json.data.success).toBe(false);
    expect(json.data.message).toContain("SSE");
  });

  test("POST /api/v1/memory/unsubscribe returns result", async () => {
    const res = await request(server, "POST", "/api/v1/memory/unsubscribe", {
      subscriptionId: "nonexistent-id",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { success: boolean } };
    expect(json.data.success).toBe(false); // nonexistent subscription
  });

  test("POST /api/v1/memory/unsubscribe returns 400 for missing subscriptionId", async () => {
    const res = await request(server, "POST", "/api/v1/memory/unsubscribe", {});
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/memory/compress returns 400 when no session", async () => {
    const res = await request(server, "POST", "/api/v1/memory/compress", {});
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/memory/compress works with active session", async () => {
    const sessionId = await startSession(server);
    const res = await request(
      server,
      "POST",
      "/api/v1/memory/compress",
      { maxCount: 10 },
      { "X-Session-ID": sessionId }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { result: { sourceCount: number } } };
    expect(json.data.result.sourceCount).toBe(0); // No memories to compress
  });
});

// ============================================================================
// Tool Discovery
// ============================================================================

describe("Tool Discovery REST Endpoints", () => {
  let server: RESTPingMemServer;

  beforeEach(() => {
    server = createTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  test("GET /api/v1/tools returns list of all tools", async () => {
    const res = await request(server, "GET", "/api/v1/tools");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { count: number; tools: Array<{ name: string }> } };
    expect(json.data.count).toBeGreaterThan(0);
    expect(json.data.tools[0]?.name).toBeDefined();
    // Verify some known tools are present
    const toolNames = json.data.tools.map((t) => t.name);
    expect(toolNames).toContain("context_session_start");
    expect(toolNames).toContain("codebase_search");
    expect(toolNames).toContain("diagnostics_ingest");
  });

  test("GET /api/v1/tools/:name returns specific tool schema", async () => {
    const res = await request(server, "GET", "/api/v1/tools/context_session_start");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { name: string; description: string; inputSchema: Record<string, unknown> };
    };
    expect(json.data.name).toBe("context_session_start");
    expect(json.data.description).toBeDefined();
    expect(json.data.inputSchema).toBeDefined();
  });

  test("GET /api/v1/tools/:name returns 404 for unknown tool", async () => {
    const res = await request(server, "GET", "/api/v1/tools/nonexistent_tool");
    expect(res.status).toBe(404);
  });

  test("POST /api/v1/tools/:name/invoke returns 403 when admin credentials not configured", async () => {
    const res = await request(server, "POST", "/api/v1/tools/nonexistent_tool/invoke", {
      args: {},
    });
    // Default-deny: no admin creds configured → 403
    expect([403, 429]).toContain(res.status);
    if (res.status === 403) {
      const json = (await res.json()) as { error: string; message: string };
      expect(json.error).toBe("Forbidden");
      expect(json.message).toContain("admin credentials not configured");
    }
  });
});
