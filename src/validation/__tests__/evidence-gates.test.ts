/**
 * Tests for evidence gate checker.
 *
 * Validates that checkEvidenceGate correctly enforces metadata requirements
 * for gated memory categories.
 *
 * @module validation/__tests__/evidence-gates.test
 */

import { describe, test, expect } from "bun:test";
import {
  checkEvidenceGate,
  EVIDENCE_GATES,
  type EvidenceGateResult,
} from "../evidence-gates.js";

// ============================================================================
// Tests
// ============================================================================

describe("checkEvidenceGate", () => {
  // --------------------------------------------------------------------------
  // Categories without gates
  // --------------------------------------------------------------------------

  describe("categories without gates", () => {
    test("returns pass for ungated category 'task'", () => {
      const result = checkEvidenceGate("task", {});
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("returns pass for ungated category 'progress'", () => {
      const result = checkEvidenceGate("progress", { anything: "goes" });
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("returns pass for undefined category", () => {
      const result = checkEvidenceGate(undefined, {});
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("returns pass for custom (non-built-in) category", () => {
      const result = checkEvidenceGate("custom_category", {});
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Gated categories — missing required fields
  // --------------------------------------------------------------------------

  describe("gated categories — missing required fields", () => {
    test("decision: warns when 'rationale' is missing", () => {
      const result = checkEvidenceGate("decision", {});
      expect(result.passed).toBe(true); // "warn" enforcement allows save
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("rationale");
    });

    test("error: warns when 'source' is missing", () => {
      const result = checkEvidenceGate("error", {});
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("source");
    });

    test("fact: warns when 'source' is missing", () => {
      const result = checkEvidenceGate("fact", {});
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("source");
    });

    test("knowledge_entry: warns when 'source' is missing", () => {
      const result = checkEvidenceGate("knowledge_entry", {});
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("source");
    });

    test("treats null value as missing", () => {
      const result = checkEvidenceGate("decision", { rationale: null });
      expect(result.warnings).toHaveLength(1);
    });

    test("treats empty string as missing", () => {
      const result = checkEvidenceGate("fact", { source: "" });
      expect(result.warnings).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Gated categories — required fields present
  // --------------------------------------------------------------------------

  describe("gated categories — required fields present", () => {
    test("decision: passes when 'rationale' is present", () => {
      const result = checkEvidenceGate("decision", {
        rationale: "Based on performance benchmarks",
      });
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("error: passes when 'source' is present", () => {
      const result = checkEvidenceGate("error", {
        source: "TypeScript compiler output",
      });
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("fact: passes when 'source' is present", () => {
      const result = checkEvidenceGate("fact", {
        source: "https://docs.example.com",
      });
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("knowledge_entry: passes when 'source' is present", () => {
      const result = checkEvidenceGate("knowledge_entry", {
        source: "codebase analysis",
      });
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Admin bypass
  // --------------------------------------------------------------------------

  describe("admin bypass", () => {
    test("skips gate check when adminBypass is true", () => {
      // decision without rationale would normally warn
      const result = checkEvidenceGate("decision", {}, true);
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("skips gate check for fact without source when admin", () => {
      const result = checkEvidenceGate("fact", {}, true);
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("admin bypass with undefined category still passes", () => {
      const result = checkEvidenceGate(undefined, {}, true);
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // EVIDENCE_GATES constant
  // --------------------------------------------------------------------------

  describe("EVIDENCE_GATES constant", () => {
    test("has expected gated categories", () => {
      const gatedCategories = Object.keys(EVIDENCE_GATES);
      expect(gatedCategories).toContain("decision");
      expect(gatedCategories).toContain("error");
      expect(gatedCategories).toContain("fact");
      expect(gatedCategories).toContain("knowledge_entry");
    });

    test("all current rules use 'warn' enforcement", () => {
      for (const [_category, rule] of Object.entries(EVIDENCE_GATES)) {
        expect(rule.enforcement).toBe("warn");
      }
    });

    test("decision requires rationale", () => {
      expect(EVIDENCE_GATES["decision"]!.required).toContain("rationale");
    });

    test("fact requires source", () => {
      expect(EVIDENCE_GATES["fact"]!.required).toContain("source");
    });
  });
});
