/**
 * Tests for memory_conflicts MCP tool
 * @module mcp/__tests__/memory-conflicts.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PingMemServer } from "../PingMemServer.js";

describe("memory_conflicts", () => {
  let server: PingMemServer;

  async function callTool(
    s: PingMemServer,
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const serverAny = s as unknown as {
      handleToolCall: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    return serverAny.handleToolCall(name, args);
  }

  beforeEach(() => {
    server = new PingMemServer({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns empty list when no contradictions exist", async () => {
    const result = await callTool(server, "memory_conflicts", {});
    expect(result.conflicts).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns empty list with explicit action=list", async () => {
    const result = await callTool(server, "memory_conflicts", { action: "list" });
    expect(result.conflicts).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("throws on resolve without memoryId", async () => {
    await expect(
      callTool(server, "memory_conflicts", { action: "resolve" })
    ).rejects.toThrow("memoryId is required");
  });

  it("throws on resolve with non-existent memoryId", async () => {
    await expect(
      callTool(server, "memory_conflicts", { action: "resolve", memoryId: "nonexistent" })
    ).rejects.toThrow("Memory not found");
  });
});
