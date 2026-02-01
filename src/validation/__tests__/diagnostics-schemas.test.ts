/**
 * Tests for diagnostics-schemas validation
 *
 * @module validation/__tests__/diagnostics-schemas.test
 */

import { describe, it, expect } from "@jest/globals";
import {
  diagnosticsIngestSchema,
  queryLatestSchema,
  diffSchema,
  compareToolsSchema,
  bySymbolSchema,
  summarizeSchema,
  findingSchema,
} from "../diagnostics-schemas.js";

describe("diagnostics-schemas", () => {
  // ========================================================================
  // findingSchema
  // ========================================================================

  describe("findingSchema", () => {
    it("should accept valid finding with all fields", () => {
      const result = findingSchema.safeParse({
        ruleId: "no-unused-vars",
        message: "Unused variable 'foo'",
        severity: "error",
        location: {
          filePath: "src/index.ts",
          startLine: 10,
          endLine: 10,
          startColumn: 5,
          endColumn: 8,
        },
        code: "const foo = 1;",
        category: "code-quality",
        fixes: [
          {
            message: "Remove unused variable",
            replacement: "",
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("should accept minimal finding", () => {
      const result = findingSchema.safeParse({
        message: "Some issue",
        severity: "warning",
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid severity", () => {
      const result = findingSchema.safeParse({
        message: "Issue",
        severity: "critical",
      });
      expect(result.success).toBe(false);
    });

    it("should reject negative line numbers", () => {
      const result = findingSchema.safeParse({
        message: "Issue",
        severity: "error",
        location: {
          filePath: "test.ts",
          startLine: -1,
        },
      });
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // diagnosticsIngestSchema
  // ========================================================================

  describe("diagnosticsIngestSchema", () => {
    const minimalValid = {
      projectId: "ping-mem-abc123",
      treeHash: "a".repeat(64),
      configHash: "b".repeat(64),
      toolName: "tsc",
      toolVersion: "5.3.3",
      findings: [
        {
          message: "Test error",
          severity: "error" as const,
        },
      ],
    };

    it("should accept valid minimal request with findings", () => {
      const result = diagnosticsIngestSchema.safeParse(minimalValid);
      expect(result.success).toBe(true);
    });

    it("should accept valid request with all optional fields", () => {
      const result = diagnosticsIngestSchema.safeParse({
        ...minimalValid,
        commitHash: "abc1234",
        environmentHash: "c".repeat(64),
        status: "passed" as const,
        durationMs: 5000,
        metadata: { ci: true, branch: "main" },
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing projectId", () => {
      const { projectId, ...rest } = minimalValid;
      const result = diagnosticsIngestSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("should reject invalid treeHash (not 64 chars)", () => {
      const result = diagnosticsIngestSchema.safeParse({
        ...minimalValid,
        treeHash: "abc",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid treeHash (non-hex)", () => {
      const result = diagnosticsIngestSchema.safeParse({
        ...minimalValid,
        treeHash: "g".repeat(64),
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing toolName and toolVersion", () => {
      const { toolName, toolVersion, ...rest } = minimalValid;
      const result = diagnosticsIngestSchema.safeParse(rest);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes("toolName"))).toBe(true);
      }
    });

    it("should reject both findings and sarif provided", () => {
      const result = diagnosticsIngestSchema.safeParse({
        ...minimalValid,
        sarif: "{}",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes("both"))).toBe(true);
      }
    });

    it("should reject invalid status", () => {
      const result = diagnosticsIngestSchema.safeParse({
        ...minimalValid,
        status: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("should reject negative durationMs", () => {
      const result = diagnosticsIngestSchema.safeParse({
        ...minimalValid,
        durationMs: -100,
      });
      expect(result.success).toBe(false);
    });

    it("should reject projectId not starting with ping-mem-", () => {
      const result = diagnosticsIngestSchema.safeParse({
        ...minimalValid,
        projectId: "invalid-project",
      });
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // queryLatestSchema
  // ========================================================================

  describe("queryLatestSchema", () => {
    it("should accept valid query without treeHash", () => {
      const result = queryLatestSchema.safeParse({
        projectId: "ping-mem-abc123",
        toolName: "tsc",
      });
      expect(result.success).toBe(true);
    });

    it("should accept valid query with treeHash", () => {
      const result = queryLatestSchema.safeParse({
        projectId: "ping-mem-abc123",
        toolName: "tsc",
        treeHash: "a".repeat(64),
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid treeHash", () => {
      const result = queryLatestSchema.safeParse({
        projectId: "ping-mem-abc123",
        toolName: "tsc",
        treeHash: "not-a-hash",
      });
      expect(result.success).toBe(false);
    });

    it("should require projectId", () => {
      const result = queryLatestSchema.safeParse({
        toolName: "tsc",
      });
      expect(result.success).toBe(false);
    });

    it("should require toolName", () => {
      const result = queryLatestSchema.safeParse({
        projectId: "ping-mem-abc123",
      });
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // diffSchema
  // ========================================================================

  describe("diffSchema", () => {
    it("should accept valid analysis IDs", () => {
      const result = diffSchema.safeParse({
        analysisIdA: "analysis-1",
        analysisIdB: "analysis-2",
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty analysisIdA", () => {
      const result = diffSchema.safeParse({
        analysisIdA: "",
        analysisIdB: "analysis-2",
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing analysisIdB", () => {
      const result = diffSchema.safeParse({
        analysisIdA: "analysis-1",
      });
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // compareToolsSchema
  // ========================================================================

  describe("compareToolsSchema", () => {
    it("should accept valid tool comparison", () => {
      const result = compareToolsSchema.safeParse({
        projectId: "ping-mem-abc123",
        treeHash: "a".repeat(64),
        toolNames: ["tsc", "eslint"],
      });
      expect(result.success).toBe(true);
    });

    it("should require at least 2 tools", () => {
      const result = compareToolsSchema.safeParse({
        projectId: "ping-mem-abc123",
        treeHash: "a".repeat(64),
        toolNames: ["tsc"],
      });
      expect(result.success).toBe(false);
    });

    it("should reject more than 20 tools", () => {
      const result = compareToolsSchema.safeParse({
        projectId: "ping-mem-abc123",
        treeHash: "a".repeat(64),
        toolNames: Array.from({ length: 21 }, (_, i) => `tool${i}`),
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid treeHash", () => {
      const result = compareToolsSchema.safeParse({
        projectId: "ping-mem-abc123",
        treeHash: "invalid",
        toolNames: ["tsc", "eslint"],
      });
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // bySymbolSchema
  // ========================================================================

  describe("bySymbolSchema", () => {
    it("should accept symbol grouping", () => {
      const result = bySymbolSchema.safeParse({
        analysisId: "analysis-123",
        groupBy: "symbol",
      });
      expect(result.success).toBe(true);
    });

    it("should accept file grouping", () => {
      const result = bySymbolSchema.safeParse({
        analysisId: "analysis-123",
        groupBy: "file",
      });
      expect(result.success).toBe(true);
    });

    it("should default groupBy to symbol", () => {
      const result = bySymbolSchema.safeParse({
        analysisId: "analysis-123",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.groupBy).toBe("symbol");
      }
    });

    it("should reject invalid groupBy", () => {
      const result = bySymbolSchema.safeParse({
        analysisId: "analysis-123",
        groupBy: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty analysisId", () => {
      const result = bySymbolSchema.safeParse({
        analysisId: "",
      });
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // summarizeSchema
  // ========================================================================

  describe("summarizeSchema", () => {
    it("should accept valid request without LLM", () => {
      const result = summarizeSchema.safeParse({
        analysisId: "analysis-123",
        useLLM: false,
      });
      expect(result.success).toBe(true);
    });

    it("should accept valid request with LLM", () => {
      const result = summarizeSchema.safeParse({
        analysisId: "analysis-123",
        useLLM: true,
      });
      expect(result.success).toBe(true);
    });

    it("should default useLLM to false", () => {
      const result = summarizeSchema.safeParse({
        analysisId: "analysis-123",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.useLLM).toBe(false);
      }
    });

    it("should reject non-boolean useLLM", () => {
      const result = summarizeSchema.safeParse({
        analysisId: "analysis-123",
        useLLM: "true",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty analysisId", () => {
      const result = summarizeSchema.safeParse({
        analysisId: "",
      });
      expect(result.success).toBe(false);
    });
  });
});
