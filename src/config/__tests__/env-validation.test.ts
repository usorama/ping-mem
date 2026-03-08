/**
 * Tests for env-validation module.
 *
 * validateEnv() reads process.env, validates with Zod, runs consistency checks,
 * and calls process.exit(1) on failure. We mock process.exit to prevent the
 * test runner from dying.
 *
 * @module config/__tests__/env-validation.test
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { validateEnv } from "../env-validation.js";

// ============================================================================
// Helpers
// ============================================================================

/** Snapshot the current process.env so we can restore it after each test. */
function snapshotEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/** Wipe all ping-mem / Neo4j / Qdrant env vars so tests start clean. */
function clearRelevantEnv(): void {
  const keys = Object.keys(process.env).filter(
    (k) =>
      k.startsWith("PING_MEM_") ||
      k.startsWith("NEO4J_") ||
      k.startsWith("QDRANT_") ||
      k === "OPENAI_API_KEY"
  );
  for (const key of keys) {
    delete process.env[key];
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("validateEnv", () => {
  let originalEnv: Record<string, string | undefined>;
  let exitMock: ReturnType<typeof mock>;
  const originalExit = process.exit;

  beforeEach(() => {
    originalEnv = snapshotEnv();
    clearRelevantEnv();
    // Mock process.exit to throw instead of killing the process
    exitMock = mock((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    process.exit = exitMock as unknown as (code?: number) => never;
  });

  afterEach(() => {
    // Restore original process.exit
    process.exit = originalExit;

    // Restore original process.env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  it("accepts valid complete config with all env vars set", () => {
    process.env["PING_MEM_DB_PATH"] = "/tmp/test.db";
    process.env["PING_MEM_PORT"] = "3000";
    process.env["PING_MEM_HOST"] = "0.0.0.0";
    process.env["PING_MEM_TRANSPORT"] = "rest";
    process.env["PING_MEM_API_KEY"] = "test-key";
    process.env["PING_MEM_ADMIN_USER"] = "admin";
    process.env["PING_MEM_ADMIN_PASS"] = "secret";
    process.env["PING_MEM_SECRET_KEY"] = "encryption-key";
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    process.env["NEO4J_USERNAME"] = "neo4j";
    process.env["NEO4J_PASSWORD"] = "password";
    process.env["QDRANT_URL"] = "http://localhost:6333";
    process.env["QDRANT_COLLECTION_NAME"] = "test-collection";
    process.env["QDRANT_VECTOR_DIMENSIONS"] = "768";
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["PING_MEM_MAX_AGENTS"] = "50";

    expect(() => validateEnv()).not.toThrow();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("accepts minimal config with no env vars set", () => {
    // All env vars are optional; empty env should be valid
    expect(() => validateEnv()).not.toThrow();
    expect(exitMock).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Port validation
  // --------------------------------------------------------------------------

  it("rejects invalid port number (0)", () => {
    process.env["PING_MEM_PORT"] = "0";

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("rejects invalid port number (99999)", () => {
    process.env["PING_MEM_PORT"] = "99999";

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("rejects non-numeric port", () => {
    process.env["PING_MEM_PORT"] = "abc";

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  // --------------------------------------------------------------------------
  // Transport validation
  // --------------------------------------------------------------------------

  it("rejects invalid transport value", () => {
    process.env["PING_MEM_TRANSPORT"] = "websocket";

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  // --------------------------------------------------------------------------
  // Consistency: admin user/pass pairing
  // --------------------------------------------------------------------------

  it("rejects admin user without admin pass", () => {
    process.env["PING_MEM_ADMIN_USER"] = "admin";
    // PING_MEM_ADMIN_PASS intentionally not set

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("rejects admin pass without admin user", () => {
    process.env["PING_MEM_ADMIN_PASS"] = "secret";
    // PING_MEM_ADMIN_USER intentionally not set

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  // --------------------------------------------------------------------------
  // Consistency: Neo4j triplet
  // --------------------------------------------------------------------------

  it("rejects partial Neo4j config (URI only)", () => {
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    // NEO4J_USERNAME and NEO4J_PASSWORD intentionally not set

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("rejects partial Neo4j config (URI + username, no password)", () => {
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    process.env["NEO4J_USERNAME"] = "neo4j";
    // NEO4J_PASSWORD intentionally not set

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("accepts complete Neo4j triplet", () => {
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    process.env["NEO4J_USERNAME"] = "neo4j";
    process.env["NEO4J_PASSWORD"] = "password";

    expect(() => validateEnv()).not.toThrow();
    expect(exitMock).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Numeric field validation
  // --------------------------------------------------------------------------

  it("rejects negative PING_MEM_MAX_AGENTS", () => {
    process.env["PING_MEM_MAX_AGENTS"] = "-1";

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("rejects non-integer QDRANT_VECTOR_DIMENSIONS", () => {
    process.env["QDRANT_VECTOR_DIMENSIONS"] = "3.14";

    expect(() => validateEnv()).toThrow("process.exit(1)");
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
