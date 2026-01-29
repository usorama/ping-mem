import { describe, test, expect } from "bun:test";
import {
  parseSarif,
  normalizeFindings,
  computeFindingsDigest,
  computeAnalysisId,
  DiagnosticsStore,
} from "../index.js";
import type { FindingInput, NormalizedFinding } from "../types.js";

/**
 * Generate synthetic SARIF for benchmarking
 * Deterministic: same seed -> same SARIF
 */
function generateSyntheticSarif(findingCount: number, seed: number): Record<string, unknown> {
  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < findingCount; i++) {
    // Use seed for deterministic generation
    const fileNum = ((seed + i) % 50) + 1;
    const line = ((seed + i * 7) % 1000) + 1;
    const col = ((seed + i * 3) % 80) + 1;
    const ruleNum = ((seed + i * 11) % 100) + 1000;

    results.push({
      ruleId: `TS${ruleNum}`,
      level: i % 3 === 0 ? "error" : i % 3 === 1 ? "warning" : "note",
      message: {
        text: `Synthetic diagnostic message ${i} for testing performance`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: `src/file${fileNum}.ts`,
            },
            region: {
              startLine: line,
              startColumn: col,
              endLine: line,
              endColumn: col + 5,
            },
          },
        },
      ],
    });
  }

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "tsc",
            version: "5.3.3",
          },
        },
        results,
      },
    ],
  };
}

/**
 * Generate synthetic normalized findings
 */
function generateSyntheticFindings(count: number, seed: number = 42): FindingInput[] {
  const findings: FindingInput[] = [];

  for (let i = 0; i < count; i++) {
    const fileNum = ((seed + i) % 50) + 1;
    const line = ((seed + i * 7) % 1000) + 1;
    const col = ((seed + i * 3) % 80) + 1;
    const ruleNum = ((seed + i * 11) % 100) + 1000;

    findings.push({
      ruleId: `TS${ruleNum}`,
      severity: i % 3 === 0 ? "error" : i % 3 === 1 ? "warning" : "note",
      message: `Synthetic diagnostic message ${i} for testing performance`,
      filePath: `src/file${fileNum}.ts`,
      startLine: line,
      startColumn: col,
      endLine: line,
      endColumn: col + 5,
    });
  }

  return findings;
}

describe("Performance Benchmarks", () => {
  const sizes = [100, 1000, 10000];

  for (const size of sizes) {
    test(`SARIF parse ${size} findings`, () => {
      const sarif = generateSyntheticSarif(size, 42);
      const start = performance.now();
      const result = parseSarif(sarif);
      const duration = performance.now() - start;

      expect(result.findings).toHaveLength(size);
      
      // Performance budget: 50 findings/ms (20ms for 1000 findings)
      const budget = size < 1000 ? 50 : size / 20;
      expect(duration).toBeLessThan(budget);
      
      console.log(`[PERF] SARIF parse ${size} findings: ${duration.toFixed(2)}ms`);
    });

    test(`Normalize ${size} findings`, () => {
      const findings = generateSyntheticFindings(size);
      const start = performance.now();
      const normalized = normalizeFindings(findings, "test-analysis-id");
      const duration = performance.now() - start;

      expect(normalized).toHaveLength(size);
      
      // Performance budget: 100 findings/ms (10ms for 1000 findings)
      const budget = size < 1000 ? 20 : size / 100;
      expect(duration).toBeLessThan(budget);
      
      console.log(`[PERF] Normalize ${size} findings: ${duration.toFixed(2)}ms`);
    });

    test(`Compute analysisId with ${size} findings`, () => {
      const findings = generateSyntheticFindings(size);
      const normalized = normalizeFindings(findings, "temp-id");
      
      const start = performance.now();
      const digest = computeFindingsDigest(normalized);
      const analysisId = computeAnalysisId({
        projectId: "test-project",
        treeHash: "abc123",
        toolName: "tsc",
        toolVersion: "5.3.3",
        configHash: "config-hash",
        findingsDigest: digest,
      });
      const duration = performance.now() - start;

      expect(analysisId).toBeTruthy();
      
      // Performance budget: < 50ms for all sizes
      expect(duration).toBeLessThan(50);
      
      console.log(`[PERF] Compute analysisId (${size} findings): ${duration.toFixed(2)}ms`);
    });

    test(`Store ${size} findings to SQLite`, () => {
      const store = new DiagnosticsStore({ dbPath: ":memory:" });
      const findings = generateSyntheticFindings(size);
      const normalized = normalizeFindings(findings, "test-analysis-id");
      const digest = computeFindingsDigest(normalized);

      const start = performance.now();
      store.saveRun(
        {
          runId: store.createRunId(),
          analysisId: "test-analysis-id",
          projectId: "test-project",
          treeHash: "abc123",
          tool: { name: "tsc", version: "5.3.3" },
          configHash: "config-hash",
          status: "failed",
          createdAt: new Date().toISOString(),
          findingsDigest: digest,
          metadata: {},
        },
        normalized
      );
      const duration = performance.now() - start;

      // Verify stored
      const retrieved = store.listFindings("test-analysis-id");
      expect(retrieved).toHaveLength(size);

      // Performance budget: 5 findings/ms (200ms for 1000 findings)
      const budget = size < 1000 ? 100 : size / 5;
      expect(duration).toBeLessThan(budget);
      
      console.log(`[PERF] Store ${size} findings: ${duration.toFixed(2)}ms`);

      store.close();
    });

    test(`Diff ${size} findings`, () => {
      const store = new DiagnosticsStore({ dbPath: ":memory:" });
      
      // Create two analyses with slight differences
      const findingsA = generateSyntheticFindings(size, 42);
      const findingsB = generateSyntheticFindings(size, 43); // Different seed
      
      const normalizedA = normalizeFindings(findingsA, "analysis-a");
      const normalizedB = normalizeFindings(findingsB, "analysis-b");
      const digestA = computeFindingsDigest(normalizedA);
      const digestB = computeFindingsDigest(normalizedB);

      store.saveRun(
        {
          runId: store.createRunId(),
          analysisId: "analysis-a",
          projectId: "test-project",
          treeHash: "abc123",
          tool: { name: "tsc", version: "5.3.3" },
          configHash: "config-hash",
          status: "failed",
          createdAt: new Date().toISOString(),
          findingsDigest: digestA,
          metadata: {},
        },
        normalizedA
      );

      store.saveRun(
        {
          runId: store.createRunId(),
          analysisId: "analysis-b",
          projectId: "test-project",
          treeHash: "def456",
          tool: { name: "tsc", version: "5.3.3" },
          configHash: "config-hash",
          status: "failed",
          createdAt: new Date().toISOString(),
          findingsDigest: digestB,
          metadata: {},
        },
        normalizedB
      );

      const start = performance.now();
      const diff = store.diffAnalyses("analysis-a", "analysis-b");
      const duration = performance.now() - start;

      expect(diff.introduced).toBeDefined();
      expect(diff.resolved).toBeDefined();
      expect(diff.unchanged).toBeDefined();

      // Performance budget: < 500ms for all sizes
      expect(duration).toBeLessThan(500);
      
      console.log(`[PERF] Diff ${size} findings: ${duration.toFixed(2)}ms`);

      store.close();
    });
  }

  test("End-to-end pipeline performance (1000 findings)", () => {
    const sarif = generateSyntheticSarif(1000, 42);
    
    const start = performance.now();
    
    // Parse
    const parsed = parseSarif(sarif);
    
    // Normalize
    const normalized = normalizeFindings(parsed.findings, "temp");
    
    // Compute digest and analysis ID
    const digest = computeFindingsDigest(normalized);
    const analysisId = computeAnalysisId({
      projectId: "test",
      treeHash: "abc",
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config",
      findingsDigest: digest,
    });
    
    const finalFindings = normalizeFindings(parsed.findings, analysisId);
    
    // Store
    const store = new DiagnosticsStore({ dbPath: ":memory:" });
    store.saveRun(
      {
        runId: store.createRunId(),
        analysisId,
        projectId: "test",
        treeHash: "abc",
        tool: { name: "tsc", version: "5.3.3" },
        configHash: "config",
        status: "failed",
        createdAt: new Date().toISOString(),
        findingsDigest: digest,
        metadata: {},
      },
      finalFindings
    );
    
    const duration = performance.now() - start;
    
    // Budget for full pipeline: < 500ms for 1000 findings
    expect(duration).toBeLessThan(500);
    
    console.log(`[PERF] End-to-end pipeline (1000 findings): ${duration.toFixed(2)}ms`);
    
    store.close();
  });
});
