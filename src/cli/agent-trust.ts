/**
 * Shared agent trust-spine helpers.
 *
 * These helpers are intentionally REST-only. They do not import storage,
 * memory, ingestion, Docker, or service internals.
 */

import { loadAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { isProjectDirSafe } from "../util/path-safety.js";
import * as fs from "fs";
import * as path from "path";

export type AgentTrustStatus = "available" | "blocked" | "dry-run";

export interface AgentTrustRuntime {
  url: string;
  timeoutMs: number;
}

export interface AgentTrustEnvelope {
  ok: boolean;
  status: AgentTrustStatus;
  command: string;
  runtime: AgentTrustRuntime;
  elapsedMs: number;
  checkedAt: string;
  evidenceDir?: string | undefined;
  error?: {
    code: string;
    message: string;
    layer: "runtime" | "cli" | "input";
  };
  data?: unknown;
}

interface LifecycleStep {
  name: string;
  ok: boolean;
  detail?: string;
  data?: unknown;
}

export interface AgentRuntimeOptions {
  serverUrl?: string | undefined;
  timeoutMs?: number | undefined;
  evidenceDir?: string | undefined;
}

export interface MemoryLifecycleDryRunOptions extends AgentRuntimeOptions {
  agentId?: string | undefined;
  projectDir?: string | undefined;
  dryRun: boolean;
  simulate?: FailureSimulation | undefined;
}

export interface AgentSessionStartOptions extends AgentRuntimeOptions {
  agentId?: string | undefined;
  projectDir?: string | undefined;
}

export interface AgentCodebaseVerifyOptions extends AgentRuntimeOptions {
  agentId?: string | undefined;
  projectDir?: string | undefined;
}

export interface AgentCodebaseProjectsOptions extends AgentRuntimeOptions {
  scope?: "registered" | "all" | undefined;
  limit?: number | undefined;
}

export interface CodebaseGroundingProofOptions extends AgentRuntimeOptions {
  agentId?: string | undefined;
  projectDir?: string | undefined;
  simulate?: FailureSimulation | undefined;
}

export interface AgentGraphAnswerOptions extends AgentRuntimeOptions {
  agentId?: string | undefined;
  projectDir?: string | undefined;
  mode: "complete_graph" | "semantic_neighborhood";
  query?: string | undefined;
  expectedCorpusHash?: string | undefined;
  requireFreshness?: boolean | undefined;
  limit?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30000;
export type FailureSimulation = "unauthorized" | "dependency-down" | "stale" | "missing-data" | "timeout";
const FAILURE_SIMULATIONS = new Set<string>(["unauthorized", "dependency-down", "stale", "missing-data", "timeout"]);

export function normalizeFailureSimulation(value?: string): FailureSimulation | undefined {
  return value && FAILURE_SIMULATIONS.has(value) ? value as FailureSimulation : undefined;
}

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export function resolveRuntime(opts: AgentRuntimeOptions = {}): AgentTrustRuntime {
  const config = loadConfig();
  return {
    url: opts.serverUrl ?? process.env.PING_MEM_REST_URL ?? config.serverUrl,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function authHeaders(): Record<string, string> {
  const auth = loadAuth();
  const apiKey = process.env.PING_MEM_API_KEY ?? auth?.apiKey;
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function fetchJson(runtime: AgentTrustRuntime, path: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const requestInit: RequestInit = {
      method: init.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: controller.signal,
    };
    if (init.body !== undefined) {
      requestInit.body = init.body;
    }
    const res = await fetch(new URL(path, runtime.url), requestInit);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    if (!res.ok) {
      throw new HttpStatusError(res.status, `HTTP ${res.status}: ${text || res.statusText}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function classifyRuntimeError(err: Error): { code: string; message: string } {
  if (err.name === "AbortError") {
    return { code: "RUNTIME_TIMEOUT", message: err.message };
  }
  if (err instanceof HttpStatusError) {
    if (err.status === 401 || err.status === 403) return { code: "UNAUTHORIZED", message: err.message };
    if (err.status === 404) return { code: "MISSING_DATA", message: err.message };
    if (err.status === 503) return { code: "DEPENDENCY_DOWN", message: err.message };
  }
  return { code: "RUNTIME_UNAVAILABLE", message: err.message };
}

function simulatedFailureEnvelope(
  command: string,
  runtime: AgentTrustRuntime,
  startedAt: number,
  simulate: FailureSimulation,
  evidenceDir?: string,
): AgentTrustEnvelope {
  const failureMap: Record<FailureSimulation, { code: string; message: string; layer: "runtime" | "cli" | "input" }> = {
    "unauthorized": { code: "UNAUTHORIZED", message: "Simulated unauthorized response; proof must block, not return empty success", layer: "runtime" },
    "dependency-down": { code: "DEPENDENCY_DOWN", message: "Simulated dependency-down response; proof must block, not return empty success", layer: "runtime" },
    "stale": { code: "STALE_DATA", message: "Simulated stale data response; proof must report stale, not current", layer: "runtime" },
    "missing-data": { code: "MISSING_DATA", message: "Simulated missing data response; proof must report missing, not empty success", layer: "runtime" },
    "timeout": { code: "RUNTIME_TIMEOUT", message: `Simulated timeout after ${runtime.timeoutMs}ms`, layer: "runtime" },
  };
  const failure = failureMap[simulate];
  return {
    ...blockedEnvelope(command, runtime, startedAt, failure.code, failure.message, failure.layer, evidenceDir),
    data: { simulated: true, scenario: simulate, repairsAttempted: false },
  };
}

function validateApprovedIdentity(
  command: string,
  runtime: AgentTrustRuntime,
  startedAt: number,
  agentId?: string,
  projectDir?: string,
  evidenceDir?: string,
): AgentTrustEnvelope | null {
  if (!agentId) {
    return blockedEnvelope(command, runtime, startedAt, "MISSING_AGENT", "Missing --agent", "input", evidenceDir);
  }
  if (!projectDir) {
    return blockedEnvelope(command, runtime, startedAt, "MISSING_PROJECT", "Missing --project", "input", evidenceDir);
  }
  if (!isProjectDirSafe(projectDir)) {
    return blockedEnvelope(
      command,
      runtime,
      startedAt,
      "UNSAFE_PROJECT",
      "Project path is outside allowed roots",
      "input",
      evidenceDir,
    );
  }
  return null;
}

function blockedEnvelope(
  command: string,
  runtime: AgentTrustRuntime,
  startedAt: number,
  code: string,
  message: string,
  layer: "runtime" | "cli" | "input" = "runtime",
  evidenceDir?: string,
): AgentTrustEnvelope {
  return {
    ok: false,
    status: "blocked",
    command,
    runtime,
    elapsedMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
    evidenceDir,
    error: { code, message, layer },
  };
}

export async function buildAgentSessionStart(opts: AgentSessionStartOptions): Promise<AgentTrustEnvelope> {
  const startedAt = Date.now();
  const runtime = resolveRuntime(opts);
  const invalid = validateApprovedIdentity("agent session start", runtime, startedAt, opts.agentId, opts.projectDir, opts.evidenceDir);
  if (invalid) return invalid;

  try {
    const data = await fetchJson(runtime, "/api/v1/session/start", {
      method: "POST",
      headers: { "X-Ping-Mem-Approved-Path": "true" },
      body: JSON.stringify({
        name: `${opts.agentId}:approved-session`,
        agentId: opts.agentId,
        projectDir: opts.projectDir,
        autoIngest: false,
      }),
    });
    return {
      ok: true,
      status: "available",
      command: "agent session start",
      runtime,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      evidenceDir: opts.evidenceDir,
      data,
    };
  } catch (err) {
    return blockedEnvelope("agent session start", runtime, startedAt, "RUNTIME_UNAVAILABLE", (err as Error).message, "runtime", opts.evidenceDir);
  }
}

export async function buildAgentCodebaseVerify(opts: AgentCodebaseVerifyOptions): Promise<AgentTrustEnvelope> {
  const startedAt = Date.now();
  const runtime = resolveRuntime(opts);
  const invalid = validateApprovedIdentity("agent codebase verify", runtime, startedAt, opts.agentId, opts.projectDir, opts.evidenceDir);
  if (invalid) return invalid;

  try {
    const data = await fetchJson(runtime, "/api/v1/codebase/verify", {
      method: "POST",
      headers: { "X-Ping-Mem-Approved-Path": "true" },
      body: JSON.stringify({
        agentId: opts.agentId,
        projectDir: opts.projectDir,
      }),
    });
    return {
      ok: true,
      status: "available",
      command: "agent codebase verify",
      runtime,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      evidenceDir: opts.evidenceDir,
      data,
    };
  } catch (err) {
    return blockedEnvelope("agent codebase verify", runtime, startedAt, "RUNTIME_UNAVAILABLE", (err as Error).message, "runtime", opts.evidenceDir);
  }
}

export async function buildAgentCodebaseProjects(opts: AgentCodebaseProjectsOptions): Promise<AgentTrustEnvelope> {
  const startedAt = Date.now();
  const runtime = resolveRuntime(opts);
  const scope = opts.scope === "all" ? "all" : "registered";
  const limit = opts.limit ?? 1000;

  try {
    const params = new URLSearchParams();
    params.set("scope", scope);
    params.set("limit", String(limit));
    const data = await fetchJson(runtime, `/api/v1/codebase/projects?${params.toString()}`);
    return {
      ok: true,
      status: "available",
      command: "agent codebase projects",
      runtime,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      evidenceDir: opts.evidenceDir,
      data,
    };
  } catch (err) {
    return blockedEnvelope("agent codebase projects", runtime, startedAt, "RUNTIME_UNAVAILABLE", (err as Error).message, "runtime", opts.evidenceDir);
  }
}

function extractSessionId(data: unknown): string | null {
  const obj = data as { data?: { sessionId?: unknown; id?: unknown } };
  const sessionId = obj.data?.sessionId ?? obj.data?.id;
  return typeof sessionId === "string" ? sessionId : null;
}

function step(name: string, ok: boolean, detail?: string, data?: unknown): LifecycleStep {
  const result: LifecycleStep = { name, ok };
  if (detail !== undefined) result.detail = detail;
  if (data !== undefined) result.data = data;
  return result;
}

function toRuntimeProjectDir(projectDir: string): string {
  const hostRoot = process.env.PING_MEM_HOST_PROJECTS_ROOT ?? "/Users/umasankr/Projects";
  const containerRoot = process.env.PING_MEM_CONTAINER_PROJECTS_ROOT ?? "/projects";
  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedHostRoot = path.resolve(hostRoot);
  const hostPrefix = resolvedHostRoot.endsWith(path.sep) ? resolvedHostRoot : resolvedHostRoot + path.sep;
  if (resolvedProjectDir.startsWith(hostPrefix)) {
    return path.posix.join(containerRoot, path.relative(resolvedHostRoot, resolvedProjectDir).split(path.sep).join("/"));
  }
  return resolvedProjectDir;
}

function unwrapData<T = unknown>(value: unknown): T {
  const obj = value as { data?: unknown };
  return (obj && typeof obj === "object" && "data" in obj ? obj.data : value) as T;
}

function writeEvidenceArtifact(evidenceDir: string | undefined, fileName: string, data: unknown): string | undefined {
  if (!evidenceDir) return undefined;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const filePath = path.join(evidenceDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return filePath;
}

function firstSearchResult(search: unknown): Record<string, unknown> | null {
  const data = unwrapData<{ results?: unknown[] }>(search);
  const result = Array.isArray(data.results) ? data.results[0] : null;
  return result && typeof result === "object" ? result as Record<string, unknown> : null;
}

function verifyAnchorOnDisk(projectDir: string, result: Record<string, unknown>): { ok: boolean; detail: string; data?: unknown } {
  const filePath = typeof result.filePath === "string" ? result.filePath : "";
  const lineStart = typeof result.lineStart === "number" ? result.lineStart : 1;
  const lineEnd = typeof result.lineEnd === "number" ? result.lineEnd : lineStart;
  if (!filePath) return { ok: false, detail: "search result missing filePath" };

  const absolutePath = path.resolve(projectDir, filePath);
  if (!absolutePath.startsWith(path.resolve(projectDir) + path.sep)) {
    return { ok: false, detail: "source anchor escapes project directory", data: { filePath } };
  }
  if (!fs.existsSync(absolutePath)) {
    return { ok: false, detail: "source anchor file missing on disk", data: { absolutePath } };
  }
  const lines = fs.readFileSync(absolutePath, "utf-8").split(/\r?\n/);
  const boundedStart = Math.max(1, Math.floor(lineStart));
  const boundedEnd = Math.min(lines.length, Math.max(boundedStart, Math.floor(lineEnd)));
  const excerpt = lines.slice(boundedStart - 1, boundedEnd).join("\n");
  return {
    ok: excerpt.length > 0,
    detail: excerpt.length > 0 ? "source anchor exists on disk with non-empty line range" : "source anchor line range is empty",
    data: { absolutePath, filePath, lineStart: boundedStart, lineEnd: boundedEnd },
  };
}

export async function buildCodebaseGroundingProof(opts: CodebaseGroundingProofOptions): Promise<AgentTrustEnvelope> {
  const startedAt = Date.now();
  const runtime = resolveRuntime(opts);
  const invalid = validateApprovedIdentity("agent proof codebase-grounding", runtime, startedAt, opts.agentId, opts.projectDir, opts.evidenceDir);
  if (invalid) return invalid;

  const runtimeProjectDir = toRuntimeProjectDir(opts.projectDir!);
  const steps: LifecycleStep[] = [];
  let projectId: string | null = null;
  let anchorData: unknown = null;

  if (opts.simulate) {
    return simulatedFailureEnvelope("agent proof codebase-grounding", runtime, startedAt, opts.simulate, opts.evidenceDir);
  }

  try {
    const approvedHeaders = { "X-Ping-Mem-Approved-Path": "true" };

    const verify = await fetchJson(runtime, "/api/v1/codebase/verify", {
      method: "POST",
      headers: approvedHeaders,
      body: JSON.stringify({ agentId: opts.agentId, projectDir: runtimeProjectDir }),
    });
    const verifyData = unwrapData<{ projectId?: unknown; valid?: unknown; message?: unknown }>(verify);
    projectId = typeof verifyData.projectId === "string" && verifyData.projectId ? verifyData.projectId : null;
    steps.push(step("verify", Boolean(projectId) || verifyData.message === "No manifest found. Run ingest first.", String(verifyData.message ?? "verify completed"), verifyData));

    const ingest = await fetchJson(runtime, "/api/v1/codebase/ingest", {
      method: "POST",
      headers: approvedHeaders,
      body: JSON.stringify({ agentId: opts.agentId, projectDir: runtimeProjectDir, forceReingest: false }),
    });
    const ingestData = unwrapData<{ projectId?: unknown; chunksIndexed?: unknown; hadChanges?: unknown }>(ingest);
    if (typeof ingestData.projectId === "string" && ingestData.projectId) projectId = ingestData.projectId;
    steps.push(step("ingest", Boolean(projectId), "ingest completed or returned existing project identity", ingestData));
    if (!projectId) throw new Error("Codebase ingest did not return projectId");

    const projects = await fetchJson(runtime, "/api/v1/codebase/projects?scope=registered&limit=1000");
    const projectsData = unwrapData<{ count?: unknown; scope?: unknown; projects?: unknown[] }>(projects);
    steps.push(step(
      "registered-project-inventory",
      projectsData.scope === "registered" && Array.isArray(projectsData.projects),
      `runtime registered project count: ${String(projectsData.count ?? "unknown")}`,
      projectsData,
    ));

    const search = await fetchJson(runtime, `/api/v1/codebase/search?query=${encodeURIComponent("registered project")}&projectId=${encodeURIComponent(projectId)}&limit=5`);
    const result = firstSearchResult(search);
    steps.push(step("search", Boolean(result), "search returned source result for selected project", result));
    if (!result) throw new Error("Codebase search returned no source result");

    const anchor = verifyAnchorOnDisk(opts.projectDir!, result);
    anchorData = anchor.data;
    steps.push(step("source-anchor-disk-check", anchor.ok, anchor.detail, anchor.data));

    const timeline = await fetchJson(runtime, `/api/v1/codebase/timeline?projectId=${encodeURIComponent(projectId)}&limit=5`);
    const timelineData = unwrapData<unknown[]>(timeline);
    steps.push(step("timeline", Array.isArray(timelineData) && timelineData.length > 0, "timeline returned project events", { count: Array.isArray(timelineData) ? timelineData.length : 0 }));

    const unsafe = validateApprovedIdentity("agent codebase verify", runtime, Date.now(), opts.agentId, "/etc", opts.evidenceDir);
    steps.push(step("unsafe-project-rejected", Boolean(unsafe && unsafe.error?.code === "UNSAFE_PROJECT"), "unsafe project path is rejected before fetch", unsafe?.error));

    return {
      ok: steps.every((s) => s.ok),
      status: steps.every((s) => s.ok) ? "available" : "blocked",
      command: "agent proof codebase-grounding",
      runtime,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      evidenceDir: opts.evidenceDir,
      data: { agentId: opts.agentId, projectDir: opts.projectDir, runtimeProjectDir, projectId, anchor: anchorData, steps },
    };
  } catch (err) {
    const classified = classifyRuntimeError(err as Error);
    return {
      ...blockedEnvelope("agent proof codebase-grounding", runtime, startedAt, classified.code, classified.message, "runtime", opts.evidenceDir),
      data: { agentId: opts.agentId, projectDir: opts.projectDir, runtimeProjectDir, projectId, anchor: anchorData, steps },
    };
  }
}

export async function buildAgentGraphAnswer(opts: AgentGraphAnswerOptions): Promise<AgentTrustEnvelope> {
  const startedAt = Date.now();
  const runtime = resolveRuntime(opts);
  const invalid = validateApprovedIdentity("agent graph answer", runtime, startedAt, opts.agentId, opts.projectDir, opts.evidenceDir);
  if (invalid) return invalid;

  try {
    const body: Record<string, unknown> = {
      agentId: opts.agentId,
      projectDir: opts.projectDir,
      mode: opts.mode,
      population: {
        kind: "project",
        root: opts.projectDir,
        corpusId: `project:${opts.projectDir}`,
      },
    };
    if (opts.query) body.query = opts.query;
    if (opts.expectedCorpusHash) body.expectedCorpusHash = opts.expectedCorpusHash;
    if (opts.requireFreshness !== undefined) body.requireFreshness = opts.requireFreshness;
    if (opts.limit !== undefined) body.limit = opts.limit;

    const response = await fetchJson(runtime, "/api/v1/graph/answer", {
      method: "POST",
      headers: { "X-Ping-Mem-Approved-Path": "true" },
      body: JSON.stringify(body),
    });
    const data = unwrapData(response);
    const evidenceFile = writeEvidenceArtifact(opts.evidenceDir, `${opts.mode}-answer.json`, data);
    return {
      ok: true,
      status: "available",
      command: "agent graph answer",
      runtime,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      evidenceDir: opts.evidenceDir,
      data: evidenceFile ? { answer: data, evidenceFile } : data,
    };
  } catch (err) {
    const classified = classifyRuntimeError(err as Error);
    return blockedEnvelope("agent graph answer", runtime, startedAt, classified.code, classified.message, "runtime", opts.evidenceDir);
  }
}

export async function buildMemoryLifecycleProof(opts: MemoryLifecycleDryRunOptions): Promise<AgentTrustEnvelope> {
  const startedAt = Date.now();
  const runtime = resolveRuntime(opts);
  const invalid = validateApprovedIdentity("agent proof memory-lifecycle", runtime, startedAt, opts.agentId, opts.projectDir, opts.evidenceDir);
  if (invalid) return invalid;
  if (opts.dryRun) return buildMemoryLifecycleDryRun(opts);

  const key = `ground-up/${opts.agentId}/${Date.now()}`;
  const originalValue = `ping-mem lifecycle proof original ${key}`;
  const updatedValue = `ping-mem lifecycle proof updated ${key}`;
  const steps: LifecycleStep[] = [];
  let sessionId: string | null = null;

  if (opts.simulate) {
    return simulatedFailureEnvelope("agent proof memory-lifecycle", runtime, startedAt, opts.simulate, opts.evidenceDir);
  }

  try {
    const session = await fetchJson(runtime, "/api/v1/session/start", {
      method: "POST",
      headers: { "X-Ping-Mem-Approved-Path": "true" },
      body: JSON.stringify({
        name: `${opts.agentId}:memory-lifecycle-proof`,
        agentId: opts.agentId,
        projectDir: opts.projectDir,
        autoIngest: false,
      }),
    });
    sessionId = extractSessionId(session);
    steps.push(step("start-session", Boolean(sessionId), sessionId ?? "missing sessionId"));
    if (!sessionId) throw new Error("Session start response did not include sessionId");

    const approvedHeaders = { "X-Ping-Mem-Approved-Path": "true", "X-Session-ID": sessionId };

    await fetchJson(runtime, "/api/v1/context", {
      method: "POST",
      headers: approvedHeaders,
      body: JSON.stringify({ key, value: originalValue, category: "note", skipProactiveRecall: true }),
    });
    steps.push(step("save", true));

    const search = await fetchJson(runtime, `/api/v1/search?query=${encodeURIComponent(originalValue)}&limit=5`, {
      headers: approvedHeaders,
    });
    steps.push(step("search", JSON.stringify(search).includes(key), "search response contains unique key"));

    const retrieved = await fetchJson(runtime, `/api/v1/context/${encodeURIComponent(key)}`, {
      headers: approvedHeaders,
    });
    steps.push(step("retrieve", JSON.stringify(retrieved).includes(originalValue), "retrieved original value"));

    await fetchJson(runtime, `/api/v1/context/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: approvedHeaders,
      body: JSON.stringify({ value: updatedValue, category: "note" }),
    });
    steps.push(step("update-or-supersede", true));

    const recall = await fetchJson(runtime, "/api/v1/memory/auto-recall", {
      method: "POST",
      headers: approvedHeaders,
      body: JSON.stringify({ query: updatedValue, limit: 5 }),
    });
    steps.push(step("recall", JSON.stringify(recall).includes("recalled"), "auto-recall returned structured response"));

    await fetchJson(runtime, `/api/v1/context/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: approvedHeaders,
    });
    steps.push(step("delete", true));

    let absentOk = false;
    try {
      await fetchJson(runtime, `/api/v1/context/${encodeURIComponent(key)}`, {
        headers: approvedHeaders,
      });
    } catch (err) {
      absentOk = (err as Error).message.startsWith("HTTP 404:");
      if (!absentOk) throw err;
    }
    steps.push(step("confirm-absent", absentOk, "deleted key returns 404 from context lookup"));

    await fetchJson(runtime, "/api/v1/session/end", {
      method: "POST",
      headers: approvedHeaders,
      body: JSON.stringify({ sessionId }),
    });
    steps.push(step("end-session", true));

    return {
      ok: steps.every((s) => s.ok),
      status: steps.every((s) => s.ok) ? "available" : "blocked",
      command: "agent proof memory-lifecycle",
      runtime,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      evidenceDir: opts.evidenceDir,
      data: { agentId: opts.agentId, projectDir: opts.projectDir, sessionId, key, steps },
    };
  } catch (err) {
    if (sessionId) {
      await fetchJson(runtime, `/api/v1/context/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: { "X-Ping-Mem-Approved-Path": "true", "X-Session-ID": sessionId },
      }).catch(() => null);
      await fetchJson(runtime, "/api/v1/session/end", {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      }).catch(() => null);
    }
    const classified = classifyRuntimeError(err as Error);
    return {
      ...blockedEnvelope("agent proof memory-lifecycle", runtime, startedAt, classified.code, classified.message, "runtime", opts.evidenceDir),
      data: { agentId: opts.agentId, projectDir: opts.projectDir, sessionId, key, steps },
    };
  }
}

export async function buildAgentStatus(opts: AgentRuntimeOptions = {}): Promise<AgentTrustEnvelope> {
  const startedAt = Date.now();
  const runtime = resolveRuntime(opts);
  try {
    const data = await fetchJson(runtime, "/health");
    return {
      ok: true,
      status: "available",
      command: "agent status",
      runtime,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      evidenceDir: opts.evidenceDir,
      data,
    };
  } catch (err) {
    const error = err as Error;
    const classified = classifyRuntimeError(error);
    return blockedEnvelope(
      "agent status",
      runtime,
      startedAt,
      classified.code,
      classified.code === "RUNTIME_TIMEOUT" ? `Timed out after ${runtime.timeoutMs}ms` : classified.message,
      "runtime",
      opts.evidenceDir,
    );
  }
}

export function buildMemoryLifecycleDryRun(opts: MemoryLifecycleDryRunOptions): AgentTrustEnvelope {
  const startedAt = Date.now();
  const runtime = resolveRuntime(opts);
  const invalid = validateApprovedIdentity("agent proof memory-lifecycle", runtime, startedAt, opts.agentId, opts.projectDir, opts.evidenceDir);
  if (invalid) return invalid;
  if (!opts.dryRun) {
    return blockedEnvelope(
      "agent proof memory-lifecycle",
      runtime,
      startedAt,
      "PROOF_NOT_IMPLEMENTED",
      "S003 only creates the read-only trust spine. Operational lifecycle execution is owned by S005 and S006.",
      "cli",
      opts.evidenceDir,
    );
  }

  return {
    ok: true,
    status: "dry-run",
    command: "agent proof memory-lifecycle",
    runtime,
    elapsedMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
    evidenceDir: opts.evidenceDir,
    data: {
      readOnly: true,
      mutatesRuntime: false,
      agentId: opts.agentId,
      projectDir: opts.projectDir,
      requiredIdentity: ["agentId", "projectDir", "sessionId"],
      plannedOperations: ["start-session", "save", "search", "retrieve", "update-or-supersede", "delete", "confirm-absent", "end-session"],
      nextOwners: ["S004 identity and project path safety", "S005 Codex memory path", "S006 Claude Code memory path"],
    },
  };
}
