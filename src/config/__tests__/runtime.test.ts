/**
 * Tests for runtime configuration loader.
 *
 * loadRuntimeConfig() reads env vars and returns a RuntimeConfig object.
 * createRuntimeServices() uses that config to create Neo4j/Qdrant services.
 *
 * We test loadRuntimeConfig() directly (pure function of env vars).
 * For createRuntimeServices(), we mock the external clients to avoid
 * real network connections.
 *
 * @module config/__tests__/runtime.test
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { loadRuntimeConfig, type RuntimeConfig } from "../runtime.js";

// ============================================================================
// Helpers
// ============================================================================

function snapshotEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

function clearRuntimeEnv(): void {
  const keys = Object.keys(process.env).filter(
    (k) =>
      k.startsWith("PING_MEM_") ||
      k.startsWith("NEO4J_") ||
      k.startsWith("QDRANT_")
  );
  for (const key of keys) {
    delete process.env[key];
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("loadRuntimeConfig", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = snapshotEnv();
    clearRuntimeEnv();
  });

  afterEach(() => {
    // Restore env
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
  // Minimal config (SQLite-only)
  // --------------------------------------------------------------------------

  it("creates config with defaults when no env vars are set", () => {
    const config = loadRuntimeConfig();

    expect(config.pingMem.dbPath).toBe(":memory:");
    expect(config.neo4j).toBeUndefined();
    expect(config.qdrant).toBeUndefined();
  });

  it("uses PING_MEM_DB_PATH when provided", () => {
    process.env["PING_MEM_DB_PATH"] = "/tmp/test.db";

    const config = loadRuntimeConfig();

    expect(config.pingMem.dbPath).toBe("/tmp/test.db");
  });

  // --------------------------------------------------------------------------
  // Neo4j config
  // --------------------------------------------------------------------------

  it("includes neo4j config when all three env vars are set", () => {
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    process.env["NEO4J_USERNAME"] = "neo4j";
    process.env["NEO4J_PASSWORD"] = "password";

    const config = loadRuntimeConfig();

    expect(config.neo4j).toBeDefined();
    expect(config.neo4j?.uri).toBe("bolt://localhost:7687");
    expect(config.neo4j?.username).toBe("neo4j");
    expect(config.neo4j?.password).toBe("password");
  });

  it("omits neo4j config when only partial env vars are set", () => {
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    // Missing NEO4J_USERNAME and NEO4J_PASSWORD

    const config = loadRuntimeConfig();

    expect(config.neo4j).toBeUndefined();
  });

  it("supports NEO4J_USER as alternative to NEO4J_USERNAME", () => {
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    process.env["NEO4J_USER"] = "neo4j";
    process.env["NEO4J_PASSWORD"] = "password";

    const config = loadRuntimeConfig();

    expect(config.neo4j).toBeDefined();
    expect(config.neo4j?.username).toBe("neo4j");
  });

  it("prefers NEO4J_USERNAME over NEO4J_USER when both are set", () => {
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    process.env["NEO4J_USERNAME"] = "primary-user";
    process.env["NEO4J_USER"] = "fallback-user";
    process.env["NEO4J_PASSWORD"] = "password";

    const config = loadRuntimeConfig();

    expect(config.neo4j).toBeDefined();
    expect(config.neo4j?.username).toBe("primary-user");
  });

  it("includes optional neo4j database and pool size", () => {
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    process.env["NEO4J_USERNAME"] = "neo4j";
    process.env["NEO4J_PASSWORD"] = "password";
    process.env["NEO4J_DATABASE"] = "mydb";
    process.env["NEO4J_MAX_POOL_SIZE"] = "50";

    const config = loadRuntimeConfig();

    expect(config.neo4j?.database).toBe("mydb");
    expect(config.neo4j?.maxConnectionPoolSize).toBe(50);
  });

  // --------------------------------------------------------------------------
  // Qdrant config
  // --------------------------------------------------------------------------

  it("includes qdrant config when url and collection are set", () => {
    process.env["QDRANT_URL"] = "http://localhost:6333";
    process.env["QDRANT_COLLECTION_NAME"] = "test-vectors";

    const config = loadRuntimeConfig();

    expect(config.qdrant).toBeDefined();
    expect(config.qdrant?.url).toBe("http://localhost:6333");
    expect(config.qdrant?.collectionName).toBe("test-vectors");
  });

  it("omits qdrant config when only url is set without collection", () => {
    process.env["QDRANT_URL"] = "http://localhost:6333";
    // Missing QDRANT_COLLECTION_NAME

    const config = loadRuntimeConfig();

    expect(config.qdrant).toBeUndefined();
  });

  it("includes optional qdrant api key and vector dimensions", () => {
    process.env["QDRANT_URL"] = "http://localhost:6333";
    process.env["QDRANT_COLLECTION_NAME"] = "test-vectors";
    process.env["QDRANT_API_KEY"] = "qdrant-key";
    process.env["QDRANT_VECTOR_DIMENSIONS"] = "1536";

    const config = loadRuntimeConfig();

    expect(config.qdrant?.apiKey).toBe("qdrant-key");
    expect(config.qdrant?.vectorDimensions).toBe(1536);
  });

  // --------------------------------------------------------------------------
  // Full config
  // --------------------------------------------------------------------------

  it("returns full config when all services are configured", () => {
    process.env["PING_MEM_DB_PATH"] = "/data/ping-mem.db";
    process.env["NEO4J_URI"] = "bolt://localhost:7687";
    process.env["NEO4J_USERNAME"] = "neo4j";
    process.env["NEO4J_PASSWORD"] = "password";
    process.env["QDRANT_URL"] = "http://localhost:6333";
    process.env["QDRANT_COLLECTION_NAME"] = "vectors";

    const config = loadRuntimeConfig();

    expect(config.pingMem.dbPath).toBe("/data/ping-mem.db");
    expect(config.neo4j).toBeDefined();
    expect(config.qdrant).toBeDefined();
  });
});
