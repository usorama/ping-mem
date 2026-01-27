/**
 * Tests for Neo4jClient
 *
 * @module graph/__tests__/Neo4jClient.test
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Neo4jClient,
  Neo4jClientError,
  Neo4jConnectionError,
  Neo4jQueryError,
  createNeo4jClient,
  createNeo4jClientFromEnv,
} from "../Neo4jClient.js";
import type { Neo4jClientConfig } from "../Neo4jClient.js";

// ============================================================================
// Test Configuration
// ============================================================================

const testConfig: Neo4jClientConfig = {
  uri: "bolt://localhost:7687",
  username: "neo4j",
  password: "testpassword",
  database: "testdb",
  maxConnectionPoolSize: 10,
};

// ============================================================================
// Unit Tests (No Connection Required)
// ============================================================================

describe("Neo4jClient - Unit Tests", () => {
  describe("Configuration", () => {
    it("should accept required configuration", () => {
      const minimalConfig: Neo4jClientConfig = {
        uri: "bolt://localhost:7687",
        username: "neo4j",
        password: "password",
      };
      const client = new Neo4jClient(minimalConfig);
      expect(client).toBeInstanceOf(Neo4jClient);
    });

    it("should use default values for optional config", () => {
      const minimalConfig: Neo4jClientConfig = {
        uri: "bolt://localhost:7687",
        username: "neo4j",
        password: "password",
      };
      const client = new Neo4jClient(minimalConfig);
      expect(client).toBeInstanceOf(Neo4jClient);
      // Default database is 'neo4j', maxConnectionPoolSize is 50
    });

    it("should override default values with provided config", () => {
      const client = new Neo4jClient(testConfig);
      expect(client).toBeInstanceOf(Neo4jClient);
    });

    it("should accept encrypted option", () => {
      const encryptedConfig: Neo4jClientConfig = {
        ...testConfig,
        encrypted: true,
      };
      const client = new Neo4jClient(encryptedConfig);
      expect(client).toBeInstanceOf(Neo4jClient);
    });
  });

  describe("Connection State (Before Connect)", () => {
    it("should not be connected initially", () => {
      const client = new Neo4jClient(testConfig);
      expect(client.isConnected()).toBe(false);
    });

    it("should throw when getting session without connection", () => {
      const client = new Neo4jClient(testConfig);
      expect(() => client.getSession()).toThrow(Neo4jConnectionError);
      expect(() => client.getSession()).toThrow(
        "Not connected to Neo4j. Call connect() first."
      );
    });

    it("should throw when getting driver without connection", () => {
      const client = new Neo4jClient(testConfig);
      expect(() => client.getDriver()).toThrow(Neo4jConnectionError);
      expect(() => client.getDriver()).toThrow(
        "Not connected to Neo4j. Call connect() first."
      );
    });

    it("should return false when pinging without connection", async () => {
      const client = new Neo4jClient(testConfig);
      const result = await client.ping();
      expect(result).toBe(false);
    });

    it("should handle disconnect when not connected", async () => {
      const client = new Neo4jClient(testConfig);
      // disconnect() should not throw when not connected
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });
  });
});

describe("Error Classes", () => {
  describe("Neo4jClientError", () => {
    it("should have correct name and message", () => {
      const error = new Neo4jClientError("Something failed", "N0000");
      expect(error.name).toBe("Neo4jClientError");
      expect(error.message).toBe("Something failed");
      expect(error.code).toBe("N0000");
    });

    it("should handle undefined code", () => {
      const error = new Neo4jClientError("Something failed");
      expect(error.code).toBeUndefined();
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new Neo4jClientError("Something failed", undefined, cause);
      expect(error.cause).toBe(cause);
    });

    it("should be instanceof Error", () => {
      const error = new Neo4jClientError("Test");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("Neo4jConnectionError", () => {
    it("should have correct name and message", () => {
      const error = new Neo4jConnectionError("Connection failed", "N0001");
      expect(error.name).toBe("Neo4jConnectionError");
      expect(error.message).toBe("Connection failed");
      expect(error.code).toBe("N0001");
    });

    it("should be instanceof Neo4jClientError", () => {
      const error = new Neo4jConnectionError("Test");
      expect(error).toBeInstanceOf(Neo4jClientError);
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new Neo4jConnectionError("Connection failed", undefined, cause);
      expect(error.cause).toBe(cause);
    });
  });

  describe("Neo4jQueryError", () => {
    it("should have correct name, message, query, and params", () => {
      const error = new Neo4jQueryError(
        "Query failed",
        "MATCH (n) RETURN n",
        { limit: 10 },
        "N0002"
      );
      expect(error.name).toBe("Neo4jQueryError");
      expect(error.message).toBe("Query failed");
      expect(error.query).toBe("MATCH (n) RETURN n");
      expect(error.params).toEqual({ limit: 10 });
      expect(error.code).toBe("N0002");
    });

    it("should handle undefined params", () => {
      const error = new Neo4jQueryError("Query failed", "MATCH (n) RETURN n");
      expect(error.params).toBeUndefined();
    });

    it("should be instanceof Neo4jClientError", () => {
      const error = new Neo4jQueryError("Test", "MATCH (n) RETURN n");
      expect(error).toBeInstanceOf(Neo4jClientError);
    });

    it("should preserve cause", () => {
      const cause = new Error("Original error");
      const error = new Neo4jQueryError(
        "Query failed",
        "MATCH (n) RETURN n",
        undefined,
        undefined,
        cause
      );
      expect(error.cause).toBe(cause);
    });
  });
});

describe("Factory Functions", () => {
  describe("createNeo4jClient", () => {
    it("should create a new Neo4jClient instance", () => {
      const client = createNeo4jClient(testConfig);
      expect(client).toBeInstanceOf(Neo4jClient);
    });

    it("should accept minimal config", () => {
      const client = createNeo4jClient({
        uri: "bolt://localhost:7687",
        username: "neo4j",
        password: "password",
      });
      expect(client).toBeInstanceOf(Neo4jClient);
    });
  });

  describe("createNeo4jClientFromEnv", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should create client from environment variables", () => {
      process.env["NEO4J_URI"] = "bolt://localhost:7687";
      process.env["NEO4J_USERNAME"] = "neo4j";
      process.env["NEO4J_PASSWORD"] = "password";
      process.env["NEO4J_DATABASE"] = "testdb";
      process.env["NEO4J_MAX_POOL_SIZE"] = "25";

      const client = createNeo4jClientFromEnv();
      expect(client).toBeInstanceOf(Neo4jClient);
    });

    it("should throw when NEO4J_URI is missing", () => {
      delete process.env["NEO4J_URI"];
      process.env["NEO4J_USERNAME"] = "neo4j";
      process.env["NEO4J_PASSWORD"] = "password";

      expect(() => createNeo4jClientFromEnv()).toThrow(
        "Missing required environment variables"
      );
    });

    it("should throw when NEO4J_USERNAME is missing", () => {
      process.env["NEO4J_URI"] = "bolt://localhost:7687";
      delete process.env["NEO4J_USERNAME"];
      process.env["NEO4J_PASSWORD"] = "password";

      expect(() => createNeo4jClientFromEnv()).toThrow(
        "Missing required environment variables"
      );
    });

    it("should throw when NEO4J_PASSWORD is missing", () => {
      process.env["NEO4J_URI"] = "bolt://localhost:7687";
      process.env["NEO4J_USERNAME"] = "neo4j";
      delete process.env["NEO4J_PASSWORD"];

      expect(() => createNeo4jClientFromEnv()).toThrow(
        "Missing required environment variables"
      );
    });

    it("should use default database when NEO4J_DATABASE is not set", () => {
      process.env["NEO4J_URI"] = "bolt://localhost:7687";
      process.env["NEO4J_USERNAME"] = "neo4j";
      process.env["NEO4J_PASSWORD"] = "password";
      delete process.env["NEO4J_DATABASE"];
      delete process.env["NEO4J_MAX_POOL_SIZE"];

      const client = createNeo4jClientFromEnv();
      expect(client).toBeInstanceOf(Neo4jClient);
    });

    it("should use default pool size when NEO4J_MAX_POOL_SIZE is not set", () => {
      process.env["NEO4J_URI"] = "bolt://localhost:7687";
      process.env["NEO4J_USERNAME"] = "neo4j";
      process.env["NEO4J_PASSWORD"] = "password";
      delete process.env["NEO4J_MAX_POOL_SIZE"];

      const client = createNeo4jClientFromEnv();
      expect(client).toBeInstanceOf(Neo4jClient);
    });
  });
});

// ============================================================================
// Connection Tests (Require Neo4j to be running - skip if not available)
// ============================================================================

describe("Neo4jClient - Connection Tests", () => {
  let client: Neo4jClient;

  beforeEach(() => {
    client = new Neo4jClient(testConfig);
  });

  afterEach(async () => {
    if (client.isConnected()) {
      await client.disconnect();
    }
  });

  describe("Connection failure handling", () => {
    it("should throw Neo4jConnectionError when connecting to invalid host", async () => {
      const badClient = new Neo4jClient({
        uri: "bolt://invalid-host-that-does-not-exist:7687",
        username: "neo4j",
        password: "password",
      });

      await expect(badClient.connect()).rejects.toThrow(Neo4jConnectionError);
      expect(badClient.isConnected()).toBe(false);
    });

    it("should include error details in Neo4jConnectionError", async () => {
      const badClient = new Neo4jClient({
        uri: "bolt://invalid-host-that-does-not-exist:7687",
        username: "neo4j",
        password: "password",
      });

      try {
        await badClient.connect();
        fail("Expected error to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Neo4jConnectionError);
        const connError = error as Neo4jConnectionError;
        expect(connError.message).toContain("Failed to connect to Neo4j");
        expect(connError.cause).toBeInstanceOf(Error);
      }
    });
  });
});
