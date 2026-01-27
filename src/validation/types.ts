/**
 * Validation Types for ping-mem
 *
 * Defines types for automated validation including rules, contexts,
 * results, and reports for the ValidationEngine.
 *
 * @module validation/types
 * @version 1.0.0
 */

import type { ISOTimestamp } from "../types/index.js";

// ============================================================================
// Core Validation Enums
// ============================================================================

/**
 * Type of validation rule
 */
export type ValidationRuleType = "schema" | "constraint" | "business";

/**
 * Severity level for validation results
 */
export type ValidationSeverity = "error" | "warning" | "info";

// ============================================================================
// Validation Rule Types
// ============================================================================

/**
 * Validation rule identifier
 */
export type ValidationRuleId = string;

/**
 * Function signature for a validator
 * Returns true if validation passes, false otherwise
 */
export type ValidatorFunction<T = unknown> = (
  data: T,
  context: ValidationContext
) => boolean | Promise<boolean>;

/**
 * Function signature for a validator with custom message
 */
export type ValidatorWithMessage<T = unknown> = (
  data: T,
  context: ValidationContext
) => ValidationOutcome | Promise<ValidationOutcome>;

/**
 * Outcome from a validator function with custom message support
 */
export interface ValidationOutcome {
  /** Whether validation passed */
  passed: boolean;
  /** Custom message (overrides rule default if provided) */
  message?: string;
  /** Additional metadata from validation */
  metadata?: Record<string, unknown>;
}

/**
 * Validation rule definition
 */
export interface ValidationRule<T = unknown> {
  /** Unique identifier for the rule */
  id: ValidationRuleId;
  /** Human-readable name */
  name: string;
  /** Detailed description of what the rule validates */
  description: string;
  /** Type of validation */
  type: ValidationRuleType;
  /** Severity when rule fails */
  severity: ValidationSeverity;
  /** Validator function */
  validator: ValidatorFunction<T> | ValidatorWithMessage<T>;
  /** Whether the rule is enabled */
  enabled: boolean;
  /** Tags for categorization and filtering */
  tags?: string[];
  /** Optional configuration for the rule */
  config?: Record<string, unknown>;
}

/**
 * Simplified rule for registration (id auto-generated)
 */
export interface ValidationRuleInput<T = unknown>
  extends Omit<ValidationRule<T>, "id"> {
  /** Optional custom ID (auto-generated if not provided) */
  id?: ValidationRuleId;
}

// ============================================================================
// Validation Context Types
// ============================================================================

/**
 * Context provided to validators during validation
 */
export interface ValidationContext {
  /** Session ID for tracking */
  sessionId: string;
  /** Timestamp when validation started */
  timestamp: ISOTimestamp;
  /** Data being validated (type-erased for context) */
  data: unknown;
  /** Optional validation scope identifier */
  scope?: string;
  /** Optional correlation ID for tracing */
  correlationId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a validation context
 */
export interface ValidationContextOptions {
  /** Session ID (auto-generated if not provided) */
  sessionId?: string;
  /** Validation scope */
  scope?: string;
  /** Correlation ID */
  correlationId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * Result from a single validation rule execution
 */
export interface ValidationResult {
  /** ID of the rule that was executed */
  ruleId: ValidationRuleId;
  /** Name of the rule for readability */
  ruleName: string;
  /** Whether validation passed */
  passed: boolean;
  /** Result message */
  message: string;
  /** Severity of this result */
  severity: ValidationSeverity;
  /** Timestamp of validation */
  timestamp: ISOTimestamp;
  /** Duration of validation in milliseconds */
  durationMs?: number;
  /** Additional metadata from validation */
  metadata?: Record<string, unknown>;
}

/**
 * Validation result with error information
 */
export interface ValidationError extends ValidationResult {
  passed: false;
  /** Error details if validation threw an exception */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

// ============================================================================
// Validation Report Types
// ============================================================================

/**
 * Summary statistics for a validation report
 */
export interface ValidationSummary {
  /** Total number of rules executed */
  total: number;
  /** Number of rules that passed */
  passed: number;
  /** Number of rules that failed */
  failed: number;
  /** Number of warnings */
  warnings: number;
  /** Number of info-level results */
  infos: number;
  /** Number of rules that were skipped */
  skipped: number;
}

/**
 * Complete validation report
 */
export interface ValidationReport {
  /** All validation results */
  results: ValidationResult[];
  /** Summary statistics */
  summary: ValidationSummary;
  /** Overall validation score (0-100) */
  score: number;
  /** Timestamp when report was generated */
  timestamp: ISOTimestamp;
  /** Context that was validated */
  context: ValidationContext;
  /** Total duration of all validations in milliseconds */
  totalDurationMs: number;
  /** Whether all required validations passed (no errors) */
  valid: boolean;
}

// ============================================================================
// Validation Engine Configuration
// ============================================================================

/**
 * Configuration for the ValidationEngine
 */
export interface ValidationEngineConfig {
  /** Enable validation (default: true) */
  enabled?: boolean;
  /** Continue validation after first failure (default: true) */
  continueOnFailure?: boolean;
  /** Maximum validation duration in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Enable parallel validation where possible (default: false) */
  parallel?: boolean;
  /** Default severity for rules without explicit severity */
  defaultSeverity?: ValidationSeverity;
  /** Tags to filter rules (only run rules with these tags) */
  includeTags?: string[];
  /** Tags to exclude (skip rules with these tags) */
  excludeTags?: string[];
}

// ============================================================================
// Validation Events for Event Sourcing
// ============================================================================

/**
 * Base validation event
 */
export interface ValidationEvent {
  type: string;
  timestamp: ISOTimestamp;
  sessionId?: string;
}

/**
 * Event when validation starts
 */
export interface ValidationStartedEvent extends ValidationEvent {
  type: "VALIDATION_STARTED";
  context: ValidationContext;
  ruleCount: number;
}

/**
 * Event when a single rule completes
 */
export interface RuleValidatedEvent extends ValidationEvent {
  type: "RULE_VALIDATED";
  result: ValidationResult;
}

/**
 * Event when validation completes
 */
export interface ValidationCompletedEvent extends ValidationEvent {
  type: "VALIDATION_COMPLETED";
  report: ValidationReport;
}

/**
 * Event when validation fails with an error
 */
export interface ValidationFailedEvent extends ValidationEvent {
  type: "VALIDATION_FAILED";
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  partialResults?: ValidationResult[];
}

/**
 * All validation event types
 */
export type ValidationEventType =
  | ValidationStartedEvent
  | RuleValidatedEvent
  | ValidationCompletedEvent
  | ValidationFailedEvent;
