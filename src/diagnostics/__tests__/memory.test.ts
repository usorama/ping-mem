import { describe, test, expect } from "bun:test";
import { normalizeFindings } from "../index.js";
import type { FindingInput } from "../types.js";

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
      message: `Synthetic diagnostic message ${i} for testing memory usage`,
      filePath: `src/file${fileNum}.ts`,
      startLine: line,
      startColumn: col,
      endLine: line,
      endColumn: col + 5,
    });
  }

  return findings;
}

describe("Memory Usage Benchmarks", () => {
  test("10k findings memory footprint", () => {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    const before = process.memoryUsage().heapUsed;
    const findings = generateSyntheticFindings(10000);
    const normalized = normalizeFindings(findings, "test-analysis-id");
    const after = process.memoryUsage().heapUsed;

    const deltaMB = (after - before) / 1024 / 1024;

    expect(normalized).toHaveLength(10000);
    
    // Memory budget: < 50MB for 10k findings
    expect(deltaMB).toBeLessThan(50);

    console.log(`[MEMORY] 10k findings: ${deltaMB.toFixed(2)}MB`);
  });

  test("100k findings memory footprint", () => {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    const before = process.memoryUsage().heapUsed;
    const findings = generateSyntheticFindings(100000);
    const normalized = normalizeFindings(findings, "test-analysis-id");
    const after = process.memoryUsage().heapUsed;

    const deltaMB = (after - before) / 1024 / 1024;

    expect(normalized).toHaveLength(100000);
    
    // Memory budget: < 500MB for 100k findings
    expect(deltaMB).toBeLessThan(500);

    console.log(`[MEMORY] 100k findings: ${deltaMB.toFixed(2)}MB`);
  });

  test("Memory is released after processing", () => {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    const before = process.memoryUsage().heapUsed;

    {
      const findings = generateSyntheticFindings(10000);
      const normalized = normalizeFindings(findings, "test-analysis-id");
      expect(normalized).toHaveLength(10000);
    }

    // Force garbage collection
    if (global.gc) {
      global.gc();
    }

    const after = process.memoryUsage().heapUsed;
    const deltaMB = (after - before) / 1024 / 1024;

    // After GC, memory should be mostly released (< 10MB delta)
    expect(deltaMB).toBeLessThan(10);

    console.log(`[MEMORY] After GC: ${deltaMB.toFixed(2)}MB retained`);
  });
});
