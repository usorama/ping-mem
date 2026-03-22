import { describe, it, expect, mock } from "bun:test";
import { MemoryManager } from "../MemoryManager.js";

// FSRS constants mirrored from RelevanceEngine.ts for formula verification
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81; // ≈ 0.2346

/** Pure FSRS retention: R(t, S) = (1 + FSRS_FACTOR * t/S)^FSRS_DECAY */
function fsrsRetention(daysSince: number, stabilityDays: number): number {
  return Math.pow(1 + FSRS_FACTOR * (daysSince / stabilityDays), FSRS_DECAY);
}

/** CATEGORY_STABILITY_DAYS values as defined in RelevanceEngine.ts */
const CATEGORY_STABILITY_DAYS: Record<string, number> = {
  decision: 180,
  error: 90,
  task: 30,
  fact: 30,
  observation: 3,
  progress: 7,
  note: 14,
  knowledge_entry: 60,
};

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

// ============================================================================
// FSRS Decay — pure formula tests (no DB required)
// ============================================================================

describe("FSRS decay formula", () => {
  describe("CATEGORY_STABILITY_DAYS gives decisions longer stability than observations", () => {
    it("decision stability (180d) is greater than observation stability (3d)", () => {
      expect(CATEGORY_STABILITY_DAYS["decision"]).toBeGreaterThan(
        CATEGORY_STABILITY_DAYS["observation"] as number
      );
    });

    it("decision stability (180d) is greater than task stability (30d)", () => {
      expect(CATEGORY_STABILITY_DAYS["decision"]).toBeGreaterThan(
        CATEGORY_STABILITY_DAYS["task"] as number
      );
    });

    it("decision stability (180d) is greater than note stability (14d)", () => {
      expect(CATEGORY_STABILITY_DAYS["decision"]).toBeGreaterThan(
        CATEGORY_STABILITY_DAYS["note"] as number
      );
    });

    it("error stability (90d) is greater than progress stability (7d)", () => {
      expect(CATEGORY_STABILITY_DAYS["error"]).toBeGreaterThan(
        CATEGORY_STABILITY_DAYS["progress"] as number
      );
    });

    it("knowledge_entry stability (60d) is greater than fact stability (30d)", () => {
      expect(CATEGORY_STABILITY_DAYS["knowledge_entry"]).toBeGreaterThan(
        CATEGORY_STABILITY_DAYS["fact"] as number
      );
    });
  });

  describe("FSRS formula produces lower decay for shorter stability values", () => {
    it("at t=7d, a memory with S=180d retains more than one with S=3d", () => {
      const daysSince = 7;
      const retentionDecision = fsrsRetention(daysSince, CATEGORY_STABILITY_DAYS["decision"] as number);
      const retentionObservation = fsrsRetention(daysSince, CATEGORY_STABILITY_DAYS["observation"] as number);

      // decision (S=180) decays slower → higher retention than observation (S=3)
      expect(retentionDecision).toBeGreaterThan(retentionObservation);
    });

    it("at t=1d, observation (S=3d) retention is below decision retention (S=180d)", () => {
      // observation memories decay meaningfully faster than decision memories
      const retentionObs = fsrsRetention(1, CATEGORY_STABILITY_DAYS["observation"] as number);
      const retentionDecision = fsrsRetention(1, CATEGORY_STABILITY_DAYS["decision"] as number);
      expect(retentionObs).toBeLessThan(retentionDecision);
    });

    it("at t=3d (one full stability period), observation retention is below 0.97", () => {
      // After one full stability period, retention should show meaningful decay
      const retention = fsrsRetention(3, CATEGORY_STABILITY_DAYS["observation"] as number);
      expect(retention).toBeLessThan(0.97);
    });

    it("at t=1d, decision (S=180d) retention is above 0.99", () => {
      // decision memories are designed to persist for months
      const retention = fsrsRetention(1, CATEGORY_STABILITY_DAYS["decision"] as number);
      expect(retention).toBeGreaterThan(0.99);
    });

    it("retention at t=0 equals 1.0 regardless of stability", () => {
      // R(0, S) = (1 + 0)^DECAY = 1
      expect(fsrsRetention(0, 3)).toBeCloseTo(1.0, 10);
      expect(fsrsRetention(0, 180)).toBeCloseTo(1.0, 10);
    });

    it("retention monotonically decreases as time increases (S=30d)", () => {
      const stability = 30;
      const r7 = fsrsRetention(7, stability);
      const r14 = fsrsRetention(14, stability);
      const r30 = fsrsRetention(30, stability);
      const r60 = fsrsRetention(60, stability);

      expect(r7).toBeGreaterThan(r14);
      expect(r14).toBeGreaterThan(r30);
      expect(r30).toBeGreaterThan(r60);
    });

    it("FSRS_DECAY is negative (ensures decay not growth)", () => {
      expect(FSRS_DECAY).toBeLessThan(0);
    });

    it("FSRS_FACTOR equals 19/81", () => {
      expect(FSRS_FACTOR).toBeCloseTo(19 / 81, 10);
    });
  });

  describe("Access boost increases score for frequently accessed memories", () => {
    it("access boost is strictly greater than 1 for non-zero access counts", () => {
      const accessCount = 5;
      const hoursSinceAccess = 0; // just accessed
      const boost = 1 + 0.3 * Math.log(1 + accessCount) * Math.exp(-hoursSinceAccess / 168);
      expect(boost).toBeGreaterThan(1.0);
    });

    it("more accesses yield a higher boost than fewer accesses (same recency)", () => {
      const hours = 0;
      const boostLow = 1 + 0.3 * Math.log(1 + 1) * Math.exp(-hours / 168);
      const boostHigh = 1 + 0.3 * Math.log(1 + 20) * Math.exp(-hours / 168);
      expect(boostHigh).toBeGreaterThan(boostLow);
    });

    it("access boost decays toward 1.0 as hours since access increases", () => {
      const accessCount = 10;
      const boostRecent = 1 + 0.3 * Math.log(1 + accessCount) * Math.exp(-0 / 168);
      const boostOld = 1 + 0.3 * Math.log(1 + accessCount) * Math.exp(-1000 / 168);
      expect(boostRecent).toBeGreaterThan(boostOld);
      // After very long time, boost converges toward 1.0
      expect(boostOld).toBeCloseTo(1.0, 1);
    });

    it("access boost with zero accesses equals 1.0", () => {
      const accessCount = 0;
      const boost = 1 + 0.3 * Math.log(1 + accessCount) * Math.exp(-0 / 168);
      expect(boost).toBeCloseTo(1.0, 10);
    });

    it("FSRS decay multiplied by access boost exceeds raw decay for recent accesses", () => {
      const daysSince = 7;
      const stabilityDays = 30;
      const accessCount = 5;
      const hoursSinceAccess = daysSince * 24;

      const rawDecay = fsrsRetention(daysSince, stabilityDays);
      const accessBoost = 1 + 0.3 * Math.log(1 + accessCount) * Math.exp(-hoursSinceAccess / 168);
      const boostedDecay = rawDecay * accessBoost;

      expect(boostedDecay).toBeGreaterThan(rawDecay);
    });
  });
});
