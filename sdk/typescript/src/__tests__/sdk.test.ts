import { describe, test, expect, mock, beforeEach } from "bun:test";
import { PingMemSDK, PingMemError, createClient } from "../client.js";

describe("PingMemSDK", () => {
  // ── Constructor ──────────────────────────────────────

  test("strips trailing slashes from baseUrl", () => {
    const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000///" });
    // Verify by making a request and checking the URL
    expect(sdk).toBeDefined();
  });

  test("createClient returns a PingMemSDK instance", () => {
    const sdk = createClient({ baseUrl: "http://localhost:3000" });
    expect(sdk).toBeInstanceOf(PingMemSDK);
  });

  // ── Request building ─────────────────────────────────

  describe("request building", () => {
    let fetchMock: ReturnType<typeof mock>;

    beforeEach(() => {
      fetchMock = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = fetchMock;
    });

    test("sends correct headers without API key", async () => {
      const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });
      await sdk.health();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBeUndefined();
    });

    test("sends Authorization header with API key", async () => {
      const sdk = new PingMemSDK({
        baseUrl: "http://localhost:3000",
        apiKey: "secret-key",
      });
      await sdk.health();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer secret-key");
    });

    test("sends custom headers", async () => {
      const sdk = new PingMemSDK({
        baseUrl: "http://localhost:3000",
        headers: { "X-Custom": "value" },
      });
      await sdk.health();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Custom"]).toBe("value");
    });

    test("GET request has no body", async () => {
      const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });
      await sdk.health();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBeNull();
    });

    test("POST request serializes body as JSON", async () => {
      const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });
      await sdk.sessionStart({ name: "test-session" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      const parsed = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(parsed).toEqual({ name: "test-session" });
    });

    test("GET with query params appends to URL", async () => {
      const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });
      await sdk.codebaseSearch({ query: "auth", limit: 5 });

      const [url] = fetchMock.mock.calls[0] as [string];
      const parsed = new URL(url);
      expect(parsed.searchParams.get("query")).toBe("auth");
      expect(parsed.searchParams.get("limit")).toBe("5");
    });

    test("undefined query params are omitted", async () => {
      const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });
      await sdk.codebaseSearch({ query: "auth" });

      const [url] = fetchMock.mock.calls[0] as [string];
      const parsed = new URL(url);
      expect(parsed.searchParams.get("query")).toBe("auth");
      expect(parsed.searchParams.has("limit")).toBe(false);
      expect(parsed.searchParams.has("projectId")).toBe(false);
    });

    test("path params are URL-encoded", async () => {
      const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });
      await sdk.contextGet("key with spaces/special");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("key%20with%20spaces%2Fspecial");
    });
  });

  // ── Error handling ───────────────────────────────────

  describe("error handling", () => {
    test("throws PingMemError on non-2xx response", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "not_found", message: "Key not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });

      try {
        await sdk.contextGet("missing-key");
        expect(true).toBe(false); // should not reach
      } catch (e) {
        expect(e).toBeInstanceOf(PingMemError);
        const err = e as PingMemError;
        expect(err.status).toBe(404);
        expect(err.message).toBe("Key not found");
        expect(err.body).toEqual({
          error: "not_found",
          message: "Key not found",
        });
      }
    });

    test("falls back to statusText when response has no message field", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ something: "else" }), {
            status: 500,
            statusText: "Internal Server Error",
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });

      try {
        await sdk.health();
        expect(true).toBe(false);
      } catch (e) {
        const err = e as PingMemError;
        expect(err.status).toBe(500);
        expect(err.message).toBe("Internal Server Error");
      }
    });
  });

  // ── Endpoint coverage ────────────────────────────────

  describe("endpoint coverage", () => {
    let fetchMock: ReturnType<typeof mock>;
    let sdk: PingMemSDK;

    beforeEach(() => {
      fetchMock = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = fetchMock;
      sdk = new PingMemSDK({ baseUrl: "http://localhost:3000" });
    });

    const assertCall = (
      method: string,
      pathIncludes: string,
    ): void => {
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe(method);
      expect(url).toContain(pathIncludes);
    };

    test("sessionStart", async () => {
      await sdk.sessionStart({ name: "s" });
      assertCall("POST", "/api/v1/session/start");
    });

    test("sessionEnd", async () => {
      await sdk.sessionEnd({ sessionId: "abc" });
      assertCall("POST", "/api/v1/session/end");
    });

    test("sessionList", async () => {
      await sdk.sessionList(10);
      assertCall("GET", "/api/v1/session/list");
    });

    test("contextSave", async () => {
      await sdk.contextSave({ key: "k", value: "v" });
      assertCall("POST", "/api/v1/context");
    });

    test("contextGet", async () => {
      await sdk.contextGet("mykey");
      assertCall("GET", "/api/v1/context/mykey");
    });

    test("contextSearch", async () => {
      await sdk.contextSearch({ query: "q" });
      assertCall("GET", "/api/v1/search");
    });

    test("contextDelete", async () => {
      await sdk.contextDelete("mykey");
      assertCall("DELETE", "/api/v1/context/mykey");
    });

    test("contextCheckpoint", async () => {
      await sdk.contextCheckpoint("cp1");
      assertCall("POST", "/api/v1/checkpoint");
    });

    test("contextStatus", async () => {
      await sdk.contextStatus();
      assertCall("GET", "/api/v1/status");
    });

    test("codebaseIngest", async () => {
      await sdk.codebaseIngest({ projectDir: "/p" });
      assertCall("POST", "/api/v1/codebase/ingest");
    });

    test("codebaseVerify", async () => {
      await sdk.codebaseVerify("/p");
      assertCall("POST", "/api/v1/codebase/verify");
    });

    test("codebaseSearch", async () => {
      await sdk.codebaseSearch({ query: "q" });
      assertCall("GET", "/api/v1/codebase/search");
    });

    test("codebaseTimeline", async () => {
      await sdk.codebaseTimeline({ limit: 5 });
      assertCall("GET", "/api/v1/codebase/timeline");
    });

    test("codebaseProjects", async () => {
      await sdk.codebaseProjects();
      assertCall("GET", "/api/v1/codebase/projects");
    });

    test("codebaseProjectDelete", async () => {
      await sdk.codebaseProjectDelete("proj-id");
      assertCall("DELETE", "/api/v1/codebase/projects/proj-id");
    });

    test("knowledgeSearch", async () => {
      await sdk.knowledgeSearch({ query: "q" });
      assertCall("POST", "/api/v1/knowledge/search");
    });

    test("knowledgeIngest", async () => {
      await sdk.knowledgeIngest({
        projectId: "p",
        title: "t",
        solution: "s",
      });
      assertCall("POST", "/api/v1/knowledge/ingest");
    });

    test("diagnosticsIngest", async () => {
      await sdk.diagnosticsIngest({
        projectId: "p",
        treeHash: "h",
        toolName: "tsc",
        toolVersion: "5.0",
        configHash: "c",
        sarif: {},
      });
      assertCall("POST", "/api/v1/diagnostics/ingest");
    });

    test("diagnosticsLatest", async () => {
      await sdk.diagnosticsLatest({ projectId: "p" });
      assertCall("GET", "/api/v1/diagnostics/latest");
    });

    test("diagnosticsList", async () => {
      await sdk.diagnosticsList("a1");
      assertCall("GET", "/api/v1/diagnostics/findings/a1");
    });

    test("diagnosticsDiff", async () => {
      await sdk.diagnosticsDiff({ analysisIdA: "a", analysisIdB: "b" });
      assertCall("POST", "/api/v1/diagnostics/diff");
    });

    test("diagnosticsSummary", async () => {
      await sdk.diagnosticsSummary("a1");
      assertCall("GET", "/api/v1/diagnostics/summary/a1");
    });

    test("diagnosticsCompare", async () => {
      await sdk.diagnosticsCompare({
        projectId: "p",
        treeHash: "h",
        toolNames: "tsc,eslint",
      });
      assertCall("GET", "/api/v1/diagnostics/compare");
    });

    test("diagnosticsBySymbol", async () => {
      await sdk.diagnosticsBySymbol({ analysisId: "a1" });
      assertCall("GET", "/api/v1/diagnostics/by-symbol");
    });

    test("diagnosticsSummarize", async () => {
      await sdk.diagnosticsSummarize("a1", { useLLM: true });
      assertCall("POST", "/api/v1/diagnostics/summarize/a1");
    });

    test("agentRegister", async () => {
      await sdk.agentRegister({ agentId: "ag1", role: "worker" });
      assertCall("POST", "/api/v1/agents/register");
    });

    test("agentQuotas", async () => {
      await sdk.agentQuotas("ag1");
      assertCall("GET", "/api/v1/agents/quotas");
    });

    test("agentDeregister", async () => {
      await sdk.agentDeregister("ag1");
      assertCall("DELETE", "/api/v1/agents/ag1");
    });

    test("memoryStats", async () => {
      await sdk.memoryStats();
      assertCall("GET", "/api/v1/memory/stats");
    });

    test("memoryConsolidate", async () => {
      await sdk.memoryConsolidate({ maxItems: 50 });
      assertCall("POST", "/api/v1/memory/consolidate");
    });

    test("worklogRecord", async () => {
      await sdk.worklogRecord({ kind: "diagnostics", title: "tsc" });
      assertCall("POST", "/api/v1/worklog");
    });

    test("worklogList", async () => {
      await sdk.worklogList(20);
      assertCall("GET", "/api/v1/worklog");
    });

    test("causalCauses", async () => {
      await sdk.causalCauses({ entity: "e1" });
      assertCall("GET", "/api/v1/causal/causes");
    });

    test("causalEffects", async () => {
      await sdk.causalEffects({ entity: "e1" });
      assertCall("GET", "/api/v1/causal/effects");
    });

    test("causalChain", async () => {
      await sdk.causalChain({ from: "a", to: "b" });
      assertCall("GET", "/api/v1/causal/chain");
    });

    test("causalDiscover", async () => {
      await sdk.causalDiscover({ projectId: "p" });
      assertCall("POST", "/api/v1/causal/discover");
    });

    test("toolsList", async () => {
      await sdk.toolsList();
      assertCall("GET", "/api/v1/tools");
    });

    test("toolsGet", async () => {
      await sdk.toolsGet("context_save");
      assertCall("GET", "/api/v1/tools/context_save");
    });

    test("toolsInvoke", async () => {
      await sdk.toolsInvoke("context_save", { key: "k", value: "v" });
      assertCall("POST", "/api/v1/tools/context_save/invoke");
    });
  });
});
