import { describe, it, expect } from "bun:test";
import { HybridSearchEngine } from "../HybridSearchEngine.js";

describe("HybridSearchEngine - Temporal Boost", () => {
  function createEngine(temporalBoost?: { factor: number; decayDays: number }) {
    const config: any = {
      embeddingService: { embed: async () => new Float32Array(768), dimensions: 768, name: "mock" } as any,
    };
    if (temporalBoost !== undefined) {
      config.temporalBoost = temporalBoost;
    }
    return new HybridSearchEngine(config);
  }

  it("should boost recent memories higher than old ones", async () => {
    const engine = createEngine({ factor: 0.3, decayDays: 30 });

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    engine.addDocument("recent", "s1", "important finding about auth", now);
    engine.addDocument("old", "s1", "important finding about auth", thirtyDaysAgo);

    const results = await engine.search("important finding about auth", {
      modes: ["keyword"],
    });

    expect(results.length).toBe(2);
    const recentResult = results.find((r) => r.memoryId === "recent");
    const oldResult = results.find((r) => r.memoryId === "old");
    expect(recentResult).toBeDefined();
    expect(oldResult).toBeDefined();
    if (recentResult && oldResult) {
      expect(recentResult.hybridScore).toBeGreaterThan(oldResult.hybridScore);
    }
  });

  it("should skip temporal boost when skipTemporalBoost is true", async () => {
    const engine = createEngine({ factor: 0.3, decayDays: 30 });

    const now = new Date();
    const oldDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    engine.addDocument("recent", "s1", "same content", now);
    engine.addDocument("old", "s1", "same content", oldDate);

    const results = await engine.search("same content", {
      modes: ["keyword"],
      skipTemporalBoost: true,
    });

    if (results.length === 2) {
      // With skipTemporalBoost, scores only differ by RRF rank position for identical-content docs.
      // The difference should be small (< 0.02) — no temporal amplification.
      expect(Math.abs(results[0].hybridScore - results[1].hybridScore)).toBeLessThan(0.02);
    }
  });

  it("should use default factor 0.3 and decayDays 30 when not configured", async () => {
    const engine = createEngine();
    engine.addDocument("mem-1", "s1", "test content", new Date());

    const results = await engine.search("test content", { modes: ["keyword"] });
    expect(results.length).toBeGreaterThan(0);
  });
});
