/**
 * Multi-Agent Error Classes for ping-mem
 *
 * Six domain-specific error classes extending PingMemError,
 * each with a unique code, descriptive message, fix suggestion, and context object.
 *
 * @module types/agent-errors
 */

import { PingMemError, type AgentId } from "./index.js";

// ============================================================================
// Quota Errors
// ============================================================================

/**
 * Thrown when an agent exceeds its allocated memory quota (bytes or count).
 */
export class QuotaExhaustedError extends PingMemError {
  public readonly fix: string;

  constructor(
    agentId: AgentId,
    quotaType: "bytes" | "count",
    current: number,
    limit: number
  ) {
    const unit = quotaType === "bytes" ? "bytes" : "entries";
    super(
      `Agent "${agentId}" exceeded ${quotaType} quota: ${current}/${limit} ${unit}`,
      "QUOTA_EXHAUSTED",
      { agentId, quotaType, current, limit }
    );
    this.name = "QuotaExhaustedError";
    this.fix =
      quotaType === "bytes"
        ? "Delete unused memories or request a higher byte quota from an admin agent."
        : "Delete unused memories or request a higher entry count quota from an admin agent.";
  }
}

// ============================================================================
// Concurrency Errors
// ============================================================================

/**
 * Thrown when a write operation conflicts with an existing write lock
 * held by another agent on the same memory key.
 */
export class WriteLockConflictError extends PingMemError {
  public readonly fix: string;

  constructor(
    key: string,
    holdingAgentId: AgentId,
    requestingAgentId: AgentId
  ) {
    super(
      `Write lock conflict on key "${key}": held by agent "${holdingAgentId}", requested by "${requestingAgentId}"`,
      "WRITE_LOCK_CONFLICT",
      { key, holdingAgentId, requestingAgentId }
    );
    this.name = "WriteLockConflictError";
    this.fix =
      "Retry after the lock expires, or coordinate with the holding agent to release the lock.";
  }
}

// ============================================================================
// Access Control Errors
// ============================================================================

/**
 * Thrown when an agent attempts to read or write a memory outside its
 * permitted scope (private/role/shared/public).
 */
export class ScopeViolationError extends PingMemError {
  public readonly fix: string;

  constructor(
    agentId: AgentId,
    memoryKey: string,
    requiredScope: string,
    agentScope: string
  ) {
    super(
      `Agent "${agentId}" cannot access memory "${memoryKey}": requires scope "${requiredScope}", agent has "${agentScope}"`,
      "SCOPE_VIOLATION",
      { agentId, memoryKey, requiredScope, agentScope }
    );
    this.name = "ScopeViolationError";
    this.fix =
      "Request access from the memory owner, or save the memory with a broader scope (e.g. 'shared' or 'public').";
  }
}

// ============================================================================
// Validation Errors
// ============================================================================

/**
 * Thrown when input data fails Zod or structural schema validation.
 */
export class SchemaValidationError extends PingMemError {
  public readonly fix: string;

  constructor(
    schemaName: string,
    issues: ReadonlyArray<{ path: string; message: string }>
  ) {
    const summary = issues
      .map((i) => `  - ${i.path}: ${i.message}`)
      .join("\n");
    super(
      `Schema validation failed for "${schemaName}":\n${summary}`,
      "SCHEMA_VALIDATION_FAILED",
      { schemaName, issues }
    );
    this.name = "SchemaValidationError";
    this.fix =
      "Check the request payload against the expected schema and fix the listed field errors.";
  }
}

// ============================================================================
// Evidence Gate Errors
// ============================================================================

/**
 * Thrown when a memory save is rejected by the evidence gate
 * (e.g. missing source, unverified claim, or low confidence).
 */
export class EvidenceGateRejectionError extends PingMemError {
  public readonly fix: string;

  constructor(
    agentId: AgentId,
    memoryKey: string,
    reason: string
  ) {
    super(
      `Evidence gate rejected memory "${memoryKey}" from agent "${agentId}": ${reason}`,
      "EVIDENCE_GATE_REJECTED",
      { agentId, memoryKey, reason }
    );
    this.name = "EvidenceGateRejectionError";
    this.fix =
      "Provide a verifiable source or evidence in the memory metadata, or lower the evidence gate threshold.";
  }
}

// ============================================================================
// Registration Errors
// ============================================================================

/**
 * Thrown when an operation references an agent that has not been registered
 * (or whose registration has expired).
 */
export class AgentNotRegisteredError extends PingMemError {
  public readonly fix: string;

  constructor(agentId: AgentId) {
    super(
      `Agent "${agentId}" is not registered or registration has expired`,
      "AGENT_NOT_REGISTERED",
      { agentId }
    );
    this.name = "AgentNotRegisteredError";
    this.fix =
      "Register the agent via the agent registration endpoint before performing memory operations.";
  }
}
