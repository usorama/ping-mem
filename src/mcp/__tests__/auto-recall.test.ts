/**
 * Tests for context_auto_recall MCP tool
 *
 * @module mcp/__tests__/auto-recall.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PingMemServer } from "../PingMemServer.js";
import { _resetRecallMissCooldown } from "../handlers/ContextToolModule.js";

async function callTool(
  server: PingMemServer,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const serverAny = server as unknown as {
    handleToolCall: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  return serverAny.handleToolCall(name, args);
}

describe("context_auto_recall", () => {
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

  it("should return recalled=false when query is too short", async () => {
    // Start a session first
    await callTool(server, "context_session_start", { name: "test-session" });

    const result = await callTool(server, "context_auto_recall", { query: "hi" });
    expect(result.recalled).toBe(false);
    expect(result.reason).toBe("query too short");
  });

  it("should return recalled=false when no session is active", async () => {
    const result = await callTool(server, "context_auto_recall", { query: "test query for recall" });
    expect(result.recalled).toBe(false);
    expect(result.reason).toBe("no active session");
  });

  it("should return recalled=false when no relevant memories exist", async () => {
    await callTool(server, "context_session_start", { name: "test-session" });

    const result = await callTool(server, "context_auto_recall", {
      query: "something completely unrelated to anything",
    });
    expect(result.recalled).toBe(false);
    expect(result.reason).toBe("no relevant memories found");
    expect(typeof result.hint).toBe("string");
    expect(result.hint).toContain("Consider saving the missing context");
    expect(result.suggestedActions).toEqual(["context_save", "context_search"]);
  });

  it("emits RECALL_MISS event when zero-result recall occurs", async () => {
    _resetRecallMissCooldown();
    await callTool(server, "context_session_start", { name: "recall-miss-session" });

    const uniqueQuery = `recall-miss-test-${Date.now()}`;
    await callTool(server, "context_auto_recall", { query: uniqueQuery });

    // Give fire-and-forget a tick to resolve
    await new Promise((r) => setTimeout(r, 20));

    const eventStore = (server as unknown as { eventStore: { getDatabase: () => import("bun:sqlite").Database } }).eventStore;
    const db = eventStore.getDatabase();
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM events
       WHERE event_type = 'RECALL_MISS'
       AND json_extract(payload, '$.query') = ?`
    ).get(uniqueQuery) as { count: number };

    expect(row.count).toBe(1);
  });

  it("should return formatted context when relevant memories exist", async () => {
    await callTool(server, "context_session_start", { name: "test-session" });

    // Save some memories
    await callTool(server, "context_save", {
      key: "port-policy",
      value: "ping-mem must use port 3003, never 3000",
      category: "decision",
    });
    await callTool(server, "context_save", {
      key: "test-framework",
      value: "Always use bun test, never vitest or jest",
      category: "decision",
    });

    const result = await callTool(server, "context_auto_recall", {
      query: "port 3003",
      limit: 5,
      minScore: 0.0,
    });

    expect(result.recalled).toBe(true);
    expect(typeof result.count).toBe("number");
    expect(typeof result.context).toBe("string");
    const ctx = result.context as string;
    expect(ctx).toContain("--- ping-mem auto-recall ---");
    expect(ctx).toContain("--- end recall ---");
    expect(Array.isArray(result.memories)).toBe(true);
  });

  it("should respect limit parameter", async () => {
    await callTool(server, "context_session_start", { name: "test-session" });

    // Save multiple memories
    for (let i = 0; i < 5; i++) {
      await callTool(server, "context_save", {
        key: `memory-${i}`,
        value: `Test memory number ${i} about database configuration`,
        category: "note",
      });
    }

    const result = await callTool(server, "context_auto_recall", {
      query: "database configuration",
      limit: 2,
      minScore: 0.0,
    });

    if (result.recalled) {
      expect((result.count as number) <= 2).toBe(true);
    }
  });

  it("should be registered in tool list", () => {
    const mcpServer = server.getServer();
    expect(mcpServer).toBeDefined();
    // Verify the tool exists in CONTEXT_TOOLS
    const { CONTEXT_TOOLS } = require("../handlers/ContextToolModule.js");
    const autoRecallTool = CONTEXT_TOOLS.find(
      (t: { name: string }) => t.name === "context_auto_recall"
    );
    expect(autoRecallTool).toBeDefined();
    expect(autoRecallTool.inputSchema.required).toContain("query");
  });
});
