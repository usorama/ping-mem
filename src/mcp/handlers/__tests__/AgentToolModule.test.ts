/**
 * Tests for AgentToolModule — agent_register, agent_quota_status, agent_deregister.
 *
 * @module mcp/handlers/__tests__/AgentToolModule.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AgentToolModule } from "../AgentToolModule.js";
import { EventStore, createInMemoryEventStore } from "../../../storage/EventStore.js";
import { SessionManager } from "../../../session/SessionManager.js";
import type { SessionState } from "../shared.js";
import { createAgentId } from "../../../types/index.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestState(eventStore: EventStore): SessionState {
  return {
    currentSessionId: null,
    memoryManagers: new Map(),
    sessionManager: new SessionManager({ eventStore }),
    eventStore,
    vectorIndex: null,
    graphManager: null,
    entityExtractor: null,
    llmEntityExtractor: null,
    hybridSearchEngine: null,
    lineageEngine: null,
    evolutionEngine: null,
    ingestionService: null,
    diagnosticsStore: null,
    summaryGenerator: null,
    relevanceEngine: null,
    causalGraphManager: null,
    causalDiscoveryAgent: null,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentToolModule", () => {
  let eventStore: EventStore;
  let state: SessionState;
  let module: AgentToolModule;

  beforeEach(() => {
    eventStore = createInMemoryEventStore();
    state = createTestState(eventStore);
    module = new AgentToolModule(state);
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // --------------------------------------------------------------------------
  // Tool definitions
  // --------------------------------------------------------------------------

  test("exposes three tool definitions", () => {
    expect(module.tools).toHaveLength(3);
    const names = module.tools.map((t) => t.name);
    expect(names).toContain("agent_register");
    expect(names).toContain("agent_quota_status");
    expect(names).toContain("agent_deregister");
  });

  test("handle returns undefined for unknown tool name", () => {
    const result = module.handle("unknown_tool", {});
    expect(result).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // agent_register
  // --------------------------------------------------------------------------

  describe("agent_register", () => {
    test("registers agent with defaults", async () => {
      const result = await module.handle("agent_register", {
        agentId: "agent-alpha",
        role: "researcher",
      });

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.agentId).toBe("agent-alpha");
      expect(result!.role).toBe("researcher");
      expect(result!.admin).toBe(false);
      expect(result!.ttlMs).toBe(86_400_000);
      expect(result!.quotaBytes).toBe(10_485_760);
      expect(result!.quotaCount).toBe(10_000);
      expect(typeof result!.expiresAt).toBe("string");
    });

    test("registers agent with custom quotas", async () => {
      const result = await module.handle("agent_register", {
        agentId: "agent-beta",
        role: "coder",
        admin: true,
        ttlMs: 3600000,
        quotaBytes: 1024,
        quotaCount: 50,
        metadata: { team: "backend" },
      });

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      // admin is always false for self-registration (security: no self-escalation)
      expect(result!.admin).toBe(false);
      expect(result!.ttlMs).toBe(3600000);
      expect(result!.quotaBytes).toBe(1024);
      expect(result!.quotaCount).toBe(50);
    });

    test("upserts existing agent (updates role but preserves original quotas)", async () => {
      // First registration
      await module.handle("agent_register", {
        agentId: "agent-gamma",
        role: "reviewer",
        quotaBytes: 2048,
      });

      // Second registration (upsert) with different role and quota
      // Security: quota_bytes and quota_count are NOT updated on re-registration
      // to prevent self-escalation — only server config can change quotas.
      const result = await module.handle("agent_register", {
        agentId: "agent-gamma",
        role: "lead-reviewer",
        quotaBytes: 4096,
      });

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.role).toBe("lead-reviewer");
      // Return value reflects requested quota, but DB preserves original
      expect(result!.quotaBytes).toBe(4096);

      // Verify via quota_status that only one row exists
      // and that quotas were NOT escalated (preserved from first registration)
      const status = await module.handle("agent_quota_status", {
        agentId: "agent-gamma",
      });
      expect(status).toBeDefined();
      expect(status!.found).toBe(true);
      const usage = status!.usage as Record<string, unknown>;
      expect(usage.role).toBe("lead-reviewer");
      // Original quota (2048) is preserved, not escalated to 4096
      expect(usage.quotaBytes).toBe(2048);
    });

    test("throws for empty agentId", async () => {
      expect(
        module.handle("agent_register", {
          agentId: "",
          role: "researcher",
        })
      ).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // agent_quota_status
  // --------------------------------------------------------------------------

  describe("agent_quota_status", () => {
    test("returns found: false for unregistered agent", async () => {
      const result = await module.handle("agent_quota_status", {
        agentId: "nonexistent",
      });

      expect(result).toBeDefined();
      expect(result!.found).toBe(false);
    });

    test("returns quota usage for registered agent", async () => {
      // Register first
      await module.handle("agent_register", {
        agentId: "agent-delta",
        role: "coder",
        quotaBytes: 5000,
        quotaCount: 100,
      });

      const result = await module.handle("agent_quota_status", {
        agentId: "agent-delta",
      });

      expect(result).toBeDefined();
      expect(result!.found).toBe(true);
      const usage = result!.usage as Record<string, unknown>;
      expect(usage.agentId).toBe("agent-delta");
      expect(usage.role).toBe("coder");
      expect(usage.currentBytes).toBe(0);
      expect(usage.currentCount).toBe(0);
      expect(usage.quotaBytes).toBe(5000);
      expect(usage.quotaCount).toBe(100);
      expect(usage.percentUsed).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // agent_deregister
  // --------------------------------------------------------------------------

  describe("agent_deregister", () => {
    test("deregisters agent and cleans up quotas", async () => {
      await module.handle("agent_register", {
        agentId: "agent-epsilon",
        role: "tester",
      });

      const deregResult = await module.handle("agent_deregister", {
        agentId: "agent-epsilon",
      });

      expect(deregResult).toBeDefined();
      expect(deregResult!.success).toBe(true);
      expect(deregResult!.quotaRowsDeleted).toBe(1);

      // Verify agent is gone
      const statusResult = await module.handle("agent_quota_status", {
        agentId: "agent-epsilon",
      });
      expect(statusResult!.found).toBe(false);
    });

    test("deregisters agent and cleans up write locks", async () => {
      await module.handle("agent_register", {
        agentId: "agent-zeta",
        role: "writer",
      });

      // Insert a write lock manually
      const db = eventStore.getDatabase();
      const expiresAt = new Date(Date.now() + 30_000).toISOString();
      db.prepare(
        "INSERT INTO write_locks (lock_key, holder_id, acquired_at, expires_at, metadata) VALUES ($key, $holder, $acquired, $expires, '{}')"
      ).run({
        $key: "test-key",
        $holder: "agent-zeta",
        $acquired: new Date().toISOString(),
        $expires: expiresAt,
      });

      const deregResult = await module.handle("agent_deregister", {
        agentId: "agent-zeta",
      });

      expect(deregResult!.success).toBe(true);
      expect(deregResult!.lockRowsDeleted).toBe(1);

      // Verify lock is gone
      const lockRow = db
        .prepare("SELECT * FROM write_locks WHERE holder_id = 'agent-zeta'")
        .get();
      expect(lockRow).toBeNull();
    });

    test("deregister of non-existent agent succeeds with 0 deletions", async () => {
      const result = await module.handle("agent_deregister", {
        agentId: "ghost-agent",
      });

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.quotaRowsDeleted).toBe(0);
      expect(result!.lockRowsDeleted).toBe(0);
    });
  });
});
