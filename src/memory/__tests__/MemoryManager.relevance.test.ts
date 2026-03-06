import { describe, it, expect, mock } from "bun:test";
import { MemoryManager } from "../MemoryManager.js";

describe("MemoryManager - RelevanceEngine Integration", () => {
  it("should call ensureTracking on save when relevanceEngine is provided", async () => {
    const mockRelevanceEngine = {
      ensureTracking: mock(() => {}),
      trackAccess: mock(() => {}),
    };

    const manager = new MemoryManager({
      sessionId: "session-1",
      relevanceEngine: mockRelevanceEngine as any,
    });

    await manager.save("test-key", "test-value", { category: "decision" });

    expect(mockRelevanceEngine.ensureTracking).toHaveBeenCalledTimes(1);
  });

  it("should call trackAccess on get when relevanceEngine is provided", async () => {
    const mockRelevanceEngine = {
      ensureTracking: mock(() => {}),
      trackAccess: mock(() => {}),
    };

    const manager = new MemoryManager({
      sessionId: "session-1",
      relevanceEngine: mockRelevanceEngine as any,
    });

    await manager.save("test-key", "test-value");
    manager.get("test-key");

    expect(mockRelevanceEngine.trackAccess).toHaveBeenCalledTimes(1);
  });

  it("should work without relevanceEngine (backwards compatible)", async () => {
    const manager = new MemoryManager({ sessionId: "session-1" });

    await manager.save("key1", "value1");
    const memory = manager.get("key1");

    expect(memory).toBeDefined();
    expect(memory?.value).toBe("value1");
  });
});
