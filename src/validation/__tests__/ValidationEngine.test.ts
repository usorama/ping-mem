/**
 * Tests for ValidationEngine
 *
 * @module validation/__tests__/ValidationEngine.test
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  ValidationEngine,
  createValidationEngine,
} from "../ValidationEngine.js";
import type {
  ValidationRule,
  ValidationRuleInput,
  ValidationOutcome,
  ValidationContext,
} from "../types.js";

describe("ValidationEngine", () => {
  let engine: ValidationEngine;

  beforeEach(() => {
    engine = new ValidationEngine();
  });

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe("Initialization", () => {
    it("should create with default configuration", () => {
      expect(engine.isEnabled()).toBe(true);
      const config = engine.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.continueOnFailure).toBe(true);
      expect(config.timeoutMs).toBe(30000);
      expect(config.parallel).toBe(false);
      expect(config.defaultSeverity).toBe("error");
      expect(config.includeTags).toEqual([]);
      expect(config.excludeTags).toEqual([]);
    });

    it("should create with custom configuration", () => {
      const customEngine = new ValidationEngine({
        enabled: false,
        continueOnFailure: false,
        timeoutMs: 5000,
        parallel: true,
        defaultSeverity: "warning",
        includeTags: ["critical"],
        excludeTags: ["experimental"],
      });

      expect(customEngine.isEnabled()).toBe(false);
      const config = customEngine.getConfig();
      expect(config.continueOnFailure).toBe(false);
      expect(config.timeoutMs).toBe(5000);
      expect(config.parallel).toBe(true);
      expect(config.defaultSeverity).toBe("warning");
      expect(config.includeTags).toEqual(["critical"]);
      expect(config.excludeTags).toEqual(["experimental"]);
    });

    it("should create using factory function", () => {
      const factoryEngine = createValidationEngine({ enabled: true });
      expect(factoryEngine.isEnabled()).toBe(true);
    });

    it("should reflect isEnabled from configuration", () => {
      const disabledEngine = new ValidationEngine({ enabled: false });
      expect(disabledEngine.isEnabled()).toBe(false);

      const enabledEngine = new ValidationEngine({ enabled: true });
      expect(enabledEngine.isEnabled()).toBe(true);
    });
  });

  // ==========================================================================
  // Rule Management Tests
  // ==========================================================================

  describe("Rule Management", () => {
    const createTestRule = (
      overrides?: Partial<ValidationRuleInput>
    ): ValidationRuleInput => ({
      name: "Test Rule",
      description: "A test validation rule",
      type: "constraint",
      severity: "error",
      validator: () => true,
      enabled: true,
      ...overrides,
    });

    describe("registerRule", () => {
      it("should register a rule with provided ID", () => {
        const rule = createTestRule({ id: "custom-id" });
        const registered = engine.registerRule(rule);

        expect(registered.id).toBe("custom-id");
        expect(engine.getRule("custom-id")).toBeDefined();
      });

      it("should auto-generate ID if not provided", () => {
        const rule = createTestRule();
        const registered = engine.registerRule(rule);

        expect(registered.id).toBeDefined();
        expect(registered.id.length).toBeGreaterThan(0);
        expect(engine.getRule(registered.id)).toBeDefined();
      });

      it("should preserve all rule properties", () => {
        const rule = createTestRule({
          id: "test-rule",
          name: "Custom Name",
          description: "Custom description",
          type: "business",
          severity: "warning",
          tags: ["tag1", "tag2"],
          config: { key: "value" },
        });

        const registered = engine.registerRule(rule);

        expect(registered.name).toBe("Custom Name");
        expect(registered.description).toBe("Custom description");
        expect(registered.type).toBe("business");
        expect(registered.severity).toBe("warning");
        expect(registered.tags).toEqual(["tag1", "tag2"]);
        expect(registered.config).toEqual({ key: "value" });
      });
    });

    describe("removeRule", () => {
      it("should remove an existing rule and return true", () => {
        const rule = createTestRule({ id: "to-remove" });
        engine.registerRule(rule);

        expect(engine.removeRule("to-remove")).toBe(true);
        expect(engine.getRule("to-remove")).toBeUndefined();
      });

      it("should return false when removing non-existent rule", () => {
        expect(engine.removeRule("non-existent")).toBe(false);
      });
    });

    describe("enableRule", () => {
      it("should enable a disabled rule and return true", () => {
        const rule = createTestRule({ id: "to-enable", enabled: false });
        engine.registerRule(rule);

        expect(engine.enableRule("to-enable")).toBe(true);
        expect(engine.getRule("to-enable")?.enabled).toBe(true);
      });

      it("should return false for non-existent rule", () => {
        expect(engine.enableRule("non-existent")).toBe(false);
      });
    });

    describe("disableRule", () => {
      it("should disable an enabled rule and return true", () => {
        const rule = createTestRule({ id: "to-disable", enabled: true });
        engine.registerRule(rule);

        expect(engine.disableRule("to-disable")).toBe(true);
        expect(engine.getRule("to-disable")?.enabled).toBe(false);
      });

      it("should return false for non-existent rule", () => {
        expect(engine.disableRule("non-existent")).toBe(false);
      });
    });

    describe("getRules", () => {
      it("should return empty array when no rules registered", () => {
        expect(engine.getRules()).toEqual([]);
      });

      it("should return all registered rules", () => {
        engine.registerRule(createTestRule({ id: "rule-1" }));
        engine.registerRule(createTestRule({ id: "rule-2" }));
        engine.registerRule(createTestRule({ id: "rule-3" }));

        const rules = engine.getRules();
        expect(rules.length).toBe(3);
        expect(rules.map((r) => r.id)).toContain("rule-1");
        expect(rules.map((r) => r.id)).toContain("rule-2");
        expect(rules.map((r) => r.id)).toContain("rule-3");
      });
    });

    describe("getRule", () => {
      it("should return rule by ID", () => {
        engine.registerRule(createTestRule({ id: "test-id", name: "Test" }));
        const rule = engine.getRule("test-id");

        expect(rule).toBeDefined();
        expect(rule?.name).toBe("Test");
      });

      it("should return undefined for non-existent rule", () => {
        expect(engine.getRule("non-existent")).toBeUndefined();
      });
    });

    describe("reset", () => {
      it("should clear all registered rules", () => {
        engine.registerRule(createTestRule({ id: "rule-1" }));
        engine.registerRule(createTestRule({ id: "rule-2" }));

        engine.reset();

        expect(engine.getRules()).toEqual([]);
      });
    });
  });

  // ==========================================================================
  // Validation Execution Tests
  // ==========================================================================

  describe("Validation Execution", () => {
    describe("validate", () => {
      it("should validate data against all enabled rules", async () => {
        engine.registerRule({
          id: "rule-1",
          name: "Rule 1",
          description: "First rule",
          type: "constraint",
          severity: "error",
          validator: (data: number) => data > 0,
          enabled: true,
        });

        engine.registerRule({
          id: "rule-2",
          name: "Rule 2",
          description: "Second rule",
          type: "constraint",
          severity: "error",
          validator: (data: number) => data < 100,
          enabled: true,
        });

        const report = await engine.validate(50);

        expect(report.results.length).toBe(2);
        expect(report.results.every((r) => r.passed)).toBe(true);
        expect(report.valid).toBe(true);
      });

      it("should skip disabled rules", async () => {
        engine.registerRule({
          id: "enabled-rule",
          name: "Enabled",
          description: "Enabled rule",
          type: "constraint",
          severity: "error",
          validator: () => true,
          enabled: true,
        });

        engine.registerRule({
          id: "disabled-rule",
          name: "Disabled",
          description: "Disabled rule",
          type: "constraint",
          severity: "error",
          validator: () => false,
          enabled: false,
        });

        const report = await engine.validate({});

        expect(report.results.length).toBe(1);
        expect(report.results[0]!.ruleId).toBe("enabled-rule");
      });

      it("should handle empty data gracefully", async () => {
        engine.registerRule({
          id: "null-check",
          name: "Null Check",
          description: "Checks for null",
          type: "constraint",
          severity: "error",
          validator: (data: unknown) => data !== null,
          enabled: true,
        });

        const report = await engine.validate({});
        expect(report.valid).toBe(true);

        const reportWithNull = await engine.validate(null);
        expect(reportWithNull.valid).toBe(false);
      });

      it("should return empty report when no rules registered", async () => {
        const report = await engine.validate({ test: "data" });

        expect(report.results).toEqual([]);
        expect(report.summary.total).toBe(0);
        expect(report.valid).toBe(true);
        expect(report.score).toBe(100);
      });
    });

    describe("validateWithRules", () => {
      it("should validate only specified rules", async () => {
        engine.registerRule({
          id: "rule-a",
          name: "Rule A",
          description: "Rule A",
          type: "constraint",
          severity: "error",
          validator: () => true,
          enabled: true,
        });

        engine.registerRule({
          id: "rule-b",
          name: "Rule B",
          description: "Rule B",
          type: "constraint",
          severity: "error",
          validator: () => false,
          enabled: true,
        });

        engine.registerRule({
          id: "rule-c",
          name: "Rule C",
          description: "Rule C",
          type: "constraint",
          severity: "error",
          validator: () => true,
          enabled: true,
        });

        const report = await engine.validateWithRules({}, ["rule-a", "rule-c"]);

        expect(report.results.length).toBe(2);
        expect(report.results.map((r) => r.ruleId)).toEqual([
          "rule-a",
          "rule-c",
        ]);
        expect(report.valid).toBe(true);
      });

      it("should ignore non-existent rule IDs", async () => {
        engine.registerRule({
          id: "existing",
          name: "Existing",
          description: "Existing rule",
          type: "constraint",
          severity: "error",
          validator: () => true,
          enabled: true,
        });

        const report = await engine.validateWithRules({}, [
          "existing",
          "non-existent",
        ]);

        expect(report.results.length).toBe(1);
        expect(report.results[0]!.ruleId).toBe("existing");
      });

      it("should include disabled rules when explicitly specified", async () => {
        engine.registerRule({
          id: "disabled",
          name: "Disabled",
          description: "Disabled rule",
          type: "constraint",
          severity: "error",
          validator: () => true,
          enabled: false,
        });

        const report = await engine.validateWithRules({}, ["disabled"]);

        expect(report.results.length).toBe(1);
        expect(report.results[0]!.ruleId).toBe("disabled");
      });
    });
  });

  // ==========================================================================
  // Rule Types Tests
  // ==========================================================================

  describe("Rule Types", () => {
    it("should support schema rules", async () => {
      engine.registerRule({
        id: "schema-rule",
        name: "Schema Validation",
        description: "Validates schema structure",
        type: "schema",
        severity: "error",
        validator: (data: { name?: string }) =>
          typeof data.name === "string" && data.name.length > 0,
        enabled: true,
      });

      const validReport = await engine.validate({ name: "John" });
      expect(validReport.valid).toBe(true);

      const invalidReport = await engine.validate({ name: "" });
      expect(invalidReport.valid).toBe(false);
    });

    it("should support constraint rules", async () => {
      engine.registerRule({
        id: "constraint-rule",
        name: "Age Constraint",
        description: "Age must be >= 18",
        type: "constraint",
        severity: "error",
        validator: (data: { age?: number }) =>
          typeof data.age === "number" && data.age >= 18,
        enabled: true,
      });

      const validReport = await engine.validate({ age: 25 });
      expect(validReport.valid).toBe(true);

      const invalidReport = await engine.validate({ age: 15 });
      expect(invalidReport.valid).toBe(false);
    });

    it("should support business rules", async () => {
      engine.registerRule({
        id: "business-rule",
        name: "Premium User Check",
        description: "Premium users must have balance > 1000",
        type: "business",
        severity: "error",
        validator: (data: { isPremium?: boolean; balance?: number }) => {
          if (data.isPremium) {
            return typeof data.balance === "number" && data.balance > 1000;
          }
          return true;
        },
        enabled: true,
      });

      const validReport = await engine.validate({
        isPremium: true,
        balance: 2000,
      });
      expect(validReport.valid).toBe(true);

      const invalidReport = await engine.validate({
        isPremium: true,
        balance: 500,
      });
      expect(invalidReport.valid).toBe(false);

      const nonPremiumReport = await engine.validate({
        isPremium: false,
        balance: 100,
      });
      expect(nonPremiumReport.valid).toBe(true);
    });
  });

  // ==========================================================================
  // Severities Tests
  // ==========================================================================

  describe("Severities", () => {
    it("should handle error severity", async () => {
      engine.registerRule({
        id: "error-rule",
        name: "Error Rule",
        description: "An error-level rule",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.severity).toBe("error");
      expect(report.valid).toBe(false);
    });

    it("should handle warning severity", async () => {
      engine.registerRule({
        id: "warning-rule",
        name: "Warning Rule",
        description: "A warning-level rule",
        type: "constraint",
        severity: "warning",
        validator: () => false,
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.severity).toBe("warning");
      expect(report.summary.warnings).toBe(1);
    });

    it("should handle info severity", async () => {
      engine.registerRule({
        id: "info-rule",
        name: "Info Rule",
        description: "An info-level rule",
        type: "constraint",
        severity: "info",
        validator: () => false,
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.severity).toBe("info");
      expect(report.summary.infos).toBe(1);
    });

    it("should count different severities in summary", async () => {
      engine.registerRule({
        id: "error",
        name: "Error",
        description: "Error",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
      });

      engine.registerRule({
        id: "warning",
        name: "Warning",
        description: "Warning",
        type: "constraint",
        severity: "warning",
        validator: () => false,
        enabled: true,
      });

      engine.registerRule({
        id: "info",
        name: "Info",
        description: "Info",
        type: "constraint",
        severity: "info",
        validator: () => false,
        enabled: true,
      });

      engine.registerRule({
        id: "passed",
        name: "Passed",
        description: "Passed",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.summary.total).toBe(4);
      expect(report.summary.passed).toBe(1);
      expect(report.summary.failed).toBe(3);
      expect(report.summary.warnings).toBe(1);
      expect(report.summary.infos).toBe(1);
    });
  });

  // ==========================================================================
  // ValidationOutcome Tests
  // ==========================================================================

  describe("ValidationOutcome", () => {
    it("should handle validator returning boolean true", async () => {
      engine.registerRule({
        id: "bool-true",
        name: "Boolean True",
        description: "Returns true",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.passed).toBe(true);
      expect(report.results[0]!.message).toContain("passed");
    });

    it("should handle validator returning boolean false", async () => {
      engine.registerRule({
        id: "bool-false",
        name: "Boolean False",
        description: "Test description",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.passed).toBe(false);
      expect(report.results[0]!.message).toContain("Test description");
    });

    it("should handle validator returning ValidationOutcome with passed", async () => {
      engine.registerRule({
        id: "outcome-passed",
        name: "Outcome Passed",
        description: "Default description",
        type: "constraint",
        severity: "error",
        validator: (): ValidationOutcome => ({
          passed: true,
          message: "Custom success message",
        }),
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.passed).toBe(true);
      expect(report.results[0]!.message).toBe("Custom success message");
    });

    it("should handle validator returning ValidationOutcome with failed", async () => {
      engine.registerRule({
        id: "outcome-failed",
        name: "Outcome Failed",
        description: "Default description",
        type: "constraint",
        severity: "error",
        validator: (): ValidationOutcome => ({
          passed: false,
          message: "Custom failure message",
        }),
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.passed).toBe(false);
      expect(report.results[0]!.message).toBe("Custom failure message");
    });

    it("should include metadata from ValidationOutcome", async () => {
      engine.registerRule({
        id: "outcome-metadata",
        name: "Outcome With Metadata",
        description: "Has metadata",
        type: "constraint",
        severity: "error",
        validator: (): ValidationOutcome => ({
          passed: true,
          message: "Success with metadata",
          metadata: {
            checkedAt: "2024-01-15",
            source: "test",
            count: 42,
          },
        }),
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.metadata).toEqual({
        checkedAt: "2024-01-15",
        source: "test",
        count: 42,
      });
    });

    it("should use default message when ValidationOutcome has no message", async () => {
      engine.registerRule({
        id: "outcome-no-message",
        name: "Outcome Without Message",
        description: "Default description",
        type: "constraint",
        severity: "error",
        validator: (): ValidationOutcome => ({
          passed: true,
        }),
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.message).toContain("passed");
    });
  });

  // ==========================================================================
  // Report Generation Tests
  // ==========================================================================

  describe("Report Generation", () => {
    it("should generate complete report with all fields", async () => {
      engine.registerRule({
        id: "test-rule",
        name: "Test Rule",
        description: "Test",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      const report = await engine.validate({ data: "test" });

      expect(report.results).toBeDefined();
      expect(report.results.length).toBe(1);
      expect(report.summary).toBeDefined();
      expect(report.score).toBeDefined();
      expect(report.timestamp).toBeDefined();
      expect(report.context).toBeDefined();
      expect(report.totalDurationMs).toBeDefined();
      expect(report.valid).toBeDefined();
    });

    it("should calculate summary correctly", async () => {
      engine.registerRule({
        id: "pass-1",
        name: "Pass 1",
        description: "Passes",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      engine.registerRule({
        id: "pass-2",
        name: "Pass 2",
        description: "Passes",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      engine.registerRule({
        id: "fail-1",
        name: "Fail 1",
        description: "Fails",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.summary.total).toBe(3);
      expect(report.summary.passed).toBe(2);
      expect(report.summary.failed).toBe(1);
    });

    it("should calculate score based on pass rate", async () => {
      // All pass -> score 100
      engine.registerRule({
        id: "pass",
        name: "Pass",
        description: "Passes",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      const allPassReport = await engine.validate({});
      expect(allPassReport.score).toBe(100);

      // Reset and test 50% pass rate
      engine.reset();
      engine.registerRule({
        id: "pass",
        name: "Pass",
        description: "Passes",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });
      engine.registerRule({
        id: "fail",
        name: "Fail",
        description: "Fails",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
      });

      const halfPassReport = await engine.validate({});
      expect(halfPassReport.score).toBe(50);
    });

    it("should penalize warnings in score calculation", async () => {
      engine.registerRule({
        id: "pass",
        name: "Pass",
        description: "Passes",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      engine.registerRule({
        id: "warning",
        name: "Warning",
        description: "Warns",
        type: "constraint",
        severity: "warning",
        validator: () => false,
        enabled: true,
      });

      const report = await engine.validate({});

      // 50% pass rate = 50, minus warning penalty (5) = 45
      expect(report.score).toBe(45);
    });

    it("should set valid flag based on failures", async () => {
      engine.registerRule({
        id: "pass",
        name: "Pass",
        description: "Passes",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      const validReport = await engine.validate({});
      expect(validReport.valid).toBe(true);

      engine.registerRule({
        id: "fail",
        name: "Fail",
        description: "Fails",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
      });

      const invalidReport = await engine.validate({});
      expect(invalidReport.valid).toBe(false);
    });

    it("should return score 100 when no rules", async () => {
      const report = await engine.validate({});
      expect(report.score).toBe(100);
    });
  });

  // ==========================================================================
  // Tag Filtering Tests
  // ==========================================================================

  describe("Tag Filtering", () => {
    beforeEach(() => {
      engine.registerRule({
        id: "critical-rule",
        name: "Critical Rule",
        description: "Critical",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
        tags: ["critical", "security"],
      });

      engine.registerRule({
        id: "normal-rule",
        name: "Normal Rule",
        description: "Normal",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
        tags: ["normal"],
      });

      engine.registerRule({
        id: "experimental-rule",
        name: "Experimental Rule",
        description: "Experimental",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
        tags: ["experimental"],
      });

      engine.registerRule({
        id: "no-tags-rule",
        name: "No Tags Rule",
        description: "No tags",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });
    });

    it("should include only rules with specified tags", async () => {
      const filteredEngine = new ValidationEngine({
        includeTags: ["critical"],
      });

      filteredEngine.registerRule({
        id: "critical",
        name: "Critical",
        description: "Critical",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
        tags: ["critical"],
      });

      filteredEngine.registerRule({
        id: "normal",
        name: "Normal",
        description: "Normal",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
        tags: ["normal"],
      });

      const report = await filteredEngine.validate({});

      expect(report.results.length).toBe(1);
      expect(report.results[0]!.ruleId).toBe("critical");
    });

    it("should exclude rules with specified tags", async () => {
      const filteredEngine = new ValidationEngine({
        excludeTags: ["experimental"],
      });

      filteredEngine.registerRule({
        id: "normal",
        name: "Normal",
        description: "Normal",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
        tags: ["normal"],
      });

      filteredEngine.registerRule({
        id: "experimental",
        name: "Experimental",
        description: "Experimental",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
        tags: ["experimental"],
      });

      const report = await filteredEngine.validate({});

      expect(report.results.length).toBe(1);
      expect(report.results[0]!.ruleId).toBe("normal");
    });

    it("should apply both include and exclude filters", async () => {
      const filteredEngine = new ValidationEngine({
        includeTags: ["security"],
        excludeTags: ["experimental"],
      });

      filteredEngine.registerRule({
        id: "security-prod",
        name: "Security Prod",
        description: "Security",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
        tags: ["security", "production"],
      });

      filteredEngine.registerRule({
        id: "security-exp",
        name: "Security Experimental",
        description: "Security Experimental",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
        tags: ["security", "experimental"],
      });

      filteredEngine.registerRule({
        id: "normal",
        name: "Normal",
        description: "Normal",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
        tags: ["normal"],
      });

      const report = await filteredEngine.validate({});

      expect(report.results.length).toBe(1);
      expect(report.results[0]!.ruleId).toBe("security-prod");
    });

    it("should exclude rules without tags when includeTags is set", async () => {
      const filteredEngine = new ValidationEngine({
        includeTags: ["critical"],
      });

      filteredEngine.registerRule({
        id: "with-tag",
        name: "With Tag",
        description: "Has tag",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
        tags: ["critical"],
      });

      filteredEngine.registerRule({
        id: "no-tag",
        name: "No Tag",
        description: "No tag",
        type: "constraint",
        severity: "error",
        validator: () => false,
        enabled: true,
      });

      const report = await filteredEngine.validate({});

      expect(report.results.length).toBe(1);
      expect(report.results[0]!.ruleId).toBe("with-tag");
    });
  });

  // ==========================================================================
  // Configuration Tests
  // ==========================================================================

  describe("Configuration", () => {
    describe("continueOnFailure", () => {
      it("should stop on first error when continueOnFailure is false", async () => {
        const strictEngine = new ValidationEngine({
          continueOnFailure: false,
        });

        strictEngine.registerRule({
          id: "pass-1",
          name: "Pass 1",
          description: "Passes",
          type: "constraint",
          severity: "error",
          validator: () => true,
          enabled: true,
        });

        strictEngine.registerRule({
          id: "fail-1",
          name: "Fail 1",
          description: "Fails",
          type: "constraint",
          severity: "error",
          validator: () => false,
          enabled: true,
        });

        strictEngine.registerRule({
          id: "pass-2",
          name: "Pass 2",
          description: "Should not run",
          type: "constraint",
          severity: "error",
          validator: () => true,
          enabled: true,
        });

        const report = await strictEngine.validate({});

        // Should stop after fail-1
        expect(report.results.length).toBe(2);
        expect(report.results[0]!.ruleId).toBe("pass-1");
        expect(report.results[1]!.ruleId).toBe("fail-1");
      });

      it("should continue after failure when continueOnFailure is true", async () => {
        const lenientEngine = new ValidationEngine({
          continueOnFailure: true,
        });

        lenientEngine.registerRule({
          id: "fail-1",
          name: "Fail 1",
          description: "Fails",
          type: "constraint",
          severity: "error",
          validator: () => false,
          enabled: true,
        });

        lenientEngine.registerRule({
          id: "pass-1",
          name: "Pass 1",
          description: "Passes",
          type: "constraint",
          severity: "error",
          validator: () => true,
          enabled: true,
        });

        const report = await lenientEngine.validate({});

        expect(report.results.length).toBe(2);
      });
    });

    describe("disabled engine", () => {
      it("should skip all validation when disabled", async () => {
        const disabledEngine = new ValidationEngine({ enabled: false });

        disabledEngine.registerRule({
          id: "should-not-run",
          name: "Should Not Run",
          description: "This should not execute",
          type: "constraint",
          severity: "error",
          validator: () => {
            throw new Error("Should not be called");
          },
          enabled: true,
        });

        const report = await disabledEngine.validate({ data: "test" });

        expect(report.results).toEqual([]);
        expect(report.valid).toBe(true);
        expect(report.score).toBe(100);
      });
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe("Error Handling", () => {
    it("should handle rule that throws an error", async () => {
      engine.registerRule({
        id: "throwing-rule",
        name: "Throwing Rule",
        description: "This rule throws",
        type: "constraint",
        severity: "error",
        validator: () => {
          throw new Error("Validation error occurred");
        },
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results.length).toBe(1);
      expect(report.results[0]!.passed).toBe(false);
      expect(report.results[0]!.message).toContain("error");
      expect(report.results[0]!.metadata).toBeDefined();
      expect(
        (report.results[0]!.metadata as Record<string, unknown>).error
      ).toBeDefined();
    });

    it("should include error details in metadata", async () => {
      const customError = new Error("Custom error message");
      customError.name = "CustomError";

      engine.registerRule({
        id: "custom-error-rule",
        name: "Custom Error Rule",
        description: "Throws custom error",
        type: "constraint",
        severity: "error",
        validator: () => {
          throw customError;
        },
        enabled: true,
      });

      const report = await engine.validate({});

      const errorMeta = (
        report.results[0]!.metadata as Record<string, unknown>
      ).error as Record<string, string>;
      expect(errorMeta.name).toBe("CustomError");
      expect(errorMeta.message).toBe("Custom error message");
    });

    it("should handle rule timeout", async () => {
      const timeoutEngine = new ValidationEngine({
        timeoutMs: 50, // Very short timeout
      });

      timeoutEngine.registerRule({
        id: "slow-rule",
        name: "Slow Rule",
        description: "Takes too long",
        type: "constraint",
        severity: "error",
        validator: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return true;
        },
        enabled: true,
      });

      const report = await timeoutEngine.validate({});

      expect(report.results.length).toBe(1);
      expect(report.results[0]!.passed).toBe(false);
      expect(report.results[0]!.message).toContain("timeout");
    });

    it("should continue after error when continueOnFailure is true", async () => {
      engine.registerRule({
        id: "error-rule",
        name: "Error Rule",
        description: "Throws",
        type: "constraint",
        severity: "error",
        validator: () => {
          throw new Error("Error!");
        },
        enabled: true,
      });

      engine.registerRule({
        id: "normal-rule",
        name: "Normal Rule",
        description: "Normal",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results.length).toBe(2);
      expect(report.results[0]!.passed).toBe(false);
      expect(report.results[1]!.passed).toBe(true);
    });

    it("should handle non-Error exceptions", async () => {
      engine.registerRule({
        id: "string-throw",
        name: "String Throw",
        description: "Throws a string",
        type: "constraint",
        severity: "error",
        validator: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "string error";
        },
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.passed).toBe(false);
      expect(report.results[0]!.message).toContain("string error");
    });
  });

  // ==========================================================================
  // Async Validation Tests
  // ==========================================================================

  describe("Async Validation", () => {
    it("should handle async validators", async () => {
      engine.registerRule({
        id: "async-rule",
        name: "Async Rule",
        description: "Async validation",
        type: "constraint",
        severity: "error",
        validator: async (data: { value: number }) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return data.value > 0;
        },
        enabled: true,
      });

      const report = await engine.validate({ value: 5 });

      expect(report.results[0]!.passed).toBe(true);
    });

    it("should handle async validator returning ValidationOutcome", async () => {
      engine.registerRule({
        id: "async-outcome",
        name: "Async Outcome",
        description: "Async with outcome",
        type: "constraint",
        severity: "error",
        validator: async (): Promise<ValidationOutcome> => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            passed: true,
            message: "Async validation passed",
            metadata: { asyncResult: true },
          };
        },
        enabled: true,
      });

      const report = await engine.validate({});

      expect(report.results[0]!.passed).toBe(true);
      expect(report.results[0]!.message).toBe("Async validation passed");
      expect(report.results[0]!.metadata).toEqual({ asyncResult: true });
    });

    it("should run rules in parallel when configured", async () => {
      const parallelEngine = new ValidationEngine({ parallel: true });

      let executionOrder: string[] = [];

      parallelEngine.registerRule({
        id: "slow",
        name: "Slow",
        description: "Slow rule",
        type: "constraint",
        severity: "error",
        validator: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionOrder.push("slow");
          return true;
        },
        enabled: true,
      });

      parallelEngine.registerRule({
        id: "fast",
        name: "Fast",
        description: "Fast rule",
        type: "constraint",
        severity: "error",
        validator: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionOrder.push("fast");
          return true;
        },
        enabled: true,
      });

      await parallelEngine.validate({});

      // In parallel mode, fast should complete before slow
      expect(executionOrder[0]).toBe("fast");
      expect(executionOrder[1]).toBe("slow");
    });
  });

  // ==========================================================================
  // Context Tests
  // ==========================================================================

  describe("Context", () => {
    it("should pass context to validator", async () => {
      let capturedContext: ValidationContext | null = null;

      engine.registerRule({
        id: "context-rule",
        name: "Context Rule",
        description: "Captures context",
        type: "constraint",
        severity: "error",
        validator: (_data: unknown, context: ValidationContext) => {
          capturedContext = context;
          return true;
        },
        enabled: true,
      });

      await engine.validate({ testData: true }, { scope: "test-scope" });

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.sessionId).toBeDefined();
      expect(capturedContext!.timestamp).toBeDefined();
      expect(capturedContext!.data).toEqual({ testData: true });
      expect(capturedContext!.scope).toBe("test-scope");
    });

    it("should include context options in context", async () => {
      let capturedContext: ValidationContext | null = null;

      engine.registerRule({
        id: "context-options-rule",
        name: "Context Options Rule",
        description: "Checks context options",
        type: "constraint",
        severity: "error",
        validator: (_data: unknown, context: ValidationContext) => {
          capturedContext = context;
          return true;
        },
        enabled: true,
      });

      await engine.validate(
        {},
        {
          sessionId: "custom-session",
          scope: "custom-scope",
          correlationId: "corr-123",
          metadata: { key: "value" },
        }
      );

      expect(capturedContext!.sessionId).toBe("custom-session");
      expect(capturedContext!.scope).toBe("custom-scope");
      expect(capturedContext!.correlationId).toBe("corr-123");
      expect(capturedContext!.metadata).toEqual({ key: "value" });
    });

    it("should include context in report", async () => {
      engine.registerRule({
        id: "simple",
        name: "Simple",
        description: "Simple rule",
        type: "constraint",
        severity: "error",
        validator: () => true,
        enabled: true,
      });

      const report = await engine.validate(
        { data: "test" },
        { scope: "report-test" }
      );

      expect(report.context).toBeDefined();
      expect(report.context.scope).toBe("report-test");
      expect(report.context.data).toEqual({ data: "test" });
    });
  });
});
