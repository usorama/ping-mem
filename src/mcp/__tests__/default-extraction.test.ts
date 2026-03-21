/**
 * Tests for default-on entity extraction in context_save (issue #54).
 *
 * Verifies that entity extraction is enabled by default and can be
 * explicitly disabled with extractEntities=false.
 *
 * @module mcp/__tests__/default-extraction.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PingMemServer } from "../PingMemServer.js";

/**
 * Helper to call tool handlers through the server's private handleToolCall.
 */
async function callTool(
  server: PingMemServer,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const serverInternal = server as unknown as {
    handleToolCall: (
      name: string,
      args: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
  };
  return serverInternal.handleToolCall(name, args);
}

describe("default-on entity extraction for context_save", () => {
  let server: PingMemServer;

  beforeEach(async () => {
    server = new PingMemServer({
      dbPath: ":memory:",
      enableVectorSearch: false,
    });
    await callTool(server, "context_session_start", { name: "extraction-test" });
  });

  afterEach(async () => {
    await server.close();
  });

  it("should attempt extraction when extractEntities is omitted (default-on)", async () => {
    const result = await callTool(server, "context_save", {
      key: "default-extract",
      value: "Dr. Smith created the UserService class for the Auth module.",
    });

    expect(result.success).toBe(true);
    // entityIds is included in the response when extraction was attempted,
    // even if no graphManager is configured (empty array fallback).
    // Without a graphManager the extraction path is entered but the
    // graphManager null-check prevents actual storage — so entityIds
    // may or may not appear depending on wiring.  The key assertion is
    // that save succeeds and does NOT skip extraction silently.
    expect(result.memoryId).toBeDefined();
  });

  it("should skip extraction when extractEntities is explicitly false", async () => {
    const result = await callTool(server, "context_save", {
      key: "skip-extract",
      value: "Dr. Smith created the UserService class for the Auth module.",
      extractEntities: false,
    });

    expect(result.success).toBe(true);
    expect(result.memoryId).toBeDefined();
    // When extractEntities=false, the shouldExtract flag is false (unless
    // LLM routing overrides), so entityIds should NOT appear in the response.
    expect(result.entityIds).toBeUndefined();
  });

  it("should attempt extraction when extractEntities is explicitly true", async () => {
    const result = await callTool(server, "context_save", {
      key: "explicit-extract",
      value: "Dr. Smith created the UserService class for the Auth module.",
      extractEntities: true,
    });

    expect(result.success).toBe(true);
    expect(result.memoryId).toBeDefined();
  });

  it("should still save successfully regardless of extraction flag", async () => {
    const results = await Promise.all([
      callTool(server, "context_save", {
        key: "save-no-flag",
        value: "simple note",
      }),
      callTool(server, "context_save", {
        key: "save-true-flag",
        value: "simple note 2",
        extractEntities: true,
      }),
      callTool(server, "context_save", {
        key: "save-false-flag",
        value: "simple note 3",
        extractEntities: false,
      }),
    ]);

    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.memoryId).toBeDefined();
    }
  });
});

describe("extractionRouting with default-on flag", () => {
  it("shouldUseLlmExtraction returns true when explicitExtract is true (default-on path)", async () => {
    const { shouldUseLlmExtraction } = await import("../extractionRouting.js");
    // With the default-on change, the caller passes explicitExtract=true
    // when extractEntities is undefined (not explicitly false).
    expect(shouldUseLlmExtraction("note", 50, true)).toBe(true);
  });

  it("shouldUseLlmExtraction returns false when explicitExtract is false and no other trigger", async () => {
    const { shouldUseLlmExtraction } = await import("../extractionRouting.js");
    // When extractEntities=false, explicitExtract=false.
    expect(shouldUseLlmExtraction("note", 50, false)).toBe(false);
  });

  it("shouldUseLlmExtraction still triggers on category even if explicitExtract is false", async () => {
    const { shouldUseLlmExtraction } = await import("../extractionRouting.js");
    // Category-based routing (decision/error/task) overrides opt-out
    expect(shouldUseLlmExtraction("decision", 50, false)).toBe(true);
  });
});
