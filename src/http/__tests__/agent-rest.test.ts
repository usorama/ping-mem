/**
 * Tests for REST agent management endpoints.
 *
 * Tests POST /api/v1/agents/register, GET /api/v1/agents/quotas,
 * DELETE /api/v1/agents/:agentId.
 *
 * @module http/__tests__/agent-rest.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RESTPingMemServer } from "../rest-server.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestServer(): RESTPingMemServer {
  return new RESTPingMemServer({
    dbPath: ":memory:",
    port: 0, // Unused — we test via app.request()
  });
}

async function request(
  server: RESTPingMemServer,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<Response> {
  const app = server.getApp();
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

// ============================================================================
// Tests
// ============================================================================

describe("REST Agent Endpoints", () => {
  let server: RESTPingMemServer;

  beforeEach(() => {
    server = createTestServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  // --------------------------------------------------------------------------
  // POST /api/v1/agents/register
  // --------------------------------------------------------------------------

  describe("POST /api/v1/agents/register", () => {
    test("registers agent with valid body and returns 200", async () => {
      const res = await request(server, "POST", "/api/v1/agents/register", {
        agentId: "test-agent-1",
        role: "coder",
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.agentId).toBe("test-agent-1");
      expect(json.data.role).toBe("coder");
      expect(json.data.admin).toBe(false);
      expect(json.data.ttlMs).toBe(86400000);
      expect(json.data.quotaBytes).toBe(10485760);
      expect(json.data.quotaCount).toBe(10000);
      expect(json.data.expiresAt).toBeDefined();
    });

    test("registers agent with custom quotas", async () => {
      const res = await request(server, "POST", "/api/v1/agents/register", {
        agentId: "test-agent-2",
        role: "reviewer",
        admin: true,
        ttlMs: 3600000,
        quotaBytes: 2048,
        quotaCount: 50,
        metadata: { team: "security" },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      // admin is always false for self-registration (security: no self-escalation)
      expect(json.data.admin).toBe(false);
      expect(json.data.quotaBytes).toBe(2048);
      expect(json.data.quotaCount).toBe(50);
    });

    test("returns 400 for missing agentId", async () => {
      const res = await request(server, "POST", "/api/v1/agents/register", {
        role: "coder",
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; message: string };
      expect(json.error).toBe("Bad Request");
    });

    test("returns 400 for missing role", async () => {
      const res = await request(server, "POST", "/api/v1/agents/register", {
        agentId: "test-agent-3",
      });

      expect(res.status).toBe(400);
    });

    test("returns 400 for empty body", async () => {
      const res = await request(server, "POST", "/api/v1/agents/register", {});

      expect(res.status).toBe(400);
    });

    test("upserts on duplicate agentId", async () => {
      // Register
      await request(server, "POST", "/api/v1/agents/register", {
        agentId: "dup-agent",
        role: "coder",
        quotaBytes: 100,
      });
      // Upsert with new role
      const res = await request(server, "POST", "/api/v1/agents/register", {
        agentId: "dup-agent",
        role: "reviewer",
        quotaBytes: 200,
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.role).toBe("reviewer");
      expect(json.data.quotaBytes).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/v1/agents/quotas
  // --------------------------------------------------------------------------

  describe("GET /api/v1/agents/quotas", () => {
    test("lists all agents when no query param", async () => {
      // Register two agents
      await request(server, "POST", "/api/v1/agents/register", {
        agentId: "agent-a",
        role: "coder",
      });
      await request(server, "POST", "/api/v1/agents/register", {
        agentId: "agent-b",
        role: "reviewer",
      });

      const res = await request(server, "GET", "/api/v1/agents/quotas");
      expect(res.status).toBe(200);

      const json = (await res.json()) as { data: { agents: unknown[] } };
      expect(json.data.agents).toBeInstanceOf(Array);
      expect(json.data.agents.length).toBeGreaterThanOrEqual(2);
    });

    test("returns single agent when agentId query param is provided", async () => {
      await request(server, "POST", "/api/v1/agents/register", {
        agentId: "agent-c",
        role: "tester",
      });

      const res = await request(
        server,
        "GET",
        "/api/v1/agents/quotas?agentId=agent-c"
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.agent_id).toBe("agent-c");
      expect(json.data.role).toBe("tester");
    });

    test("returns 404 for non-existent agentId", async () => {
      const res = await request(
        server,
        "GET",
        "/api/v1/agents/quotas?agentId=ghost"
      );
      expect(res.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/v1/agents/:agentId
  // --------------------------------------------------------------------------

  describe("DELETE /api/v1/agents/:agentId", () => {
    test("deregisters an existing agent", async () => {
      await request(server, "POST", "/api/v1/agents/register", {
        agentId: "agent-to-delete",
        role: "coder",
      });

      const res = await request(
        server,
        "DELETE",
        "/api/v1/agents/agent-to-delete"
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.agentId).toBe("agent-to-delete");
      expect(json.data.quotaRowsDeleted).toBe(1);

      // Verify agent is gone
      const quotaRes = await request(
        server,
        "GET",
        "/api/v1/agents/quotas?agentId=agent-to-delete"
      );
      expect(quotaRes.status).toBe(404);
    });

    test("returns 404 for non-existent agent", async () => {
      const res = await request(
        server,
        "DELETE",
        "/api/v1/agents/does-not-exist"
      );
      expect(res.status).toBe(404);
    });

    test("cleans up write locks on deregister", async () => {
      await request(server, "POST", "/api/v1/agents/register", {
        agentId: "lock-agent",
        role: "writer",
      });

      // Insert a lock manually
      const db = server.getEventStore().getDatabase();
      db.prepare(
        `INSERT INTO write_locks (lock_key, holder_id, acquired_at, expires_at, metadata)
         VALUES ('test-lock', 'lock-agent', datetime('now'), datetime('now', '+1 hour'), '{}')`
      ).run();

      const res = await request(server, "DELETE", "/api/v1/agents/lock-agent");
      expect(res.status).toBe(200);

      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.lockRowsDeleted).toBe(1);
    });
  });
});
