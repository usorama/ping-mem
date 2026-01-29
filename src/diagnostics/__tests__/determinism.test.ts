import { describe, test, expect } from "bun:test";
import {
  parseSarif,
  normalizeFindings,
  computeFindingsDigest,
  computeAnalysisId,
} from "../index.js";
import type { FindingInput } from "../types.js";

describe("Diagnostics Determinism", () => {
  const sampleSarif = {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "tsc",
            version: "5.3.3",
          },
        },
        results: [
          {
            ruleId: "TS2304",
            level: "error",
            message: {
              text: "Cannot find name 'foo'.",
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: "src/index.ts",
                  },
                  region: {
                    startLine: 10,
                    startColumn: 5,
                    endLine: 10,
                    endColumn: 8,
                  },
                },
              },
            ],
          },
          {
            ruleId: "TS2304",
            level: "error",
            message: {
              text: "Cannot find name 'bar'.",
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: "src/utils.ts",
                  },
                  region: {
                    startLine: 5,
                    startColumn: 1,
                    endLine: 5,
                    endColumn: 4,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  test("SARIF parsing is deterministic", () => {
    const result1 = parseSarif(sampleSarif);
    const result2 = parseSarif(JSON.parse(JSON.stringify(sampleSarif))); // Deep clone

    expect(result1.toolName).toBe("tsc");
    expect(result1.toolVersion).toBe("5.3.3");
    expect(result1.findings).toHaveLength(2);
    expect(result2.findings).toHaveLength(2);

    // Findings should be identical
    expect(result1.findings[0]).toEqual(result2.findings[0]);
    expect(result1.findings[1]).toEqual(result2.findings[1]);
  });

  test("Normalized findings are deterministic and sorted", () => {
    const findings: FindingInput[] = [
      {
        ruleId: "TS2304",
        severity: "error",
        message: "Cannot find name 'bar'.",
        filePath: "src/utils.ts",
        startLine: 5,
        startColumn: 1,
        endLine: 5,
        endColumn: 4,
      },
      {
        ruleId: "TS2304",
        severity: "error",
        message: "Cannot find name 'foo'.",
        filePath: "src/index.ts",
        startLine: 10,
        startColumn: 5,
        endLine: 10,
        endColumn: 8,
      },
    ];

    const analysisId = "test-analysis-id";
    const normalized1 = normalizeFindings(findings, analysisId);
    const normalized2 = normalizeFindings([...findings], analysisId); // Copy array
    const normalized3 = normalizeFindings([findings[1], findings[0]], analysisId); // Reverse order

    // All normalizations should produce identical results (same order)
    expect(normalized1).toHaveLength(2);
    expect(normalized2).toHaveLength(2);
    expect(normalized3).toHaveLength(2);

    // Findings should be sorted by file path, then line, then column
    expect(normalized1[0].filePath).toBe("src/index.ts");
    expect(normalized1[1].filePath).toBe("src/utils.ts");

    // All three should be identical
    expect(normalized1).toEqual(normalized2);
    expect(normalized1).toEqual(normalized3);
  });

  test("Finding IDs are deterministic based on content", () => {
    const finding: FindingInput = {
      ruleId: "TS2304",
      severity: "error",
      message: "Cannot find name 'foo'.",
      filePath: "src/index.ts",
      startLine: 10,
      startColumn: 5,
      endLine: 10,
      endColumn: 8,
    };

    const analysisId = "test-analysis-id";
    const normalized1 = normalizeFindings([finding], analysisId);
    const normalized2 = normalizeFindings([{ ...finding }], analysisId); // Clone

    // Same finding should produce same ID
    expect(normalized1[0].findingId).toBe(normalized2[0].findingId);

    // Different analysis ID should produce different finding ID
    const normalized3 = normalizeFindings([finding], "different-analysis-id");
    expect(normalized1[0].findingId).not.toBe(normalized3[0].findingId);

    // Different location should produce different finding ID
    const differentLocation = normalizeFindings(
      [{ ...finding, startLine: 11 }],
      analysisId
    );
    expect(normalized1[0].findingId).not.toBe(differentLocation[0].findingId);
  });

  test("Findings digest is deterministic", () => {
    const findings: FindingInput[] = [
      {
        ruleId: "TS2304",
        severity: "error",
        message: "Cannot find name 'foo'.",
        filePath: "src/index.ts",
        startLine: 10,
      },
      {
        ruleId: "TS2304",
        severity: "error",
        message: "Cannot find name 'bar'.",
        filePath: "src/utils.ts",
        startLine: 5,
      },
    ];

    const analysisId = "test-analysis-id";
    const normalized1 = normalizeFindings(findings, analysisId);
    const normalized2 = normalizeFindings([findings[1], findings[0]], analysisId); // Reverse order

    const digest1 = computeFindingsDigest(normalized1);
    const digest2 = computeFindingsDigest(normalized2);

    // Same findings should produce same digest regardless of input order
    expect(digest1).toBe(digest2);

    // Different findings should produce different digest
    const normalized3 = normalizeFindings([findings[0]], analysisId);
    const digest3 = computeFindingsDigest(normalized3);
    expect(digest1).not.toBe(digest3);
  });

  test("Analysis ID is deterministic based on inputs", () => {
    const inputs = {
      projectId: "project-123",
      treeHash: "abc123",
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config-hash",
      findingsDigest: "findings-digest",
    };

    const analysisId1 = computeAnalysisId(inputs);
    const analysisId2 = computeAnalysisId({ ...inputs });

    // Same inputs produce same ID
    expect(analysisId1).toBe(analysisId2);

    // Different projectId produces different ID
    const differentProject = computeAnalysisId({ ...inputs, projectId: "project-456" });
    expect(analysisId1).not.toBe(differentProject);

    // Different treeHash produces different ID
    const differentTree = computeAnalysisId({ ...inputs, treeHash: "def456" });
    expect(analysisId1).not.toBe(differentTree);

    // Different tool version produces different ID
    const differentVersion = computeAnalysisId({ ...inputs, toolVersion: "5.4.0" });
    expect(analysisId1).not.toBe(differentVersion);

    // Different config produces different ID
    const differentConfig = computeAnalysisId({ ...inputs, configHash: "different-config" });
    expect(analysisId1).not.toBe(differentConfig);

    // Different findings produces different ID
    const differentFindings = computeAnalysisId({
      ...inputs,
      findingsDigest: "different-findings",
    });
    expect(analysisId1).not.toBe(differentFindings);
  });

  test("Analysis ID is content-addressable (same inputs = same ID across runs)", () => {
    // Simulate multiple CI runs with identical inputs
    const run1 = computeAnalysisId({
      projectId: "ping-mem-abc123",
      treeHash: "deadbeef",
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config-abc",
      findingsDigest: "findings-xyz",
    });

    // Simulate same project state in a different environment
    const run2 = computeAnalysisId({
      projectId: "ping-mem-abc123",
      treeHash: "deadbeef",
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config-abc",
      findingsDigest: "findings-xyz",
    });

    // Should produce identical analysis IDs
    expect(run1).toBe(run2);

    // Even a tiny change should produce a different ID
    const run3 = computeAnalysisId({
      projectId: "ping-mem-abc123",
      treeHash: "deadbeef1", // Single char difference
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config-abc",
      findingsDigest: "findings-xyz",
    });

    expect(run1).not.toBe(run3);
  });

  test("Message normalization is deterministic", () => {
    const findings: FindingInput[] = [
      {
        ruleId: "TEST",
        severity: "warning",
        message: "  Multiple   spaces   here  ",
        filePath: "test.ts",
      },
      {
        ruleId: "TEST",
        severity: "warning",
        message: "Multiple spaces here",
        filePath: "test.ts",
      },
    ];

    const normalized = normalizeFindings(findings, "test-id");

    // Normalized messages should be identical (excess whitespace removed)
    expect(normalized[0].message).toBe("Multiple spaces here");
    expect(normalized[1].message).toBe("Multiple spaces here");
  });

  test("File path normalization is deterministic", () => {
    const findings: FindingInput[] = [
      {
        ruleId: "TEST",
        severity: "error",
        message: "Error",
        filePath: "src\\utils\\index.ts", // Windows-style path
      },
      {
        ruleId: "TEST",
        severity: "error",
        message: "Error",
        filePath: "src/utils/index.ts", // Unix-style path
      },
    ];

    const normalized = normalizeFindings(findings, "test-id");

    // Both should be normalized to Unix-style paths
    expect(normalized[0].filePath).toBe("src/utils/index.ts");
    expect(normalized[1].filePath).toBe("src/utils/index.ts");
  });
});
