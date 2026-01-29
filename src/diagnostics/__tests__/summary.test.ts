import { describe, test, expect } from "bun:test";
import { SummaryCache } from "../SummaryCache.js";
import type { DiagnosticSummary } from "../SummaryGenerator.js";
import { Database } from "bun:sqlite";

describe("SummaryCache", () => {
  test("Store and retrieve summary", () => {
    const db = new Database(":memory:");
    const cache = new SummaryCache({ db });

    const summary: DiagnosticSummary = {
      summaryId: "summary-123",
      analysisId: "analysis-123",
      summaryText: "3 type errors in auth.ts, 2 lint warnings in db.ts",
      llmModel: "gpt-4o-mini",
      llmProvider: "openai",
      generatedAt: new Date().toISOString(),
      promptTokens: 150,
      completionTokens: 50,
      costUsd: 0.0001,
      sourceFindingIds: ["finding-1", "finding-2", "finding-3"],
      isFromCache: false,
    };

    cache.set("analysis-123", summary);

    const retrieved = cache.get("analysis-123");
    expect(retrieved).toBeTruthy();
    expect(retrieved?.analysisId).toBe("analysis-123");
    expect(retrieved?.summaryText).toBe(summary.summaryText);
    expect(retrieved?.isFromCache).toBe(true);
    expect(retrieved?.sourceFindingIds).toEqual(summary.sourceFindingIds);

    db.close();
  });

  test("Return null for non-existent summary", () => {
    const db = new Database(":memory:");
    const cache = new SummaryCache({ db });

    const retrieved = cache.get("non-existent");
    expect(retrieved).toBeNull();

    db.close();
  });

  test("Cache is content-addressable", () => {
    const db = new Database(":memory:");
    const cache = new SummaryCache({ db });

    const summary1: DiagnosticSummary = {
      summaryId: "summary-1",
      analysisId: "analysis-123",
      summaryText: "First summary",
      llmModel: "gpt-4o-mini",
      llmProvider: "openai",
      generatedAt: new Date().toISOString(),
      promptTokens: 100,
      completionTokens: 30,
      sourceFindingIds: ["f1"],
      isFromCache: false,
    };

    const summary2: DiagnosticSummary = {
      summaryId: "summary-2",
      analysisId: "analysis-123",
      summaryText: "Second summary (updated)",
      llmModel: "gpt-4o-mini",
      llmProvider: "openai",
      generatedAt: new Date().toISOString(),
      promptTokens: 120,
      completionTokens: 35,
      sourceFindingIds: ["f1", "f2"],
      isFromCache: false,
    };

    cache.set("analysis-123", summary1);
    const retrieved1 = cache.get("analysis-123");
    expect(retrieved1?.summaryText).toBe("First summary");

    // Update with new summary (same analysisId)
    cache.set("analysis-123", summary2);
    const retrieved2 = cache.get("analysis-123");
    expect(retrieved2?.summaryText).toBe("Second summary (updated)");
    expect(retrieved2?.summaryId).toBe("summary-2");

    db.close();
  });
});
