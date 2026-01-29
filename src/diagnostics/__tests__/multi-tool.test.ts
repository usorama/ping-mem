import { describe, test, expect } from "bun:test";
import {
  DiagnosticsStore,
  normalizeFindings,
  computeFindingsDigest,
  computeAnalysisId,
} from "../index.js";
import type { FindingInput } from "../types.js";

describe("Multi-Tool Diagnostics", () => {
  test("Store findings from multiple tools for same treeHash", () => {
    const store = new DiagnosticsStore({ dbPath: ":memory:" });

    const projectId = "test-project";
    const treeHash = "abc123";
    const configHash = "config-hash";

    // TypeScript findings
    const tscFindings: FindingInput[] = [
      {
        ruleId: "TS2304",
        severity: "error",
        message: "Cannot find name 'foo'.",
        filePath: "src/index.ts",
        startLine: 10,
      },
    ];

    // ESLint findings
    const eslintFindings: FindingInput[] = [
      {
        ruleId: "no-unused-vars",
        severity: "warning",
        message: "'bar' is defined but never used.",
        filePath: "src/utils.ts",
        startLine: 5,
      },
    ];

    // Prettier findings
    const prettierFindings: FindingInput[] = [
      {
        ruleId: "prettier/prettier",
        severity: "warning",
        message: "File is not formatted",
        filePath: "src/index.ts",
        startLine: 1,
      },
    ];

    // Ingest all three
    const tools = [
      { name: "tsc", version: "5.3.3", findings: tscFindings },
      { name: "eslint", version: "8.56.0", findings: eslintFindings },
      { name: "prettier", version: "3.1.1", findings: prettierFindings },
    ];

    const analysisIds: string[] = [];

    for (const tool of tools) {
      const normalized = normalizeFindings(tool.findings, "temp");
      const digest = computeFindingsDigest(normalized);
      const analysisId = computeAnalysisId({
        projectId,
        treeHash,
        toolName: tool.name,
        toolVersion: tool.version,
        configHash,
        findingsDigest: digest,
      });

      const finalFindings = normalizeFindings(tool.findings, analysisId);

      store.saveRun(
        {
          runId: store.createRunId(),
          analysisId,
          projectId,
          treeHash,
          tool: { name: tool.name, version: tool.version },
          configHash,
          status: "failed",
          createdAt: new Date().toISOString(),
          findingsDigest: digest,
          metadata: {},
        },
        finalFindings
      );

      analysisIds.push(analysisId);
    }

    // Verify each tool's findings
    expect(analysisIds).toHaveLength(3);
    expect(store.listFindings(analysisIds[0])).toHaveLength(1);
    expect(store.listFindings(analysisIds[1])).toHaveLength(1);
    expect(store.listFindings(analysisIds[2])).toHaveLength(1);

    // Query latest for each tool
    const latestTsc = store.getLatestRun({ projectId, treeHash, toolName: "tsc" });
    const latestEslint = store.getLatestRun({ projectId, treeHash, toolName: "eslint" });
    const latestPrettier = store.getLatestRun({ projectId, treeHash, toolName: "prettier" });

    expect(latestTsc?.tool.name).toBe("tsc");
    expect(latestEslint?.tool.name).toBe("eslint");
    expect(latestPrettier?.tool.name).toBe("prettier");

    store.close();
  });

  test("Same tool, different treeHash produces different analysisId", () => {
    const findings: FindingInput[] = [
      {
        ruleId: "TS2304",
        severity: "error",
        message: "Error",
        filePath: "src/index.ts",
        startLine: 10,
      },
    ];

    const normalized = normalizeFindings(findings, "temp");
    const digest = computeFindingsDigest(normalized);

    const analysisId1 = computeAnalysisId({
      projectId: "test",
      treeHash: "tree-1",
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config",
      findingsDigest: digest,
    });

    const analysisId2 = computeAnalysisId({
      projectId: "test",
      treeHash: "tree-2", // Different tree
      toolName: "tsc",
      toolVersion: "5.3.3",
      configHash: "config",
      findingsDigest: digest,
    });

    expect(analysisId1).not.toBe(analysisId2);
  });
});
