/**
 * Tests for AgentIntelligence — agent identity persistence, cross-session
 * continuity, contradiction detection, and memory compression.
 *
 * @module memory/__tests__/AgentIntelligence.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentIntelligence } from "../AgentIntelligence.js";

// ============================================================================
// Test Helpers
// ============================================================================

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `agent-intel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  dbPath = join(tmpDir, "agent-intelligence.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Tests
// ============================================================================

describe("AgentIntelligence", () => {
  // --------------------------------------------------------------------------
  // 1. Agent Identity Persistence
  // --------------------------------------------------------------------------

  describe("Agent Identity Persistence", () => {
    test("registers a new agent", () => {
      const ai = new AgentIntelligence(dbPath);
      const agent = ai.registerAgent("builder-1", "builder", ["code", "test"], ["bun is fast"]);

      expect(agent.agentId).toBe("builder-1");
      expect(agent.role).toBe("builder");
      expect(agent.capabilities).toEqual(["code", "test"]);
      expect(agent.learnings).toEqual(["bun is fast"]);
      expect(agent.sessionCount).toBe(1);

      ai.close();
    });

    test("getAgent returns null for unknown agent", () => {
      const ai = new AgentIntelligence(dbPath);
      expect(ai.getAgent("nonexistent")).toBeNull();
      ai.close();
    });

    test("registerAgent increments session_count on re-register", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("builder-1", "builder");
      ai.registerAgent("builder-1", "builder");
      const agent = ai.registerAgent("builder-1", "builder");

      expect(agent.sessionCount).toBe(3);
      ai.close();
    });

    test("registerAgent updates role and capabilities", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("builder-1", "builder", ["code"]);
      const updated = ai.registerAgent("builder-1", "reviewer", ["review", "security"]);

      expect(updated.role).toBe("reviewer");
      expect(updated.capabilities).toEqual(["review", "security"]);
      ai.close();
    });

    test("listAgents returns all registered agents", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-a", "builder");
      ai.registerAgent("agent-b", "reviewer");
      ai.registerAgent("agent-c", "coordinator");

      const agents = ai.listAgents();
      expect(agents.length).toBe(3);
      const ids = agents.map((a) => a.agentId).sort();
      expect(ids).toEqual(["agent-a", "agent-b", "agent-c"]);

      ai.close();
    });

    test("registerAgent with default empty arrays", () => {
      const ai = new AgentIntelligence(dbPath);
      const agent = ai.registerAgent("agent-x", "scout");

      expect(agent.capabilities).toEqual([]);
      expect(agent.learnings).toEqual([]);
      ai.close();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Cross-Session Continuity
  // --------------------------------------------------------------------------

  describe("Cross-Session Continuity", () => {
    test("recordAction stores and retrieves history", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("builder-1", "builder");

      ai.recordAction("builder-1", "session-1", "started", "began working on feature X");
      ai.recordAction("builder-1", "session-1", "completed", "feature X done");

      const history = ai.getAgentHistory("builder-1");
      expect(history.length).toBe(2);
      // Both actions should be present
      const actions = history.map((h) => h.action).sort();
      expect(actions).toEqual(["completed", "started"]);

      ai.close();
    });

    test("getAgentHistory respects limit", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("builder-1", "builder");

      for (let i = 0; i < 10; i++) {
        ai.recordAction("builder-1", "session-1", `action-${i}`);
      }

      const limited = ai.getAgentHistory("builder-1", 3);
      expect(limited.length).toBe(3);

      ai.close();
    });

    test("getAgentHistory returns empty for unknown agent", () => {
      const ai = new AgentIntelligence(dbPath);
      const history = ai.getAgentHistory("nonexistent");
      expect(history).toEqual([]);
      ai.close();
    });

    test("getSessionHistory returns actions from all agents in a session", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("builder-1", "builder");
      ai.registerAgent("reviewer-1", "reviewer");

      ai.recordAction("builder-1", "session-42", "code", "wrote auth module");
      ai.recordAction("reviewer-1", "session-42", "review", "reviewed auth module");

      const sessionHistory = ai.getSessionHistory("session-42");
      expect(sessionHistory.length).toBe(2);
      // ASC order within session
      expect(sessionHistory[0]!.agentId).toBe("builder-1");
      expect(sessionHistory[1]!.agentId).toBe("reviewer-1");

      ai.close();
    });

    test("cross-session queries show agent activity across sessions", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("builder-1", "builder");

      ai.recordAction("builder-1", "session-1", "fix", "fixed bug #100");
      ai.recordAction("builder-1", "session-2", "feature", "added auth");
      ai.recordAction("builder-1", "session-3", "refactor", "cleaned up utils");

      const history = ai.getAgentHistory("builder-1");
      expect(history.length).toBe(3);
      // Should span 3 different sessions
      const sessionIds = new Set(history.map((h) => h.sessionId));
      expect(sessionIds.size).toBe(3);

      ai.close();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Contradiction Detection
  // --------------------------------------------------------------------------

  describe("Contradiction Detection", () => {
    test("no contradiction on first save", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      const result = ai.saveMemory("agent-1", "db-engine", "PostgreSQL");
      expect(result.found).toBe(false);
      expect(result.existingKey).toBeNull();

      ai.close();
    });

    test("no contradiction when same key and same value", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      ai.saveMemory("agent-1", "db-engine", "PostgreSQL");
      const result = ai.saveMemory("agent-1", "db-engine", "PostgreSQL");

      expect(result.found).toBe(false);
      ai.close();
    });

    test("detects contradiction when same key but different value", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      ai.saveMemory("agent-1", "db-engine", "PostgreSQL");
      const result = ai.saveMemory("agent-1", "db-engine", "MySQL");

      expect(result.found).toBe(true);
      expect(result.existingKey).toBe("db-engine");
      expect(result.existingValue).toBe("PostgreSQL");
      expect(result.newValue).toBe("MySQL");

      ai.close();
    });

    test("contradiction detection is per-agent", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");
      ai.registerAgent("agent-2", "reviewer");

      ai.saveMemory("agent-1", "db-engine", "PostgreSQL");
      // Different agent, same key — NOT a contradiction
      const result = ai.saveMemory("agent-2", "db-engine", "MySQL");

      expect(result.found).toBe(false);
      ai.close();
    });

    test("saves memory even when contradiction detected", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      ai.saveMemory("agent-1", "framework", "React");
      ai.saveMemory("agent-1", "framework", "Vue");

      // The new value should trigger a contradiction
      const result = ai.saveMemory("agent-1", "framework", "Svelte");
      expect(result.found).toBe(true);
      // existingValue is one of the prior values (React or Vue)
      expect(["React", "Vue"]).toContain(result.existingValue);
      expect(result.newValue).toBe("Svelte");

      ai.close();
    });

    test("saveMemory with category", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      const result = ai.saveMemory("agent-1", "choice", "TypeScript", "decision");
      expect(result.found).toBe(false);

      ai.close();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Memory Compression
  // --------------------------------------------------------------------------

  describe("Memory Compression", () => {
    test("compressOldMemories returns empty when no old memories", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      // Save recent memory (today)
      ai.saveMemory("agent-1", "key1", "value1");

      const summaries = ai.compressOldMemories(30);
      expect(summaries).toEqual([]);

      ai.close();
    });

    test("compressOldMemories compresses old memories", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      // Insert old memories directly with past timestamps
      const oldDate = new Date(Date.now() - 31 * 86_400_000).toISOString();
      const db = ai["db"]; // Access private db for test setup
      db.prepare(
        "INSERT INTO agent_memories (agent_id, key, value, category, created_at) VALUES ($a, $k, $v, $c, $d)"
      ).run({ $a: "agent-1", $k: "old-key-1", $v: "old-value-1", $c: "decision", $d: oldDate });
      db.prepare(
        "INSERT INTO agent_memories (agent_id, key, value, category, created_at) VALUES ($a, $k, $v, $c, $d)"
      ).run({ $a: "agent-1", $k: "old-key-2", $v: "old-value-2", $c: "decision", $d: oldDate });

      const summaries = ai.compressOldMemories(30);
      expect(summaries.length).toBe(1);
      expect(summaries[0]!.category).toBe("decision");
      expect(summaries[0]!.entryCount).toBe(2);
      expect(summaries[0]!.summary).toContain("old-key-1");
      expect(summaries[0]!.summary).toContain("old-key-2");

      ai.close();
    });

    test("compressed memories are not compressed again", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      const oldDate = new Date(Date.now() - 31 * 86_400_000).toISOString();
      const db = ai["db"];
      db.prepare(
        "INSERT INTO agent_memories (agent_id, key, value, category, created_at) VALUES ($a, $k, $v, $c, $d)"
      ).run({ $a: "agent-1", $k: "key1", $v: "val1", $c: "note", $d: oldDate });

      // First compression
      const first = ai.compressOldMemories(30);
      expect(first.length).toBe(1);

      // Second compression — should find nothing
      const second = ai.compressOldMemories(30);
      expect(second).toEqual([]);

      ai.close();
    });

    test("compression groups by category", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      const oldDate = new Date(Date.now() - 31 * 86_400_000).toISOString();
      const db = ai["db"];

      db.prepare(
        "INSERT INTO agent_memories (agent_id, key, value, category, created_at) VALUES ($a, $k, $v, $c, $d)"
      ).run({ $a: "agent-1", $k: "k1", $v: "v1", $c: "decision", $d: oldDate });
      db.prepare(
        "INSERT INTO agent_memories (agent_id, key, value, category, created_at) VALUES ($a, $k, $v, $c, $d)"
      ).run({ $a: "agent-1", $k: "k2", $v: "v2", $c: "fact", $d: oldDate });
      db.prepare(
        "INSERT INTO agent_memories (agent_id, key, value, category, created_at) VALUES ($a, $k, $v, $c, $d)"
      ).run({ $a: "agent-1", $k: "k3", $v: "v3", $c: "decision", $d: oldDate });

      const summaries = ai.compressOldMemories(30);
      expect(summaries.length).toBe(2);

      const categories = summaries.map((s) => s.category).sort();
      expect(categories).toEqual(["decision", "fact"]);

      const decisionSummary = summaries.find((s) => s.category === "decision");
      expect(decisionSummary!.entryCount).toBe(2);

      ai.close();
    });

    test("getCompressionLog returns entries", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      const oldDate = new Date(Date.now() - 31 * 86_400_000).toISOString();
      const db = ai["db"];
      db.prepare(
        "INSERT INTO agent_memories (agent_id, key, value, category, created_at) VALUES ($a, $k, $v, $c, $d)"
      ).run({ $a: "agent-1", $k: "k1", $v: "v1", $c: "note", $d: oldDate });

      ai.compressOldMemories(30);

      const logs = ai.getCompressionLog();
      expect(logs.length).toBe(1);
      expect(logs[0]!.category).toBe("note");

      ai.close();
    });

    test("compressOldMemories with custom days threshold", () => {
      const ai = new AgentIntelligence(dbPath);
      ai.registerAgent("agent-1", "builder");

      // Insert memory 5 days old
      const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
      const db = ai["db"];
      db.prepare(
        "INSERT INTO agent_memories (agent_id, key, value, category, created_at) VALUES ($a, $k, $v, $c, $d)"
      ).run({ $a: "agent-1", $k: "k1", $v: "v1", $c: "note", $d: fiveDaysAgo });

      // Should NOT compress with 30-day threshold
      expect(ai.compressOldMemories(30)).toEqual([]);

      // SHOULD compress with 3-day threshold
      const summaries = ai.compressOldMemories(3);
      expect(summaries.length).toBe(1);

      ai.close();
    });
  });

  // --------------------------------------------------------------------------
  // Edge Cases
  // --------------------------------------------------------------------------

  describe("Edge Cases", () => {
    test("persists across instances", () => {
      const ai1 = new AgentIntelligence(dbPath);
      ai1.registerAgent("builder-1", "builder", ["code"]);
      ai1.recordAction("builder-1", "session-1", "start");
      ai1.close();

      const ai2 = new AgentIntelligence(dbPath);
      const agent = ai2.getAgent("builder-1");
      expect(agent).not.toBeNull();
      expect(agent!.capabilities).toEqual(["code"]);

      const history = ai2.getAgentHistory("builder-1");
      expect(history.length).toBe(1);

      ai2.close();
    });

    test("handles many agents and history entries", () => {
      const ai = new AgentIntelligence(dbPath);

      for (let i = 0; i < 20; i++) {
        ai.registerAgent(`agent-${i}`, "worker");
        ai.recordAction(`agent-${i}`, `session-${i}`, "work", `task ${i}`);
      }

      const agents = ai.listAgents();
      expect(agents.length).toBe(20);

      ai.close();
    });
  });
});
