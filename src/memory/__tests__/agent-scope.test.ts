/**
 * Tests for multi-agent scope enforcement in MemoryManager.
 *
 * Validates that the agentScope field (private, role, shared, public)
 * controls which agents can read which memories.
 *
 * @module memory/__tests__/agent-scope.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryManager, createMemoryManager } from "../MemoryManager.js";
import { createInMemoryEventStore, EventStore } from "../../storage/EventStore.js";
import { createAgentId, type AgentId } from "../../types/index.js";

// ============================================================================
// Test Helpers
// ============================================================================

function makeManager(opts: {
  eventStore: EventStore;
  sessionId: string;
  agentId?: AgentId;
  agentRole?: string;
}): MemoryManager {
  return createMemoryManager({
    sessionId: opts.sessionId,
    eventStore: opts.eventStore,
    agentId: opts.agentId,
    agentRole: opts.agentRole,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Agent Scope Enforcement", () => {
  let eventStore: EventStore;

  beforeEach(() => {
    eventStore = createInMemoryEventStore();
  });

  afterEach(async () => {
    await eventStore.close();
  });

  // --------------------------------------------------------------------------
  // Private scope
  // --------------------------------------------------------------------------

  describe("private scope", () => {
    test("owning agent can read its own private memory", async () => {
      const agentA = createAgentId("agent-a");

      const writer = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "coder",
      });

      await writer.save("secret-key", "private-value", {
        agentId: agentA,
        agentScope: "private",
      });

      const memory = writer.get("secret-key");
      expect(memory).not.toBeNull();
      expect(memory!.value).toBe("private-value");
    });

    test("another agent cannot read private memory", async () => {
      const agentA = createAgentId("agent-a");
      const agentB = createAgentId("agent-b");

      // Agent A saves a private memory
      const writerA = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "coder",
      });
      await writerA.save("secret-key", "private-value", {
        agentId: agentA,
        agentScope: "private",
      });

      // Agent B tries to read the same key (shares same in-memory map via same manager isn't possible,
      // so we create a separate manager and save data into it by sharing the underlying memory store)
      // The simplest way to test this: create a second manager with agentB identity but
      // populate it with agentA's memory by saving directly and reading with the other identity.
      // Since managers have separate in-memory caches, we use a single manager but switch identity.
      // Instead, the realistic pattern is: both managers see the same data.
      // We simulate by saving into one manager, then creating another manager sharing the same
      // in-memory cache concept. Since MemoryManager uses in-memory Map, the only way two agents
      // share data is through the same manager instance.
      // For proper testing, we create one manager, save data, then create another with different
      // agentId that has the same memory injected via recall. But MemoryManager.list() also does
      // scope filtering.
      //
      // Practical approach: Use the same MemoryManager for both agents since it stores all
      // memories in its Map. The scope check only uses the manager's agentId.
      // We can't do that with the current API since agentId is set at construction time.
      //
      // Best approach: Save with agentA, then create a new manager wrapping the same memories.
      // The cleanest test: save via agentA's manager, then create agentB's manager, inject
      // the memory by calling save through the internal Map (not possible without hacks).
      //
      // We test via list() which respects scope. Since both managers have independent caches,
      // we construct a combined approach: save in one manager, then verify the scope via
      // a reader manager that has the data hydrated.
      //
      // Simplest correct test: Create one MemoryManager with agentA, save private. Then access
      // .get() from a new manager (agentB) - it won't see it because it has a separate cache.
      // The scope enforcement is in the get/list/recall methods using isVisibleToCurrentAgent.
      //
      // To test properly: both agents need the same memory in their cache.
      // We achieve this by using saveOrUpdate through the event store + hydrate.
      const writerB = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentB,
        agentRole: "coder",
      });
      // Hydrate from event store — picks up agentA's MEMORY_SAVED event
      await writerB.hydrate();

      const memory = writerB.get("secret-key");
      expect(memory).toBeNull();
    });

    test("unscoped caller (no agentId) cannot read private memory", async () => {
      const agentA = createAgentId("agent-a");

      const writer = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "coder",
      });
      await writer.save("secret-key", "private-value", {
        agentId: agentA,
        agentScope: "private",
      });

      // Create an unscoped manager (legacy, no agentId)
      const legacy = makeManager({
        eventStore,
        sessionId: "sess-1",
      });
      await legacy.hydrate();

      const memory = legacy.get("secret-key");
      expect(memory).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Role scope
  // --------------------------------------------------------------------------

  describe("role scope", () => {
    test("agents with same role can read role-scoped memory", async () => {
      const agentA = createAgentId("agent-a");
      const agentC = createAgentId("agent-c");

      const writer = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "researcher",
      });
      await writer.save("shared-research", "findings", {
        agentId: agentA,
        agentScope: "role",
      });

      // Agent C is also a "researcher"
      const reader = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentC,
        agentRole: "researcher",
      });
      await reader.hydrate();

      const memory = reader.get("shared-research");
      expect(memory).not.toBeNull();
      expect(memory!.value).toBe("findings");
    });

    test("agents with different role cannot read role-scoped memory", async () => {
      const agentA = createAgentId("agent-a");
      const agentD = createAgentId("agent-d");

      const writer = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "researcher",
      });
      await writer.save("research-notes", "private research data", {
        agentId: agentA,
        agentScope: "role",
      });

      // Agent D is a "coder", not "researcher"
      const reader = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentD,
        agentRole: "coder",
      });
      await reader.hydrate();

      const memory = reader.get("research-notes");
      expect(memory).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Shared scope
  // --------------------------------------------------------------------------

  describe("shared scope", () => {
    test("all registered agents can read shared-scoped memory", async () => {
      const agentA = createAgentId("agent-a");
      const agentE = createAgentId("agent-e");

      const writer = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "coder",
      });
      await writer.save("shared-info", "visible to all agents", {
        agentId: agentA,
        agentScope: "shared",
      });

      const reader = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentE,
        agentRole: "reviewer",
      });
      await reader.hydrate();

      const memory = reader.get("shared-info");
      expect(memory).not.toBeNull();
      expect(memory!.value).toBe("visible to all agents");
    });

    test("unscoped caller (no agentId) cannot read shared-scoped memory", async () => {
      const agentA = createAgentId("agent-a");

      const writer = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "coder",
      });
      await writer.save("shared-only", "shared data", {
        agentId: agentA,
        agentScope: "shared",
      });

      const legacy = makeManager({
        eventStore,
        sessionId: "sess-1",
      });
      await legacy.hydrate();

      const memory = legacy.get("shared-only");
      expect(memory).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Public scope
  // --------------------------------------------------------------------------

  describe("public scope", () => {
    test("unregistered callers can read public-scoped memory", async () => {
      const agentA = createAgentId("agent-a");

      const writer = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "coder",
      });
      await writer.save("public-note", "hello world", {
        agentId: agentA,
        agentScope: "public",
      });

      // Legacy manager (no agentId) reads
      const legacy = makeManager({
        eventStore,
        sessionId: "sess-1",
      });
      await legacy.hydrate();

      const memory = legacy.get("public-note");
      expect(memory).not.toBeNull();
      expect(memory!.value).toBe("hello world");
    });
  });

  // --------------------------------------------------------------------------
  // Backward compatibility
  // --------------------------------------------------------------------------

  describe("backward compatibility", () => {
    test("memories without agentId or agentScope are visible to everyone", async () => {
      // Legacy save (no agentId in options)
      const legacy = makeManager({
        eventStore,
        sessionId: "sess-1",
      });
      await legacy.save("old-memory", "legacy content");

      // Agent reader should see it
      const agentReader = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: createAgentId("agent-f"),
        agentRole: "coder",
      });
      await agentReader.hydrate();

      const memory = agentReader.get("old-memory");
      expect(memory).not.toBeNull();
      expect(memory!.value).toBe("legacy content");
    });

    test("list() filters by scope", async () => {
      const agentA = createAgentId("agent-a");
      const agentB = createAgentId("agent-b");

      const writerA = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentA,
        agentRole: "coder",
      });
      await writerA.save("pub-mem", "public data", { agentScope: "public" });
      await writerA.save("priv-mem", "private data", { agentScope: "private" });

      const readerB = makeManager({
        eventStore,
        sessionId: "sess-1",
        agentId: agentB,
        agentRole: "reviewer",
      });
      await readerB.hydrate();

      const visible = readerB.list();
      const keys = visible.map((m) => m.key);
      expect(keys).toContain("pub-mem");
      expect(keys).not.toContain("priv-mem");
    });
  });
});
