/** SDK configuration options. */
export interface PingMemSDKConfig {
  /** Base URL of the ping-mem REST server (e.g. "http://localhost:3003"). */
  baseUrl: string;
  /** Optional Bearer token or API key for authenticated requests. */
  apiKey?: string | undefined;
  /**
   * Optional Basic Auth credentials (username:password).
   * When set, the SDK sends `Authorization: Basic <base64>` instead of Bearer.
   * Required for endpoints like `/api/v1/tools/:name/invoke` when admin credentials are configured.
   */
  basicAuth?: { username: string; password: string } | undefined;
  /** Optional custom headers merged into every request. */
  headers?: Record<string, string> | undefined;
}

/** Standard error response from the REST API. */
export interface ErrorResponse {
  error: string;
  message: string;
}

/** Options for SDK request methods (internal). */
export interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  params?: Record<string, string | undefined>;
}

// ── Session ──────────────────────────────────────────────

export interface SessionStartInput {
  name: string;
  projectDir?: string | undefined;
  autoIngest?: boolean | undefined;
}

export interface SessionEndInput {
  sessionId: string;
}

// ── Context ──────────────────────────────────────────────

export interface ContextSaveInput {
  key: string;
  value: string;
  category?: string | undefined;
  priority?: string | undefined;
  tags?: string[] | undefined;
}

export interface ContextSearchParams {
  query: string;
  limit?: number | undefined;
  category?: string | undefined;
}

// ── Codebase ─────────────────────────────────────────────

export interface CodebaseIngestInput {
  projectDir: string;
  forceReingest?: boolean | undefined;
}

export interface CodebaseSearchParams {
  query: string;
  projectId?: string | undefined;
  type?: string | undefined;
  limit?: number | undefined;
}

export interface CodebaseTimelineParams {
  projectId?: string | undefined;
  filePath?: string | undefined;
  limit?: number | undefined;
}

// ── Knowledge ────────────────────────────────────────────

export interface KnowledgeIngestInput {
  projectId: string;
  title: string;
  solution: string;
  symptoms?: string[] | undefined;
  rootCause?: string | undefined;
  tags?: string[] | undefined;
}

export interface KnowledgeSearchInput {
  query: string;
  projectId?: string | undefined;
  crossProject?: boolean | undefined;
  tags?: string[] | undefined;
  limit?: number | undefined;
}

// ── Diagnostics ──────────────────────────────────────────

export interface DiagnosticsLatestParams {
  projectId?: string | undefined;
  toolName?: string | undefined;
}

export interface DiagnosticsDiffInput {
  analysisIdA: string;
  analysisIdB: string;
}

export interface DiagnosticsIngestInput {
  projectId: string;
  treeHash: string;
  toolName: string;
  toolVersion: string;
  configHash: string;
  sarif: unknown;
}

export interface DiagnosticsCompareParams {
  projectId: string;
  treeHash: string;
  toolNames: string;
}

export interface DiagnosticsBySymbolParams {
  analysisId: string;
  groupBy?: string | undefined;
}

// ── Agent ────────────────────────────────────────────────

export interface AgentRegisterInput {
  agentId: string;
  role: string;
  admin?: boolean | undefined;
  ttlMs?: number | undefined;
  quotaBytes?: number | undefined;
  quotaCount?: number | undefined;
}

// ── Worklog ──────────────────────────────────────────────

export interface WorklogRecordInput {
  kind: string;
  title: string;
  status?: string | undefined;
  toolName?: string | undefined;
  durationMs?: number | undefined;
}

// ── Memory ───────────────────────────────────────────────

export interface MemoryConsolidateInput {
  maxItems?: number | undefined;
}

// ── Causal ───────────────────────────────────────────────

export interface CausalSearchParams {
  entity: string;
  projectId?: string | undefined;
  limit?: number | undefined;
}

export interface CausalChainParams {
  from: string;
  to: string;
  projectId?: string | undefined;
}

export interface CausalDiscoverInput {
  projectId: string;
  scope?: string | undefined;
}
