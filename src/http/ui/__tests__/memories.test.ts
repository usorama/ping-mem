import { describe, test, expect, beforeEach } from "bun:test";
import { createInMemoryEventStore, type EventStore } from "../../../storage/EventStore.js";
import { MemoryManager } from "../../../memory/MemoryManager.js";
import { renderMemoryTable } from "../partials/memories.js";
import type { SessionId } from "../../../types/index.js";

describe("Memory Explorer UI", () => {
  let eventStore: EventStore;
  let memoryManager: MemoryManager;
  const sessionId = "test-session-1" as SessionId;

  beforeEach(async () => {
    eventStore = createInMemoryEventStore();
    memoryManager = new MemoryManager({
      sessionId,
      eventStore,
    });
  });

  describe("renderMemoryTable", () => {
    test("shows empty state when no memories", () => {
      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "",
        priority: "",
        limit: 25,
        offset: 0,
      });
      expect(html).toContain("No memories found");
    });

    test("renders memory rows after saving", async () => {
      await memoryManager.save("auth-decision", "Use JWT with RS256", {
        category: "decision",
        priority: "high",
      });

      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "",
        priority: "",
        limit: 25,
        offset: 0,
      });

      expect(html).toContain("auth-decision");
      expect(html).toContain("Use JWT with RS256");
      expect(html).toContain("decision");
      expect(html).toContain("high");
    });

    test("filters by query text", async () => {
      await memoryManager.save("auth-decision", "Use JWT", { category: "decision" });
      await memoryManager.save("db-choice", "PostgreSQL", { category: "decision" });

      const html = renderMemoryTable(eventStore, {
        query: "JWT",
        category: "",
        priority: "",
        limit: 25,
        offset: 0,
      });

      expect(html).toContain("auth-decision");
      expect(html).not.toContain("db-choice");
    });

    test("filters by category", async () => {
      await memoryManager.save("auth-note", "Remember to rotate keys", { category: "note" });
      await memoryManager.save("auth-decision", "Use JWT", { category: "decision" });

      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "decision",
        priority: "",
        limit: 25,
        offset: 0,
      });

      expect(html).toContain("auth-decision");
      expect(html).not.toContain("auth-note");
    });

    test("filters by priority", async () => {
      await memoryManager.save("high-pri", "Critical item", { priority: "high" });
      await memoryManager.save("low-pri", "Minor item", { priority: "low" });

      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "",
        priority: "high",
        limit: 25,
        offset: 0,
      });

      expect(html).toContain("high-pri");
      expect(html).not.toContain("low-pri");
    });

    test("respects pagination", async () => {
      // Create 5 memories
      for (let i = 0; i < 5; i++) {
        await memoryManager.save(`key-${i}`, `value-${i}`, { category: "note" });
      }

      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "",
        priority: "",
        limit: 2,
        offset: 0,
      });

      expect(html).toContain("1-2 of 5");
      expect(html).toContain("Next");
    });

    test("renders HTMX attributes for clickable rows", async () => {
      await memoryManager.save("test-key", "test-value", { category: "note" });

      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "",
        priority: "",
        limit: 25,
        offset: 0,
      });

      expect(html).toContain("hx-get");
      expect(html).toContain("/ui/partials/memory/");
      expect(html).toContain("hx-target");
      expect(html).toContain("clickable");
    });

    test("excludes deleted memories", async () => {
      await memoryManager.save("to-delete", "will be deleted", { category: "note" });
      await memoryManager.delete("to-delete");

      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "",
        priority: "",
        limit: 25,
        offset: 0,
      });

      expect(html).not.toContain("to-delete");
      expect(html).toContain("No memories found");
    });

    test("shows most recent version of updated memory", async () => {
      await memoryManager.save("updating-key", "old value", { category: "note" });
      await memoryManager.update("updating-key", { value: "new value" });

      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "",
        priority: "",
        limit: 25,
        offset: 0,
      });

      // Should show the key (from the most recent MEMORY_SAVED event)
      expect(html).toContain("updating-key");
    });
  });

  describe("cross-session memory browsing", () => {
    test("shows memories from multiple sessions", async () => {
      const session2Id = "test-session-2" as SessionId;
      const mm2 = new MemoryManager({ sessionId: session2Id, eventStore });

      await memoryManager.save("session1-mem", "from session 1", { category: "note" });
      await mm2.save("session2-mem", "from session 2", { category: "decision" });

      const html = renderMemoryTable(eventStore, {
        query: "",
        category: "",
        priority: "",
        limit: 25,
        offset: 0,
      });

      expect(html).toContain("session1-mem");
      expect(html).toContain("session2-mem");
    });
  });
});
