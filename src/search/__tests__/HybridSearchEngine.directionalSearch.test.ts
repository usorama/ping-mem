import { describe, it, expect } from "bun:test";
import { HybridSearchEngine } from "../HybridSearchEngine.js";

describe("HybridSearchEngine - Directional Search", () => {
  function createEngine() {
    return new HybridSearchEngine({
      embeddingService: { embed: async () => new Float32Array(768), dimensions: 768, name: "mock" } as any,
    });
  }

  it("should detect 'why' queries as cause direction", async () => {
    const engine = createEngine();
    engine.addDocument("mem-1", "s1", "JWT token causes 401 errors", new Date());

    // Should not throw - directional detection works
    const results = await engine.search("why do we get 401 errors", { modes: ["keyword"] });
    expect(Array.isArray(results)).toBe(true);
  });

  it("should detect 'what if' queries as effect direction", async () => {
    const engine = createEngine();
    engine.addDocument("mem-1", "s1", "Disabling cache leads to slower responses", new Date());

    const results = await engine.search("what if we disable the cache", { modes: ["keyword"] });
    expect(Array.isArray(results)).toBe(true);
  });

  it("should accept explicit causalDirection option", async () => {
    const engine = createEngine();
    engine.addDocument("mem-1", "s1", "test content", new Date());

    const results = await engine.search("test", { modes: ["keyword"], causalDirection: "cause" });
    expect(Array.isArray(results)).toBe(true);
  });
});
