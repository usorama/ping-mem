/**
 * Validation Engine for ping-mem
 *
 * Executes validation rules against data and generates validation reports.
 * Supports rule registration, enabling/disabling, and batch validation.
 *
 * @module validation/ValidationEngine
 * @version 1.0.0
 */

import type {
  ISOTimestamp,
} from "../types/index.js";

import type {
  ValidationEngineConfig,
  ValidationRule,
  ValidationRuleInput,
  ValidationRuleId,
  ValidationContext,
  ValidationContextOptions,
  ValidationResult,
  ValidationReport,
  ValidationSummary,
  ValidationOutcome,
} from "./types.js";

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<ValidationEngineConfig> = {
  enabled: true,
  continueOnFailure: true,
  timeoutMs: 30000,
  parallel: false,
  defaultSeverity: "error",
  includeTags: [],
  excludeTags: [],
};

// ============================================================================
// ValidationEngine Class
// ============================================================================

/**
 * Validation engine for executing rules against data
 */
export class ValidationEngine {
  private readonly config: Required<ValidationEngineConfig>;
  private rules: Map<ValidationRuleId, ValidationRule> = new Map();

  constructor(config?: Partial<ValidationEngineConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  // ==========================================================================
  // Rule Management
  // ==========================================================================

  /**
   * Register a validation rule
   * @param rule - Rule to register (id auto-generated if not provided)
   * @returns The registered rule with its ID
   */
  registerRule<T = unknown>(rule: ValidationRuleInput<T>): ValidationRule<T> {
    const ruleId = rule.id ?? crypto.randomUUID();
    
    const fullRule: ValidationRule<T> = {
      ...rule,
      id: ruleId,
    };

    this.rules.set(ruleId, fullRule as ValidationRule);
    return fullRule;
  }

  /**
   * Remove a validation rule by ID
   * @param ruleId - ID of the rule to remove
   * @returns true if rule was removed, false if not found
   */
  removeRule(ruleId: ValidationRuleId): boolean {
    return this.rules.delete(ruleId);
  }

  /**
   * Enable a validation rule
   * @param ruleId - ID of the rule to enable
   * @returns true if rule was enabled, false if not found
   */
  enableRule(ruleId: ValidationRuleId): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      return false;
    }
    rule.enabled = true;
    return true;
  }

  /**
   * Disable a validation rule
   * @param ruleId - ID of the rule to disable
   * @returns true if rule was disabled, false if not found
   */
  disableRule(ruleId: ValidationRuleId): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      return false;
    }
    rule.enabled = false;
    return true;
  }

  /**
   * Get all registered rules
   * @returns Array of all validation rules
   */
  getRules(): ValidationRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get a specific rule by ID
   * @param ruleId - ID of the rule to get
   * @returns The rule or undefined if not found
   */
  getRule(ruleId: ValidationRuleId): ValidationRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Reset the engine, clearing all rules
   */
  reset(): void {
    this.rules.clear();
  }

  // ==========================================================================
  // Validation Execution
  // ==========================================================================

  /**
   * Validate data against all enabled rules
   * @param data - Data to validate
   * @param options - Optional context options
   * @returns Validation report with all results
   */
  async validate<T = unknown>(
    data: T,
    options?: ValidationContextOptions
  ): Promise<ValidationReport> {
    const context = this.createContext(data, options);
    const rulesToRun = this.getEnabledRules();

    return this.executeValidation(data, rulesToRun, context);
  }

  /**
   * Validate data against specific rules only
   * @param data - Data to validate
   * @param ruleIds - IDs of rules to execute
   * @param options - Optional context options
   * @returns Validation report with results for specified rules
   */
  async validateWithRules<T = unknown>(
    data: T,
    ruleIds: ValidationRuleId[],
    options?: ValidationContextOptions
  ): Promise<ValidationReport> {
    const context = this.createContext(data, options);
    const rulesToRun: ValidationRule[] = [];

    for (const ruleId of ruleIds) {
      const rule = this.rules.get(ruleId);
      if (rule) {
        rulesToRun.push(rule);
      }
    }

    return this.executeValidation(data, rulesToRun, context);
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  /**
   * Get current configuration
   */
  getConfig(): Required<ValidationEngineConfig> {
    return { ...this.config };
  }

  /**
   * Check if validation is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Create a validation context
   */
  private createContext<T>(
    data: T,
    options?: ValidationContextOptions
  ): ValidationContext {
    const context: ValidationContext = {
      sessionId: options?.sessionId ?? crypto.randomUUID(),
      timestamp: new Date().toISOString() as ISOTimestamp,
      data,
    };

    // Only add optional properties if defined (exactOptionalPropertyTypes)
    if (options?.scope !== undefined) {
      context.scope = options.scope;
    }
    if (options?.correlationId !== undefined) {
      context.correlationId = options.correlationId;
    }
    if (options?.metadata !== undefined) {
      context.metadata = options.metadata;
    }

    return context;
  }

  /**
   * Get all enabled rules, filtered by tags
   */
  private getEnabledRules(): ValidationRule[] {
    const rules = Array.from(this.rules.values()).filter((rule) => rule.enabled);

    // Apply tag filters
    return rules.filter((rule) => {
      // Check include tags
      if (this.config.includeTags.length > 0) {
        const ruleTags = rule.tags ?? [];
        const hasIncludedTag = this.config.includeTags.some((tag) =>
          ruleTags.includes(tag)
        );
        if (!hasIncludedTag) {
          return false;
        }
      }

      // Check exclude tags
      if (this.config.excludeTags.length > 0) {
        const ruleTags = rule.tags ?? [];
        const hasExcludedTag = this.config.excludeTags.some((tag) =>
          ruleTags.includes(tag)
        );
        if (hasExcludedTag) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Execute validation for a set of rules
   */
  private async executeValidation<T>(
    data: T,
    rules: ValidationRule[],
    context: ValidationContext
  ): Promise<ValidationReport> {
    const startTime = Date.now();
    const results: ValidationResult[] = [];

    if (!this.config.enabled) {
      return this.createEmptyReport(context, startTime);
    }

    if (this.config.parallel) {
      // Parallel execution
      const promises = rules.map((rule) =>
        this.executeRule(data, rule, context)
      );
      const settled = await Promise.allSettled(promises);

      for (const result of settled) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        }
      }
    } else {
      // Sequential execution
      for (const rule of rules) {
        const result = await this.executeRule(data, rule, context);
        results.push(result);

        // Stop on first failure if configured
        if (!result.passed && !this.config.continueOnFailure) {
          break;
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    return this.createReport(results, context, totalDurationMs);
  }

  /**
   * Execute a single validation rule
   */
  private async executeRule<T>(
    data: T,
    rule: ValidationRule,
    context: ValidationContext
  ): Promise<ValidationResult> {
    const ruleStartTime = Date.now();

    try {
      // Execute the validator
      const validatorResult = await Promise.race([
        Promise.resolve(rule.validator(data, context)),
        this.createTimeout(rule.id),
      ]);

      const durationMs = Date.now() - ruleStartTime;

      // Handle boolean result vs ValidationOutcome
      if (typeof validatorResult === "boolean") {
        return {
          ruleId: rule.id,
          ruleName: rule.name,
          passed: validatorResult,
          message: validatorResult
            ? `Validation passed: ${rule.name}`
            : `Validation failed: ${rule.description}`,
          severity: rule.severity,
          timestamp: new Date().toISOString() as ISOTimestamp,
          durationMs,
        };
      }

      // It's a ValidationOutcome
      const outcome = validatorResult as ValidationOutcome;
      const result: ValidationResult = {
        ruleId: rule.id,
        ruleName: rule.name,
        passed: outcome.passed,
        message: outcome.message ?? (outcome.passed
          ? `Validation passed: ${rule.name}`
          : `Validation failed: ${rule.description}`),
        severity: rule.severity,
        timestamp: new Date().toISOString() as ISOTimestamp,
        durationMs,
      };

      // Only add metadata if defined (exactOptionalPropertyTypes)
      if (outcome.metadata !== undefined) {
        result.metadata = outcome.metadata;
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - ruleStartTime;
      const err = error instanceof Error ? error : new Error(String(error));

      return {
        ruleId: rule.id,
        ruleName: rule.name,
        passed: false,
        message: `Rule execution error: ${err.message}`,
        severity: rule.severity,
        timestamp: new Date().toISOString() as ISOTimestamp,
        durationMs,
        metadata: {
          error: {
            name: err.name,
            message: err.message,
            stack: err.stack,
          },
        },
      };
    }
  }

  /**
   * Create a timeout promise for rule execution
   */
  private createTimeout(ruleId: ValidationRuleId): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Validation timeout for rule: ${ruleId}`));
      }, this.config.timeoutMs);
    });
  }

  /**
   * Create a validation report from results
   */
  private createReport(
    results: ValidationResult[],
    context: ValidationContext,
    totalDurationMs: number
  ): ValidationReport {
    const summary = this.calculateSummary(results);
    const score = this.calculateScore(summary);

    return {
      results,
      summary,
      score,
      timestamp: new Date().toISOString() as ISOTimestamp,
      context,
      totalDurationMs,
      valid: summary.failed === 0,
    };
  }

  /**
   * Calculate summary statistics from results
   */
  private calculateSummary(results: ValidationResult[]): ValidationSummary {
    let passed = 0;
    let failed = 0;
    let warnings = 0;
    let infos = 0;

    for (const result of results) {
      if (result.passed) {
        passed++;
      } else {
        failed++;
      }

      // Count by severity
      if (!result.passed) {
        switch (result.severity) {
          case "warning":
            warnings++;
            break;
          case "info":
            infos++;
            break;
          // errors are counted in failed
        }
      }
    }

    return {
      total: results.length,
      passed,
      failed,
      warnings,
      infos,
      skipped: 0, // Skipped rules are not included in results
    };
  }

  /**
   * Calculate validation score (0-100)
   */
  private calculateScore(summary: ValidationSummary): number {
    if (summary.total === 0) {
      return 100;
    }

    // Base score from pass rate
    const passRate = summary.passed / summary.total;
    let score = passRate * 100;

    // Penalize warnings (-5 each, max -20)
    const warningPenalty = Math.min(summary.warnings * 5, 20);
    score -= warningPenalty;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Create an empty report when validation is disabled
   */
  private createEmptyReport(
    context: ValidationContext,
    startTime: number
  ): ValidationReport {
    return {
      results: [],
      summary: this.createEmptySummary(),
      score: 100,
      timestamp: new Date().toISOString() as ISOTimestamp,
      context,
      totalDurationMs: Date.now() - startTime,
      valid: true,
    };
  }

  /**
   * Create empty summary statistics
   */
  private createEmptySummary(): ValidationSummary {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      warnings: 0,
      infos: 0,
      skipped: 0,
    };
  }
}

// ============================================================================
// Export Default Instance Factory
// ============================================================================

/**
 * Create a new ValidationEngine instance
 */
export function createValidationEngine(
  config?: Partial<ValidationEngineConfig>
): ValidationEngine {
  return new ValidationEngine(config);
}
