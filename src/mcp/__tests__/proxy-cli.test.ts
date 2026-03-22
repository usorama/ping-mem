/**
 * Tests for src/mcp/proxy-cli.ts
 *
 * Verifies:
 * 1. proxy-cli.ts has no direct DB imports (grep test)
 * 2. tool-schemas.ts has no direct DB imports (grep test)
 * 3. proxyToolCall function with mocked fetch
 * 4. checkDockerHealth function
 * 5. Error formatting
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { TOOLS } from "../tool-schemas.js";

// ============================================================================
// Static imports analysis (grep tests)
// ============================================================================

const WORKTREE = path.resolve(import.meta.dir, "../../..");
const PROXY_CLI_PATH = path.join(WORKTREE, "src/mcp/proxy-cli.ts");
const TOOL_SCHEMAS_PATH = path.join(WORKTREE, "src/mcp/tool-schemas.ts");

describe("proxy-cli.ts — no DB imports", () => {
  it("should not have import statements for Database", () => {
    const content = readFileSync(PROXY_CLI_PATH, "utf-8");
    // Check for actual import statements (lines starting with "import"), not comments
    const importLines = content.split("\n").filter((line) => line.trimStart().startsWith("import"));
    const importText = importLines.join("\n");
    expect(importText).not.toMatch(/Database/);
    expect(importText).not.toMatch(/bun:sqlite/);
  });

  it("should not have import statements for EventStore", () => {
    const content = readFileSync(PROXY_CLI_PATH, "utf-8");
    const importLines = content.split("\n").filter((line) => line.trimStart().startsWith("import"));
    const importText = importLines.join("\n");
    expect(importText).not.toMatch(/EventStore/);
  });

  it("should not have import statements for MemoryManager", () => {
    const content = readFileSync(PROXY_CLI_PATH, "utf-8");
    const importLines = content.split("\n").filter((line) => line.trimStart().startsWith("import"));
    const importText = importLines.join("\n");
    expect(importText).not.toMatch(/MemoryManager/);
  });

  it("should not have import statements for SessionManager", () => {
    const content = readFileSync(PROXY_CLI_PATH, "utf-8");
    const importLines = content.split("\n").filter((line) => line.trimStart().startsWith("import"));
    const importText = importLines.join("\n");
    expect(importText).not.toMatch(/SessionManager/);
  });

  it("should use PING_MEM_REST_URL env var", () => {
    const content = readFileSync(PROXY_CLI_PATH, "utf-8");
    expect(content).toMatch(/PING_MEM_REST_URL/);
  });

  it("should import from tool-schemas.js (not PingMemServer)", () => {
    const content = readFileSync(PROXY_CLI_PATH, "utf-8");
    expect(content).toMatch(/from.*tool-schemas/);
    expect(content).not.toMatch(/import.*TOOLS.*from.*PingMemServer/);
  });
});

describe("tool-schemas.ts — no DB imports", () => {
  it("should have zero import statements total (pure static file)", () => {
    const content = readFileSync(TOOL_SCHEMAS_PATH, "utf-8");
    const importLines = content.split("\n").filter((line) => line.trimStart().startsWith("import"));
    // tool-schemas.ts should have NO import statements at all (it's a pure data file)
    expect(importLines).toHaveLength(0);
  });

  it("should not reference storage, memory, or graph modules in any line", () => {
    const content = readFileSync(TOOL_SCHEMAS_PATH, "utf-8");
    expect(content).not.toMatch(/from.*\.\.\/storage\//);
    expect(content).not.toMatch(/from.*\.\.\/memory\//);
    expect(content).not.toMatch(/from.*\.\.\/graph\//);
    expect(content).not.toMatch(/from.*bun:sqlite/);
  });
});

// ============================================================================
// TOOLS array
// ============================================================================

describe("TOOLS static array", () => {
  it("should contain at least 40 tools", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(40);
  });

  it("should have context_session_start", () => {
    const tool = TOOLS.find((t) => t.name === "context_session_start");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("name");
  });

  it("should have context_auto_recall", () => {
    const tool = TOOLS.find((t) => t.name === "context_auto_recall");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("query");
  });

  it("should have context_save with required key and value", () => {
    const tool = TOOLS.find((t) => t.name === "context_save");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toContain("key");
    expect(tool?.inputSchema.required).toContain("value");
  });

  it("should have all tool categories", () => {
    const names = TOOLS.map((t) => t.name);
    // Context
    expect(names).toContain("context_session_start");
    expect(names).toContain("context_search");
    // Graph
    expect(names).toContain("context_hybrid_search");
    expect(names).toContain("context_get_lineage");
    // Worklog
    expect(names).toContain("worklog_record");
    // Diagnostics
    expect(names).toContain("diagnostics_ingest");
    // Codebase
    expect(names).toContain("codebase_ingest");
    expect(names).toContain("codebase_search");
    // Structural
    expect(names).toContain("codebase_impact");
    // Memory
    expect(names).toContain("memory_maintain");
    // Causal
    expect(names).toContain("search_causes");
    // Knowledge
    expect(names).toContain("knowledge_search");
    // Agent
    expect(names).toContain("agent_register");
    // Mining
    expect(names).toContain("transcript_mine");
    expect(names).toContain("dreaming_run");
  });

  it("all tools should have valid inputSchema", () => {
    for (const tool of TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
    }
  });

  it("should have no duplicate tool names", () => {
    const names = TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ============================================================================
// proxyToolCall — with mocked fetch
// ============================================================================

describe("proxyToolCall", () => {
  // Import the functions after module-level await completes
  // We use dynamic import to avoid running the top-level await startup code
  // Instead, test the logic by importing only the exported functions

  it("should return content on success", async () => {
    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ data: { sessionId: "test-123", name: "test" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    try {
      // Dynamically import to get the function without running top-level startup
      const { proxyToolCall } = await import("../proxy-cli.js");
      const result = await proxyToolCall(
        "context_session_start",
        { name: "test" },
        "http://localhost:3003",
        undefined
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe("test-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should return isError on HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ error: "NOT_FOUND", message: "Tool not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    );

    try {
      const { proxyToolCall } = await import("../proxy-cli.js");
      const result = await proxyToolCall(
        "nonexistent_tool",
        {},
        "http://localhost:3003",
        undefined
      );

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should return isError on network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("Connection refused");
    });

    try {
      const { proxyToolCall } = await import("../proxy-cli.js");
      const result = await proxyToolCall(
        "context_search",
        { query: "test" },
        "http://localhost:3003",
        undefined
      );

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("PROXY_NETWORK_ERROR");
      expect(parsed.hint).toMatch(/docker/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should include auth header when provided", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const { proxyToolCall } = await import("../proxy-cli.js");
      await proxyToolCall(
        "context_status",
        {},
        "http://localhost:3003",
        "Basic dXNlcjpwYXNz"
      );

      expect(capturedHeaders?.["Authorization"]).toBe("Basic dXNlcjpwYXNz");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ============================================================================
// checkDockerHealth
// ============================================================================

describe("checkDockerHealth", () => {
  it("should return true when health endpoint responds OK", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ status: "ok" }), { status: 200 })
    );

    try {
      const { checkDockerHealth } = await import("../proxy-cli.js");
      const result = await checkDockerHealth("http://localhost:3003");
      expect(result).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should return false when health endpoint is unreachable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });

    try {
      const { checkDockerHealth } = await import("../proxy-cli.js");
      const result = await checkDockerHealth("http://localhost:9999");
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should return false when health endpoint returns non-OK status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response("Internal Server Error", { status: 500 })
    );

    try {
      const { checkDockerHealth } = await import("../proxy-cli.js");
      const result = await checkDockerHealth("http://localhost:3003");
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
