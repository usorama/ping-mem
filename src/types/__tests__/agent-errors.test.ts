/**
 * Tests for multi-agent error classes.
 *
 * Each error class extends PingMemError and carries a unique code,
 * descriptive message, fix suggestion, and context object.
 *
 * @module types/__tests__/agent-errors.test
 */

import { describe, it, expect } from "bun:test";
import { PingMemError, createAgentId } from "../index.js";
import {
  QuotaExhaustedError,
  WriteLockConflictError,
  ScopeViolationError,
  SchemaValidationError,
  EvidenceGateRejectionError,
  AgentNotRegisteredError,
} from "../agent-errors.js";

// ============================================================================
// Tests
// ============================================================================

describe("Agent Error Classes", () => {
  // --------------------------------------------------------------------------
  // QuotaExhaustedError
  // --------------------------------------------------------------------------

  describe("QuotaExhaustedError", () => {
    it("has correct code and descriptive message for bytes quota", () => {
      const agentId = createAgentId("agent-1");
      const err = new QuotaExhaustedError(agentId, "bytes", 1024, 512);

      expect(err.code).toBe("QUOTA_EXHAUSTED");
      expect(err.message).toContain("agent-1");
      expect(err.message).toContain("bytes");
      expect(err.message).toContain("1024");
      expect(err.message).toContain("512");
      expect(err.name).toBe("QuotaExhaustedError");
      expect(err.fix).toContain("byte quota");
    });

    it("has correct message for count quota", () => {
      const agentId = createAgentId("agent-2");
      const err = new QuotaExhaustedError(agentId, "count", 100, 50);

      expect(err.message).toContain("count");
      expect(err.message).toContain("entries");
      expect(err.fix).toContain("entry count quota");
    });

    it("is an instance of PingMemError", () => {
      const agentId = createAgentId("agent-3");
      const err = new QuotaExhaustedError(agentId, "bytes", 10, 5);

      expect(err).toBeInstanceOf(PingMemError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  // --------------------------------------------------------------------------
  // WriteLockConflictError
  // --------------------------------------------------------------------------

  describe("WriteLockConflictError", () => {
    it("is instanceof PingMemError and Error", () => {
      const holder = createAgentId("holder-agent");
      const requester = createAgentId("requester-agent");
      const err = new WriteLockConflictError("my-key", holder, requester);

      expect(err).toBeInstanceOf(PingMemError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("WRITE_LOCK_CONFLICT");
      expect(err.name).toBe("WriteLockConflictError");
    });

    it("includes key, holding agent, and requesting agent in message", () => {
      const holder = createAgentId("holder");
      const requester = createAgentId("requester");
      const err = new WriteLockConflictError("config:theme", holder, requester);

      expect(err.message).toContain("config:theme");
      expect(err.message).toContain("holder");
      expect(err.message).toContain("requester");
    });

    it("has a fix suggestion", () => {
      const holder = createAgentId("a");
      const requester = createAgentId("b");
      const err = new WriteLockConflictError("k", holder, requester);

      expect(err.fix).toBeTruthy();
      expect(err.fix.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // ScopeViolationError
  // --------------------------------------------------------------------------

  describe("ScopeViolationError", () => {
    it("preserves context fields for scope violation details", () => {
      const agentId = createAgentId("reader-agent");
      const err = new ScopeViolationError(agentId, "secret-key", "private", "shared");

      expect(err.code).toBe("SCOPE_VIOLATION");
      expect(err.name).toBe("ScopeViolationError");
      expect(err.context).toBeDefined();
      expect(err.context?.["agentId"]).toBe("reader-agent");
      expect(err.context?.["memoryKey"]).toBe("secret-key");
      expect(err.context?.["requiredScope"]).toBe("private");
      expect(err.context?.["agentScope"]).toBe("shared");
    });

    it("message describes the access violation", () => {
      const agentId = createAgentId("agent-x");
      const err = new ScopeViolationError(agentId, "data", "private", "public");

      expect(err.message).toContain("agent-x");
      expect(err.message).toContain("data");
      expect(err.message).toContain("private");
      expect(err.message).toContain("public");
    });

    it("is instanceof PingMemError", () => {
      const agentId = createAgentId("a");
      const err = new ScopeViolationError(agentId, "k", "private", "shared");

      expect(err).toBeInstanceOf(PingMemError);
    });
  });

  // --------------------------------------------------------------------------
  // SchemaValidationError
  // --------------------------------------------------------------------------

  describe("SchemaValidationError", () => {
    it("includes schema name and all issues in message", () => {
      const issues = [
        { path: "name", message: "Required" },
        { path: "age", message: "Expected number, received string" },
      ];
      const err = new SchemaValidationError("UserInput", issues);

      expect(err.code).toBe("SCHEMA_VALIDATION_FAILED");
      expect(err.message).toContain("UserInput");
      expect(err.message).toContain("name");
      expect(err.message).toContain("Required");
      expect(err.message).toContain("age");
    });

    it("is instanceof PingMemError", () => {
      const err = new SchemaValidationError("Test", []);

      expect(err).toBeInstanceOf(PingMemError);
    });
  });

  // --------------------------------------------------------------------------
  // EvidenceGateRejectionError
  // --------------------------------------------------------------------------

  describe("EvidenceGateRejectionError", () => {
    it("includes agentId, key, and reason in message", () => {
      const agentId = createAgentId("fact-checker");
      const err = new EvidenceGateRejectionError(agentId, "claim-key", "no source provided");

      expect(err.code).toBe("EVIDENCE_GATE_REJECTED");
      expect(err.message).toContain("fact-checker");
      expect(err.message).toContain("claim-key");
      expect(err.message).toContain("no source provided");
    });

    it("is instanceof PingMemError", () => {
      const agentId = createAgentId("a");
      const err = new EvidenceGateRejectionError(agentId, "k", "reason");

      expect(err).toBeInstanceOf(PingMemError);
    });
  });

  // --------------------------------------------------------------------------
  // AgentNotRegisteredError
  // --------------------------------------------------------------------------

  describe("AgentNotRegisteredError", () => {
    it("includes agentId in message", () => {
      const agentId = createAgentId("unregistered-bot");
      const err = new AgentNotRegisteredError(agentId);

      expect(err.code).toBe("AGENT_NOT_REGISTERED");
      expect(err.name).toBe("AgentNotRegisteredError");
      expect(err.message).toContain("unregistered-bot");
    });

    it("has correct context with agentId", () => {
      const agentId = createAgentId("bot-99");
      const err = new AgentNotRegisteredError(agentId);

      expect(err.context).toBeDefined();
      expect(err.context?.["agentId"]).toBe("bot-99");
    });

    it("is instanceof PingMemError and Error", () => {
      const agentId = createAgentId("test-agent");
      const err = new AgentNotRegisteredError(agentId);

      expect(err).toBeInstanceOf(PingMemError);
      expect(err).toBeInstanceOf(Error);
    });

    it("has a fix suggestion mentioning registration", () => {
      const agentId = createAgentId("new-agent");
      const err = new AgentNotRegisteredError(agentId);

      expect(err.fix).toContain("Register");
    });
  });
});
