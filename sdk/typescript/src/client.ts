import type {
  PingMemSDKConfig,
  SessionStartInput,
  SessionEndInput,
  ContextSaveInput,
  ContextSearchParams,
  CodebaseIngestInput,
  CodebaseSearchParams,
  CodebaseTimelineParams,
  KnowledgeIngestInput,
  KnowledgeSearchInput,
  DiagnosticsLatestParams,
  DiagnosticsDiffInput,
  DiagnosticsIngestInput,
  DiagnosticsCompareParams,
  DiagnosticsBySymbolParams,
  AgentRegisterInput,
  WorklogRecordInput,
  MemoryConsolidateInput,
  CausalSearchParams,
  CausalChainParams,
  CausalDiscoverInput,
} from "./types.js";

/**
 * Thin TypeScript client for the ping-mem REST API.
 *
 * Uses only the built-in `fetch` API — zero runtime dependencies.
 *
 * @example
 * ```ts
 * import { createClient } from "@ping-gadgets/ping-mem-sdk";
 *
 * const client = createClient({ baseUrl: "http://localhost:3003" });
 * const health = await client.health();
 * ```
 */
export class PingMemSDK {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly basicAuth: { username: string; password: string } | undefined;
  private readonly customHeaders: Record<string, string>;

  constructor(config: PingMemSDKConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.basicAuth = config.basicAuth;
    this.customHeaders = config.headers ?? {};
  }

  // ── Internal helpers ─────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.customHeaders,
    };
    if (this.basicAuth) {
      const encoded = btoa(`${this.basicAuth.username}:${this.basicAuth.password}`);
      h["Authorization"] = `Basic ${encoded}`;
    } else if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") {
          url.searchParams.set(k, v);
        }
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : null,
    });
    if (res.status === 204) {
      return undefined as T;
    }
    const data: unknown = await res.json();
    if (!res.ok) {
      const msg =
        typeof data === "object" && data !== null && "message" in data
          ? (data as Record<string, unknown>)["message"]
          : res.statusText;
      throw new PingMemError(res.status, String(msg), data);
    }
    return data as T;
  }

  private toStr(v: number | undefined): string | undefined {
    return v !== undefined ? String(v) : undefined;
  }

  // ── Health ───────────────────────────────────────────

  /** Health check — always 200 if server is running. */
  async health(): Promise<unknown> {
    return this.request("GET", "/health");
  }

  // ── Session ──────────────────────────────────────────

  /** Start a new session. */
  async sessionStart(input: SessionStartInput): Promise<unknown> {
    return this.request("POST", "/api/v1/session/start", input);
  }

  /** End an active session. */
  async sessionEnd(input: SessionEndInput): Promise<unknown> {
    return this.request("POST", "/api/v1/session/end", input);
  }

  /** List recent sessions. */
  async sessionList(limit?: number): Promise<unknown> {
    return this.request("GET", "/api/v1/session/list", undefined, {
      limit: this.toStr(limit),
    });
  }

  // ── Context ──────────────────────────────────────────

  /** Save a memory entry. */
  async contextSave(input: ContextSaveInput): Promise<unknown> {
    return this.request("POST", "/api/v1/context", input);
  }

  /** Get a memory entry by key. */
  async contextGet(key: string): Promise<unknown> {
    return this.request("GET", `/api/v1/context/${encodeURIComponent(key)}`);
  }

  /** Search memories by query. */
  async contextSearch(params: ContextSearchParams): Promise<unknown> {
    return this.request("GET", "/api/v1/search", undefined, {
      query: params.query,
      limit: this.toStr(params.limit),
      category: params.category,
    });
  }

  /** Delete a memory entry by key. */
  async contextDelete(key: string): Promise<unknown> {
    return this.request(
      "DELETE",
      `/api/v1/context/${encodeURIComponent(key)}`,
    );
  }

  /** Create a named checkpoint. */
  async contextCheckpoint(name: string): Promise<unknown> {
    return this.request("POST", "/api/v1/checkpoint", { name });
  }

  /** Get session and server status. */
  async contextStatus(): Promise<unknown> {
    return this.request("GET", "/api/v1/status");
  }

  // ── Graph ────────────────────────────────────────────

  /** Query entity relationships. */
  async graphRelationships(params?: Record<string, string>): Promise<unknown> {
    return this.request(
      "GET",
      "/api/v1/graph/relationships",
      undefined,
      params,
    );
  }

  /** Hybrid semantic + graph search. */
  async graphHybridSearch(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/graph/hybrid-search", body);
  }

  /** Get lineage for an entity. */
  async graphLineage(entity: string): Promise<unknown> {
    return this.request(
      "GET",
      `/api/v1/graph/lineage/${encodeURIComponent(entity)}`,
    );
  }

  /** Query entity evolution over time. */
  async graphEvolution(params?: Record<string, string>): Promise<unknown> {
    return this.request("GET", "/api/v1/graph/evolution", undefined, params);
  }

  /** Graph health check. */
  async graphHealth(): Promise<unknown> {
    return this.request("GET", "/api/v1/graph/health");
  }

  // ── Codebase ─────────────────────────────────────────

  /** Ingest a project directory. */
  async codebaseIngest(input: CodebaseIngestInput): Promise<unknown> {
    return this.request("POST", "/api/v1/codebase/ingest", input);
  }

  /** Verify project manifest integrity. */
  async codebaseVerify(projectDir: string): Promise<unknown> {
    return this.request("POST", "/api/v1/codebase/verify", { projectDir });
  }

  /** Semantic code search. */
  async codebaseSearch(params: CodebaseSearchParams): Promise<unknown> {
    return this.request("GET", "/api/v1/codebase/search", undefined, {
      query: params.query,
      projectId: params.projectId,
      type: params.type,
      limit: this.toStr(params.limit),
    });
  }

  /** Query temporal commit timeline. */
  async codebaseTimeline(
    params?: CodebaseTimelineParams,
  ): Promise<unknown> {
    return this.request("GET", "/api/v1/codebase/timeline", undefined, {
      projectId: params?.projectId,
      filePath: params?.filePath,
      limit: this.toStr(params?.limit),
    });
  }

  /** List all ingested projects. */
  async codebaseProjects(): Promise<unknown> {
    return this.request("GET", "/api/v1/codebase/projects");
  }

  /** Delete a project by ID. */
  async codebaseProjectDelete(id: string): Promise<unknown> {
    return this.request(
      "DELETE",
      `/api/v1/codebase/projects/${encodeURIComponent(id)}`,
    );
  }

  // ── Knowledge ────────────────────────────────────────

  /** Full-text knowledge search. */
  async knowledgeSearch(input: KnowledgeSearchInput): Promise<unknown> {
    return this.request("POST", "/api/v1/knowledge/search", input);
  }

  /** Ingest a knowledge entry. */
  async knowledgeIngest(input: KnowledgeIngestInput): Promise<unknown> {
    return this.request("POST", "/api/v1/knowledge/ingest", input);
  }

  // ── Diagnostics ──────────────────────────────────────

  /** Ingest SARIF diagnostics. */
  async diagnosticsIngest(input: DiagnosticsIngestInput): Promise<unknown> {
    return this.request("POST", "/api/v1/diagnostics/ingest", input);
  }

  /** Get latest diagnostics run. */
  async diagnosticsLatest(
    params?: DiagnosticsLatestParams,
  ): Promise<unknown> {
    return this.request("GET", "/api/v1/diagnostics/latest", undefined, {
      projectId: params?.projectId,
      toolName: params?.toolName,
    });
  }

  /** List findings for a specific analysis. */
  async diagnosticsList(analysisId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/api/v1/diagnostics/findings/${encodeURIComponent(analysisId)}`,
    );
  }

  /** Compare two analyses (introduced/resolved/unchanged). */
  async diagnosticsDiff(input: DiagnosticsDiffInput): Promise<unknown> {
    return this.request("POST", "/api/v1/diagnostics/diff", input);
  }

  /** Get summary for an analysis. */
  async diagnosticsSummary(analysisId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/api/v1/diagnostics/summary/${encodeURIComponent(analysisId)}`,
    );
  }

  /** Compare diagnostics across tools. */
  async diagnosticsCompare(
    params: DiagnosticsCompareParams,
  ): Promise<unknown> {
    return this.request("GET", "/api/v1/diagnostics/compare", undefined, {
      projectId: params.projectId,
      treeHash: params.treeHash,
      toolNames: params.toolNames,
    });
  }

  /** Group findings by symbol. */
  async diagnosticsBySymbol(
    params: DiagnosticsBySymbolParams,
  ): Promise<unknown> {
    return this.request("GET", "/api/v1/diagnostics/by-symbol", undefined, {
      analysisId: params.analysisId,
      groupBy: params.groupBy,
    });
  }

  /** LLM-powered summarize for an analysis. */
  async diagnosticsSummarize(
    analysisId: string,
    body?: { useLLM?: boolean },
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/v1/diagnostics/summarize/${encodeURIComponent(analysisId)}`,
      body,
    );
  }

  // ── Agents ───────────────────────────────────────────

  /** Register or update an agent identity. */
  async agentRegister(input: AgentRegisterInput): Promise<unknown> {
    return this.request("POST", "/api/v1/agents/register", input);
  }

  /** Get quota status for agents. */
  async agentQuotas(agentId?: string): Promise<unknown> {
    return this.request("GET", "/api/v1/agents/quotas", undefined, {
      agentId,
    });
  }

  /** Deregister an agent. */
  async agentDeregister(agentId: string): Promise<unknown> {
    return this.request(
      "DELETE",
      `/api/v1/agents/${encodeURIComponent(agentId)}`,
    );
  }

  // ── Memory ───────────────────────────────────────────

  /** Get memory statistics. */
  async memoryStats(): Promise<unknown> {
    return this.request("GET", "/api/v1/memory/stats");
  }

  /** Consolidate/compress memories. */
  async memoryConsolidate(input?: MemoryConsolidateInput): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/consolidate", input);
  }

  /** Subscribe to memory events. */
  async memorySubscribe(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/subscribe", body);
  }

  /** Unsubscribe from memory events. */
  async memoryUnsubscribe(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/unsubscribe", body);
  }

  /** Compress memories into digest facts. */
  async memoryCompress(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/v1/memory/compress", body);
  }

  // ── Worklog ──────────────────────────────────────────

  /** Record a worklog event. */
  async worklogRecord(input: WorklogRecordInput): Promise<unknown> {
    return this.request("POST", "/api/v1/worklog", input);
  }

  /** List worklog events. */
  async worklogList(limit?: number): Promise<unknown> {
    return this.request("GET", "/api/v1/worklog", undefined, {
      limit: this.toStr(limit),
    });
  }

  // ── Causal ───────────────────────────────────────────

  /** Search for causes of an entity. */
  async causalCauses(params: CausalSearchParams): Promise<unknown> {
    return this.request("GET", "/api/v1/causal/causes", undefined, {
      entity: params.entity,
      projectId: params.projectId,
      limit: this.toStr(params.limit),
    });
  }

  /** Search for effects of an entity. */
  async causalEffects(params: CausalSearchParams): Promise<unknown> {
    return this.request("GET", "/api/v1/causal/effects", undefined, {
      entity: params.entity,
      projectId: params.projectId,
      limit: this.toStr(params.limit),
    });
  }

  /** Get causal chain between two entities. */
  async causalChain(params: CausalChainParams): Promise<unknown> {
    return this.request("GET", "/api/v1/causal/chain", undefined, {
      from: params.from,
      to: params.to,
      projectId: params.projectId,
    });
  }

  /** Trigger causal discovery. */
  async causalDiscover(input: CausalDiscoverInput): Promise<unknown> {
    return this.request("POST", "/api/v1/causal/discover", input);
  }

  // ── Tools ────────────────────────────────────────────

  /** List available MCP tools. */
  async toolsList(): Promise<unknown> {
    return this.request("GET", "/api/v1/tools");
  }

  /** Get schema for a specific tool. */
  async toolsGet(name: string): Promise<unknown> {
    return this.request("GET", `/api/v1/tools/${encodeURIComponent(name)}`);
  }

  /** Invoke a tool by name. */
  async toolsInvoke(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/v1/tools/${encodeURIComponent(name)}/invoke`,
      { arguments: args },
    );
  }
}

/** Error thrown when the API returns a non-2xx status. */
export class PingMemError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "PingMemError";
    this.status = status;
    this.body = body;
  }
}

/** Convenience factory for creating a PingMemSDK instance. */
export function createClient(config: PingMemSDKConfig): PingMemSDK {
  return new PingMemSDK(config);
}
