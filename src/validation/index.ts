/**
 * Validation module exports
 *
 * @module validation
 */

export { ValidationEngine, createValidationEngine } from "./ValidationEngine.js";

export type {
  ValidationRuleType,
  ValidationSeverity,
  ValidationRuleId,
  ValidatorFunction,
  ValidatorWithMessage,
  ValidationOutcome,
  ValidationRule,
  ValidationRuleInput,
  ValidationContext,
  ValidationContextOptions,
  ValidationResult,
  ValidationError,
  ValidationSummary,
  ValidationReport,
  ValidationEngineConfig,
  ValidationEvent,
  ValidationStartedEvent,
  RuleValidatedEvent,
  ValidationCompletedEvent,
  ValidationFailedEvent,
  ValidationEventType,
} from "./types.js";
