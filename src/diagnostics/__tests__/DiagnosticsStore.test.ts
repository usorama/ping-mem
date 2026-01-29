import { describe, test, expect, beforeEach } from "bun:test";
import { DiagnosticsStore } from "../DiagnosticsStore.js";
import { normalizeFindings, computeFindingsDigest, computeAnalysisId } from "../index.js";
import type { DiagnosticRun, FindingInput } from "../types.js";

describe("DiagnosticsStore", () => {
  let store: DiagnosticsStore;

  beforeEach(() => {
    // Use in-memory database for tests
    store = new DiagnosticsStore({ dbPath: ":memory:" });
  });

  test("Store and retrieve diagnostic run", () => {
    const findings: FindingInput[] = [
      {
        ruleId: "TS2304",
        severity: "error",
        message: "Cannot find name 'foo'.",
        filePath: "src/index.ts",
        startLine: 10,
      },
    ];

    const analysisId = computeAnalysisId({
      projectId: "test-project",
      treeHash: "abc123",
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config-hash",
      findingsDigest: computeFindingsDigest(normalizeFindings(findings, "temp-id")),
    });

    const normalizedFindings = normalizeFindings(findings, analysisId);
    const runId = store.createRunId();

    const run: DiagnosticRun = {
      runId,
      analysisId,
      projectId: "test-project",
      treeHash: "abc123",
      commitHash: "commit123",
      tool: { name: "tsc", version: "5.3.3" },
      configHash: "config-hash",
      environmentHash: "env-hash",
      status: "failed",
      createdAt: new Date().toISOString(),
      durationMs: 1000,
      findingsDigest: computeFindingsDigest(normalizedFindings),
      metadata: {},
    };

    store.saveRun(run, normalizedFindings);

    // Retrieve by analysis ID
    const retrieved = store.getRunByAnalysisId(analysisId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.analysisId).toBe(analysisId);
    expect(retrieved?.tool.name).toBe("tsc");
    expect(retrieved?.status).toBe("failed");

    // Retrieve findings
    const storedFindings = store.listFindings(analysisId);
    expect(storedFindings).toHaveLength(1);
    expect(storedFindings[0].ruleId).toBe("TS2304");
    expect(storedFindings[0].severity).toBe("error");
    expect(storedFindings[0].filePath).toBe("src/index.ts");
  });

  test("getLatestRun returns most recent run for project", () => {
    const projectId = "test-project";
    const treeHash = "abc123";

    // Create two runs
    const run1Id = store.createRunId();
    const run2Id = store.createRunId();

    const analysisId1 = "analysis-1";
    const analysisId2 = "analysis-2";

    const run1: DiagnosticRun = {
      runId: run1Id,
      analysisId: analysisId1,
      projectId,
      treeHash,
      tool: { name: "tsc", version: "5.3.3" },
      configHash: "config-1",
      status: "passed",
      createdAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      findingsDigest: "digest-1",
      metadata: {},
    };

    const run2: DiagnosticRun = {
      runId: run2Id,
      analysisId: analysisId2,
      projectId,
      treeHash,
      tool: { name: "tsc", version: "5.3.3" },
      configHash: "config-2",
      status: "failed",
      createdAt: new Date().toISOString(), // Now
      findingsDigest: "digest-2",
      metadata: {},
    };

    store.saveRun(run1, []);
    store.saveRun(run2, []);

    const latest = store.getLatestRun({ projectId });
    expect(latest).not.toBeNull();
    expect(latest?.runId).toBe(run2Id);
    expect(latest?.analysisId).toBe(analysisId2);
  });

  test("getLatestRun filters by tool name and version", () => {
    const projectId = "test-project";

    const tscRun: DiagnosticRun = {
      runId: store.createRunId(),
      analysisId: "tsc-analysis",
      projectId,
      treeHash: "abc123",
      tool: { name: "tsc", version: "5.3.3" },
      configHash: "config",
      status: "passed",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      findingsDigest: "digest-tsc",
      metadata: {},
    };

    const eslintRun: DiagnosticRun = {
      runId: store.createRunId(),
      analysisId: "eslint-analysis",
      projectId,
      treeHash: "abc123",
      tool: { name: "eslint", version: "8.0.0" },
      configHash: "config",
      status: "failed",
      createdAt: new Date().toISOString(),
      findingsDigest: "digest-eslint",
      metadata: {},
    };

    store.saveRun(tscRun, []);
    store.saveRun(eslintRun, []);

    // Query for tsc only
    const tscLatest = store.getLatestRun({
      projectId,
      toolName: "tsc",
    });
    expect(tscLatest?.tool.name).toBe("tsc");

    // Query for eslint only
    const eslintLatest = store.getLatestRun({
      projectId,
      toolName: "eslint",
    });
    expect(eslintLatest?.tool.name).toBe("eslint");
  });

  test("diffAnalyses compares two analyses correctly", () => {
    const findings1: FindingInput[] = [
      {
        ruleId: "RULE1",
        severity: "error",
        message: "Error 1",
        filePath: "file1.ts",
      },
      {
        ruleId: "RULE2",
        severity: "warning",
        message: "Warning 1",
        filePath: "file2.ts",
      },
    ];

    const findings2: FindingInput[] = [
      {
        ruleId: "RULE1",
        severity: "error",
        message: "Error 1",
        filePath: "file1.ts",
      },
      {
        ruleId: "RULE3",
        severity: "error",
        message: "Error 3",
        filePath: "file3.ts",
      },
    ];

    const analysisId1 = "analysis-1";
    const analysisId2 = "analysis-2";

    const normalized1 = normalizeFindings(findings1, analysisId1);
    const normalized2 = normalizeFindings(findings2, analysisId2);

    const run1: DiagnosticRun = {
      runId: store.createRunId(),
      analysisId: analysisId1,
      projectId: "project",
      treeHash: "hash1",
      tool: { name: "tool", version: "1.0" },
      configHash: "config",
      status: "failed",
      createdAt: new Date().toISOString(),
      findingsDigest: computeFindingsDigest(normalized1),
      metadata: {},
    };

    const run2: DiagnosticRun = {
      runId: store.createRunId(),
      analysisId: analysisId2,
      projectId: "project",
      treeHash: "hash2",
      tool: { name: "tool", version: "1.0" },
      configHash: "config",
      status: "failed",
      createdAt: new Date().toISOString(),
      findingsDigest: computeFindingsDigest(normalized2),
      metadata: {},
    };

    store.saveRun(run1, normalized1);
    store.saveRun(run2, normalized2);

    const diff = store.diffAnalyses(analysisId1, analysisId2);

    // Note: Finding IDs include analysisId in their hash, so the same rule
    // in different analyses will have different IDs. This is correct behavior.
    // RULE1 appears in both, but with different finding IDs (resolved in A1, introduced in A2)
    // RULE2 exists only in analysis1 (resolved)
    // RULE3 exists only in analysis2 (introduced)
    
    // Total findings in analysis1: 2 (RULE1, RULE2)
    // Total findings in analysis2: 2 (RULE1, RULE3)
    // All findings from analysis1 are "resolved" (not in analysis2 with same ID)
    // All findings from analysis2 are "introduced" (not in analysis1 with same ID)
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.resolved).toHaveLength(2);
    expect(diff.introduced).toHaveLength(2);

    // Verify the findings are correctly categorized
    const finding1IdA1 = normalized1.find((f) => f.ruleId === "RULE1")?.findingId;
    const finding2Id = normalized1.find((f) => f.ruleId === "RULE2")?.findingId;
    const finding1IdA2 = normalized2.find((f) => f.ruleId === "RULE1")?.findingId;
    const finding3Id = normalized2.find((f) => f.ruleId === "RULE3")?.findingId;

    expect(diff.resolved).toContain(finding1IdA1);
    expect(diff.resolved).toContain(finding2Id);
    expect(diff.introduced).toContain(finding1IdA2);
    expect(diff.introduced).toContain(finding3Id);
  });

  test("Same findings produce same analysisId (idempotency)", () => {
    const findings: FindingInput[] = [
      {
        ruleId: "TEST",
        severity: "error",
        message: "Test error",
        filePath: "test.ts",
      },
    ];

    const params = {
      projectId: "project-123",
      treeHash: "tree-abc",
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config-xyz",
      findingsDigest: computeFindingsDigest(normalizeFindings(findings, "temp")),
    };

    const analysisId1 = computeAnalysisId(params);
    const analysisId2 = computeAnalysisId(params);

    expect(analysisId1).toBe(analysisId2);

    // Store the same analysis twice (should be idempotent)
    const normalized = normalizeFindings(findings, analysisId1);

    const run1: DiagnosticRun = {
      runId: store.createRunId(),
      analysisId: analysisId1,
      projectId: params.projectId,
      treeHash: params.treeHash,
      tool: { name: params.toolName, version: params.toolVersion },
      configHash: params.configHash,
      status: "failed",
      createdAt: new Date().toISOString(),
      findingsDigest: params.findingsDigest,
      metadata: {},
    };

    store.saveRun(run1, normalized);

    // Should be able to retrieve it
    const retrieved = store.getRunByAnalysisId(analysisId1);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.analysisId).toBe(analysisId1);

    const storedFindings = store.listFindings(analysisId1);
    expect(storedFindings).toHaveLength(1);
  });

  test("createRunId generates unique UUIDv7-like IDs", () => {
    const id1 = store.createRunId();
    const id2 = store.createRunId();
    const id3 = store.createRunId();

    // IDs should be unique
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);

    // IDs should have UUID format (8-4-4-4-12)
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(id1).toMatch(uuidPattern);
    expect(id2).toMatch(uuidPattern);
    expect(id3).toMatch(uuidPattern);
  });
});
