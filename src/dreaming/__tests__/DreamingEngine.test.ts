/**
 * Tests for DreamingEngine
 *
 * Covers:
 * - deduce() excludes derived_insight memories (circular reasoning prevention)
 * - cleanStaleInsights() skips when contradictionDetector is null
 * - dream() produces a valid DreamResult
 * - callClaude is mocked to avoid real CLI calls
 *
 * @module dreaming/__tests__/DreamingEngine.test
 */

import { describe, it, expect, mock } from "bun:test";
import { DreamingEngine } from "../DreamingEngine.js";
import type { DreamConfig, DreamResult } from "../DreamingEngine.js";
import type { Memory } from "../../types/index.js";
import type { MemoryManager } from "../../memory/MemoryManager.js";
import type { ContradictionDetector } from "../../graph/ContradictionDetector.js";
import type { UserProfileStore } from "../../profile/UserProfile.js";
import type { EventStore } from "../../storage/EventStore.js";

// ============================================================================
// Module-level mock for callClaude — must be at top level for Bun's process-global mocking
// ============================================================================

let _mockCallClaudeImpl: (prompt: string, opts: unknown) => Promise<string> = async () => {
  throw new Error("callClaude mock not configured — call setMockCallClaude() first");
};

mock.module("../../llm/ClaudeCli.js", () => ({
  callClaude: (prompt: string, opts: unknown) => _mockCallClaudeImpl(prompt, opts),
}));

function setMockCallClaude(returnValue: string): void {
  _mockCallClaudeImpl = async () => returnValue;
}

function setMockCallClaudeThrow(error: Error): void {
  _mockCallClaudeImpl = async () => { throw error; };
}

// ============================================================================
// Helpers
// ============================================================================

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    key: "test-key",
    value: "test value",
    sessionId: "session-001",
    category: "fact",
    priority: "normal",
    privacy: "session",
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

const DEFAULT_CONFIG: DreamConfig = {
  maxMemoriesPerCycle: 200,
  minMemoriesForDreaming: 5,
  deductionEnabled: true,
  generalizationEnabled: true,
};

function makeMemoryManager(memories: Memory[] = []): MemoryManager {
  return {
    recall: mock(async () =>
      memories.map((m) => ({ memory: m, score: 1.0 }))
    ),
    save: mock(async (_key: string, _value: string) => makeMemory({ key: _key, value: _value })),
    supersede: mock(async (_key: string, _value: string) => makeMemory({ key: _key, value: _value })),
    getSessionId: mock(() => "session-001"),
  } as unknown as MemoryManager;
}

function makeUserProfile(): UserProfileStore {
  return {
    updateProfile: mock(() => ({
      userId: "default",
      activeProjects: [],
      expertise: [],
      currentFocus: [],
      relevanceThreshold: 0.5,
      autoCheckpointInterval: 300000,
      updatedAt: new Date(),
      metadata: {},
    })),
    getProfile: mock(() => null),
  } as unknown as UserProfileStore;
}

function makeEventStore(): EventStore {
  return {
    createEvent: mock(async () => ({
      eventId: "evt-001",
      sessionId: "session-001",
      eventType: "INSIGHT_DERIVED",
      payload: {},
      metadata: {},
      timestamp: new Date(),
    })),
  } as unknown as EventStore;
}

function makeContradictionDetector(isContradiction = false): ContradictionDetector {
  return {
    detect: mock(async () => ({
      isContradiction,
      conflict: isContradiction ? "Values contradict" : "",
      confidence: isContradiction ? 0.9 : 0.1,
    })),
  } as unknown as ContradictionDetector;
}

// ============================================================================
// patchCallClaude — now delegates to module-level mock
// ============================================================================

function patchCallClaude(_engine: DreamingEngine, returnValue: string): void {
  setMockCallClaude(returnValue);
}

// ============================================================================
// Tests
// ============================================================================

describe("DreamingEngine", () => {
  describe("deduce()", () => {
    it("should return derived facts from callClaude response", async () => {
      const engine = new DreamingEngine(
        makeMemoryManager(),
        null,
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );
      patchCallClaude(engine, JSON.stringify(["User prefers TDD", "Project X appears complete"]));

      const sourceMemories = [
        makeMemory({ key: "pref-1", value: "User always corrects about testing" }),
        makeMemory({ key: "pref-2", value: "Project X not mentioned since March" }),
        makeMemory({ key: "pref-3", value: "User uses bun test exclusively" }),
        makeMemory({ key: "pref-4", value: "User dislikes jest" }),
        makeMemory({ key: "pref-5", value: "Project X shipped" }),
      ];

      const results = await engine.deduce(sourceMemories);

      expect(results).toHaveLength(2);
      expect(results[0]).toBe("User prefers TDD");
      expect(results[1]).toBe("Project X appears complete");
    });

    it("should return empty array when callClaude returns empty array", async () => {
      const engine = new DreamingEngine(
        makeMemoryManager(),
        null,
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );
      patchCallClaude(engine, JSON.stringify([]));

      const results = await engine.deduce([makeMemory()]);
      expect(results).toHaveLength(0);
    });

    it("should return empty array when memories list is empty", async () => {
      const engine = new DreamingEngine(
        makeMemoryManager(),
        null,
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );
      patchCallClaude(engine, JSON.stringify(["should not be called"]));

      const results = await engine.deduce([]);
      expect(results).toHaveLength(0);
    });

    it("should throw when callClaude throws (error propagates to dream() catch block)", async () => {
      setMockCallClaudeThrow(new Error("CLI unavailable"));
      const engine = new DreamingEngine(
        makeMemoryManager(),
        null,
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );

      await expect(engine.deduce([makeMemory()])).rejects.toThrow("CLI unavailable");
    });
  });

  describe("generalize()", () => {
    it("should return generalized traits from callClaude response", async () => {
      const engine = new DreamingEngine(
        makeMemoryManager(),
        null,
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );
      patchCallClaude(engine, JSON.stringify({
        traits: ["Prefers TypeScript", "Favors TDD"],
        expertise: ["TypeScript", "Bun"],
        projects: ["ping-mem"],
        workStyle: ["test-first"],
      }));

      const memories = Array.from({ length: 5 }, (_, i) =>
        makeMemory({ key: `mem-${i}`, value: `memory content ${i}` })
      );

      const results = await engine.generalize(memories);

      expect(results.length).toBeGreaterThan(0);
      expect(results).toContain("Prefers TypeScript");
      expect(results).toContain("Favors TDD");
    });

    it("should call userProfile.updateProfile when expertise is found", async () => {
      const userProfile = makeUserProfile();
      const engine = new DreamingEngine(
        makeMemoryManager(),
        null,
        userProfile,
        makeEventStore(),
        DEFAULT_CONFIG
      );
      patchCallClaude(engine, JSON.stringify({
        traits: [],
        expertise: ["TypeScript", "Node.js"],
        projects: ["ping-mem"],
        workStyle: [],
      }));

      const memories = Array.from({ length: 3 }, (_, i) =>
        makeMemory({ key: `m-${i}`, value: `content ${i}` })
      );
      await engine.generalize(memories);

      expect(userProfile.updateProfile).toHaveBeenCalledTimes(1);
    });

    it("should return empty array when memories list is empty", async () => {
      const engine = new DreamingEngine(
        makeMemoryManager(),
        null,
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );
      patchCallClaude(engine, JSON.stringify({ traits: [], expertise: [], projects: [], workStyle: [] }));

      const results = await engine.generalize([]);
      expect(results).toHaveLength(0);
    });
  });

  describe("cleanStaleInsights()", () => {
    it("should skip and return 0 when contradictionDetector is null", async () => {
      const memManager = makeMemoryManager();
      const engine = new DreamingEngine(
        memManager,
        null, // no ContradictionDetector
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );

      const insights = [
        makeMemory({ category: "derived_insight", key: "insight-1", value: "old insight" }),
        makeMemory({ category: "derived_insight", key: "insight-2", value: "another insight" }),
      ];

      const invalidated = await engine.cleanStaleInsights(insights);

      expect(invalidated).toBe(0);
      // supersede should NOT be called since we skipped
      expect(memManager.supersede).not.toHaveBeenCalled();
    });

    it("should return 0 when insights list is empty", async () => {
      const engine = new DreamingEngine(
        makeMemoryManager(),
        makeContradictionDetector(false),
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );

      const invalidated = await engine.cleanStaleInsights([]);
      expect(invalidated).toBe(0);
    });

    it("should invalidate stale insights when contradictionDetector finds contradictions", async () => {
      const memManager = makeMemoryManager([
        makeMemory({ category: "fact", key: "fact-1", value: "current fact" }),
        makeMemory({ category: "fact", key: "fact-2", value: "another fact" }),
      ]);
      const detector = makeContradictionDetector(true); // always contradicts
      const eventStore = makeEventStore();

      const engine = new DreamingEngine(
        memManager,
        detector,
        makeUserProfile(),
        eventStore,
        DEFAULT_CONFIG
      );

      const staleInsight = makeMemory({
        category: "derived_insight",
        key: "insight-stale",
        value: "outdated derived fact",
      });

      const invalidated = await engine.cleanStaleInsights([staleInsight]);

      expect(invalidated).toBe(1);
      expect(memManager.supersede).toHaveBeenCalledTimes(1);
      expect(eventStore.createEvent).toHaveBeenCalledWith(
        "session-001",
        "INSIGHT_INVALIDATED",
        expect.objectContaining({ key: "insight-stale" })
      );
    });

    it("should not invalidate when contradictionDetector returns no contradiction", async () => {
      const memManager = makeMemoryManager([
        makeMemory({ category: "fact", key: "fact-1", value: "current fact" }),
      ]);
      const detector = makeContradictionDetector(false); // no contradiction

      const engine = new DreamingEngine(
        memManager,
        detector,
        makeUserProfile(),
        makeEventStore(),
        DEFAULT_CONFIG
      );

      const insight = makeMemory({
        category: "derived_insight",
        key: "insight-valid",
        value: "still valid derived fact",
      });

      const invalidated = await engine.cleanStaleInsights([insight]);

      expect(invalidated).toBe(0);
      expect(memManager.supersede).not.toHaveBeenCalled();
    });
  });

  describe("dream()", () => {
    it("should return a DreamResult with deductions and generalizations", async () => {
      // Enough source memories to pass minMemoriesForDreaming threshold
      const sourceMemories = Array.from({ length: 10 }, (_, i) =>
        makeMemory({ key: `src-${i}`, value: `source memory ${i}`, category: "fact" })
      );
      const memManager = makeMemoryManager(sourceMemories);

      const engine = new DreamingEngine(
        memManager,
        null,
        makeUserProfile(),
        makeEventStore(),
        { ...DEFAULT_CONFIG, minMemoriesForDreaming: 5 }
      );

      patchCallClaude(engine, JSON.stringify(["Derived fact 1"]));

      const result: DreamResult = await engine.dream("session-001");

      expect(typeof result.deductions).toBe("number");
      expect(typeof result.generalizations).toBe("number");
      expect(typeof result.contradictions).toBe("number");
      expect(typeof result.profileUpdates).toBe("number");
      expect(typeof result.durationMs).toBe("number");
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it("should skip dreaming when not enough source memories", async () => {
      // Fewer memories than minMemoriesForDreaming (5), all are derived_insight so sourceMemories = 0
      const derivedOnly = [
        makeMemory({ category: "derived_insight", key: "di-1", value: "derived" }),
        makeMemory({ category: "derived_insight", key: "di-2", value: "derived2" }),
      ];
      const memManager = makeMemoryManager(derivedOnly);

      const engine = new DreamingEngine(
        memManager,
        null,
        makeUserProfile(),
        makeEventStore(),
        { ...DEFAULT_CONFIG, minMemoriesForDreaming: 5 }
      );

      const result = await engine.dream("session-001");

      expect(result.deductions).toBe(0);
      expect(result.generalizations).toBe(0);
      // save should not have been called for new insights
      expect(memManager.save).not.toHaveBeenCalled();
    });

    it("should exclude derived_insight memories from deduction/generalization input", async () => {
      // Mix: 8 source facts + 2 derived_insights
      const sourceMemories = Array.from({ length: 8 }, (_, i) =>
        makeMemory({ key: `fact-${i}`, value: `fact ${i}`, category: "fact" })
      );
      const derivedInsights = [
        makeMemory({ key: "di-1", value: "old derived", category: "derived_insight" }),
        makeMemory({ key: "di-2", value: "another derived", category: "derived_insight" }),
      ];
      const allMemories = [...sourceMemories, ...derivedInsights];
      const memManager = makeMemoryManager(allMemories);

      let deduceCallArg: Memory[] = [];
      const engine = new DreamingEngine(
        memManager,
        null,
        makeUserProfile(),
        makeEventStore(),
        { ...DEFAULT_CONFIG, minMemoriesForDreaming: 5, generalizationEnabled: false }
      );

      // Intercept deduce to capture the memories passed to it
      const originalDeduce = engine.deduce.bind(engine);
      engine.deduce = mock(async (memories: Memory[]) => {
        deduceCallArg = memories;
        return originalDeduce(memories);
      });
      patchCallClaude(engine, JSON.stringify([]));

      await engine.dream("session-001");

      // Verify: derived_insight memories were filtered OUT before passing to deduce
      const hasAnyDerived = deduceCallArg.some((m) => m.category === "derived_insight");
      expect(hasAnyDerived).toBe(false);
      expect(deduceCallArg.length).toBe(8); // only the source facts
    });

    it("should have durationMs in DreamResult", async () => {
      const sourceMemories = Array.from({ length: 6 }, (_, i) =>
        makeMemory({ key: `m-${i}`, value: `value ${i}`, category: "observation" })
      );
      const memManager = makeMemoryManager(sourceMemories);

      const engine = new DreamingEngine(
        memManager,
        null,
        makeUserProfile(),
        makeEventStore(),
        { ...DEFAULT_CONFIG, minMemoriesForDreaming: 5 }
      );
      patchCallClaude(engine, JSON.stringify([]));

      const result = await engine.dream("session-001");
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
