import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  buildAgentCodebaseProjects,
  buildAgentCodebaseVerify,
  buildAgentGraphAnswer,
  buildAgentSessionStart,
  buildAgentStatus,
  buildCodebaseGroundingProof,
  buildMemoryLifecycleProof,
  buildMemoryLifecycleDryRun,
} from "../agent-trust.js";

let originalFetch: typeof globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function installFetchMock(): void {
  originalFetch = globalThis.fetch;
  fetchMock = mock<typeof globalThis.fetch>();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe("agent trust spine", () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    restoreFetch();
  });

  it("returns stable JSON-ready status when REST health is available", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    const result = await buildAgentStatus({ serverUrl: "http://localhost:3003", timeoutMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("available");
    expect(result.command).toBe("agent status");
    expect(result.runtime.url).toBe("http://localhost:3003");
    expect(result.runtime.timeoutMs).toBe(50);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.data).toEqual({ status: "ok" });

    const fetchCall = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(fetchCall[0].toString()).toBe("http://localhost:3003/health");
    expect(fetchCall[1].method).toBe("GET");
  });

  it("returns blocked JSON instead of repairing when REST is unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await buildAgentStatus({ serverUrl: "http://127.0.0.1:9", timeoutMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(result.error?.layer).toBe("runtime");
  });

  it("builds a read-only memory lifecycle dry-run plan", () => {
    const result = buildMemoryLifecycleDryRun({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      dryRun: true,
      serverUrl: "http://localhost:3003",
      evidenceDir: "docs/evidence/ground-up-local-trust/S003-cli-json-examples",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("dry-run");
    expect(result.evidenceDir).toBe("docs/evidence/ground-up-local-trust/S003-cli-json-examples");
    expect(result.data).toMatchObject({
      readOnly: true,
      mutatesRuntime: false,
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
    });
  });

  it("simulates unauthorized memory proof without touching runtime", async () => {
    const result = await buildMemoryLifecycleProof({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      dryRun: false,
      simulate: "unauthorized",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNAUTHORIZED");
    expect(result.data).toMatchObject({ simulated: true, repairsAttempted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks non-dry-run memory proof until lifecycle issues own execution", () => {
    const result = buildMemoryLifecycleDryRun({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      dryRun: false,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("PROOF_NOT_IMPLEMENTED");
  });

  it("non-dry-run memory lifecycle proof returns blocked JSON when REST is unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await buildMemoryLifecycleProof({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      dryRun: false,
      serverUrl: "http://localhost:3003",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(result.data).toMatchObject({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      steps: [],
    });
  });

  it("blocks approved session start when agent identity is missing", async () => {
    const result = await buildAgentSessionStart({
      projectDir: "/Users/umasankr/Projects/ping-mem",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MISSING_AGENT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks approved codebase verify for unsafe project paths before fetch", async () => {
    const result = await buildAgentCodebaseVerify({
      agentId: "codex-local",
      projectDir: "/etc",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNSAFE_PROJECT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends approved identity headers and body for session start", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { sessionId: "session-1" } }), { status: 200 })
    );

    const result = await buildAgentSessionStart({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      serverUrl: "http://localhost:3003",
    });

    expect(result.ok).toBe(true);
    const fetchCall = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(fetchCall[0].toString()).toBe("http://localhost:3003/api/v1/session/start");
    expect((fetchCall[1].headers as Record<string, string>)["X-Ping-Mem-Approved-Path"]).toBe("true");
    expect(JSON.parse(fetchCall[1].body as string)).toMatchObject({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      autoIngest: false,
    });
  });

  it("lists registered projects through the approved runtime registry path", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { scope: "registered", projects: [] } }), { status: 200 })
    );

    const result = await buildAgentCodebaseProjects({
      scope: "registered",
      limit: 1000,
      serverUrl: "http://localhost:3003",
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe("agent codebase projects");
    const fetchCall = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(fetchCall[0].toString()).toBe("http://localhost:3003/api/v1/codebase/projects?scope=registered&limit=1000");
    expect(fetchCall[1].method).toBe("GET");
  });

  it("builds codebase grounding proof with runtime path translation and disk anchor checks", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { projectId: "project-1", valid: true, message: "ok" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { projectId: "project-1", chunksIndexed: 1, hadChanges: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { scope: "registered", count: 1, projects: [{ rootPath: "/projects/ping-mem" }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          count: 1,
          results: [{
            projectId: "project-1",
            filePath: "src/cli/__tests__/agent-trust.test.ts",
            lineStart: 1,
            lineEnd: 5,
          }],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ commitHash: "abc", message: "test" }] }), { status: 200 }));

    const result = await buildCodebaseGroundingProof({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      serverUrl: "http://localhost:3003",
      timeoutMs: 50,
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe("agent proof codebase-grounding");
    expect(result.data).toMatchObject({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      runtimeProjectDir: "/projects/ping-mem",
      projectId: "project-1",
    });

    const verifyCall = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(verifyCall[0].toString()).toBe("http://localhost:3003/api/v1/codebase/verify");
    expect(JSON.parse(verifyCall[1].body as string)).toMatchObject({
      agentId: "codex-local",
      projectDir: "/projects/ping-mem",
    });
  });

  it("simulates dependency-down codebase proof without touching runtime", async () => {
    const result = await buildCodebaseGroundingProof({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      simulate: "dependency-down",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("DEPENDENCY_DOWN");
    expect(result.data).toMatchObject({ simulated: true, repairsAttempted: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends approved identity and complete graph mode for graph answers", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: {
          ok: true,
          answerKind: "complete_graph",
          denominator: { nodeCount: 1, edgeCount: 0 },
          sourceAnchors: [{ diskChecked: true }],
        },
      }), { status: 200 })
    );

    const result = await buildAgentGraphAnswer({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      mode: "complete_graph",
      query: "graph contract",
      serverUrl: "http://localhost:3003",
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe("agent graph answer");
    const fetchCall = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(fetchCall[0].toString()).toBe("http://localhost:3003/api/v1/graph/answer");
    expect((fetchCall[1].headers as Record<string, string>)["X-Ping-Mem-Approved-Path"]).toBe("true");
    expect(JSON.parse(fetchCall[1].body as string)).toMatchObject({
      agentId: "codex-local",
      projectDir: "/Users/umasankr/Projects/ping-mem",
      mode: "complete_graph",
      query: "graph contract",
      population: {
        kind: "project",
        root: "/Users/umasankr/Projects/ping-mem",
      },
    });
  });
});
