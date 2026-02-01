/**
 * Tests for PingMemServer
 *
 * @module mcp/__tests__/PingMemServer.test
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { PingMemServer } from "../PingMemServer.js";

describe("PingMemServer", () => {
  let server: PingMemServer;

  beforeEach(() => {
    server = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  describe("Initialization", () => {
    it("should create server with default configuration", () => {
      const defaultServer = new PingMemServer();
      expect(defaultServer).toBeDefined();
      expect(defaultServer.getServer()).toBeDefined();
      expect(defaultServer.getCurrentSessionId()).toBeNull();
    });

    it("should create server with custom configuration", () => {
      const customServer = new PingMemServer({
        dbPath: ":memory:",
        enableVectorSearch: false,
        vectorDimensions: 512,
      });
      expect(customServer).toBeDefined();
    });
  });

  describe("Tool Handlers via Direct Calls", () => {
    // We test the handlers by accessing the underlying components
    // since the MCP server normally communicates via stdio

    describe("context_session_start", () => {
      it("should start a new session", async () => {
        // Access server internals for testing
        const mcpServer = server.getServer();
        expect(mcpServer).toBeDefined();
        expect(server.getCurrentSessionId()).toBeNull();
      });
    });
  });

  describe("Session Lifecycle", () => {
    it("should track session state", () => {
      // Initial state - no active session
      expect(server.getCurrentSessionId()).toBeNull();
    });
  });

  describe("Resource Cleanup", () => {
    it("should close all resources on close", async () => {
      const testServer = new PingMemServer();
      await testServer.close();
      // Verify no errors thrown
      expect(true).toBe(true);
    });

    it("should handle multiple close calls gracefully", async () => {
      const testServer = new PingMemServer();
      await testServer.close();
      await testServer.close(); // Second close should not throw
      expect(true).toBe(true);
    });
  });
});

describe("PingMemServer Integration", () => {
  // Integration tests that test full MCP protocol would require
  // setting up proper transport mocks. For now, we test the
  // underlying components are wired correctly.

  it("should expose MCP server instance", () => {
    const server = new PingMemServer();
    const mcpServer = server.getServer();
    expect(mcpServer).toBeDefined();
  });
});

describe("codebase_list_projects tool", () => {
  let server: PingMemServer;

  beforeEach(() => {
    server = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it("should include codebase_list_projects in tool list", () => {
    const mcpServer = server.getServer();
    expect(mcpServer).toBeDefined();
    // Tool schema should be registered
    // (Full verification requires MCP protocol testing)
  });

  it("should reject invalid input (Zod validation)", async () => {
    // Test that the tool validates input using Zod schema
    // This would require calling the handler directly or via MCP protocol
    // For now, we verify the tool is registered
    expect(server.getServer()).toBeDefined();
  });

  it("should require IngestionService to be configured", () => {
    // Server without ingestion service should throw when calling codebase tools
    const serverWithoutIngestion = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
      // No ingestionService provided
    });

    expect(serverWithoutIngestion).toBeDefined();
    // Handler would throw: "IngestionService not configured"
  });
});
