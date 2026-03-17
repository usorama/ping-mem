import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import { TOOLS } from "../../mcp/PingMemServer.js";

function inferTag(n: string): string {
  if (n.startsWith("context_")) return "Context"; if (n.startsWith("codebase_") || n === "project_delete") return "Codebase";
  if (n.startsWith("diagnostics_")) return "Diagnostics"; if (n.startsWith("memory_")) return "Memory";
  if (n.startsWith("worklog_")) return "Worklog"; if (n.startsWith("agent_")) return "Agent";
  if (n.startsWith("knowledge_")) return "Knowledge";
  if (n.startsWith("search_") || n.startsWith("get_causal_") || n === "trigger_causal_discovery") return "Causal";
  return "Other";
}
function ps(p: Record<string, unknown>): Record<string, unknown> { const s: Record<string, unknown> = {}; for (const k of ["type", "description", "enum", "items", "properties"]) if (p[k] !== undefined) s[k] = p[k]; return s; }

const EP: Record<string, { method: string; path: string; isGet: boolean }> = {
  context_session_start: { method: "post", path: "/api/v1/session/start", isGet: false }, context_session_end: { method: "post", path: "/api/v1/session/end", isGet: false },
  context_session_list: { method: "get", path: "/api/v1/session/list", isGet: true }, context_save: { method: "post", path: "/api/v1/context", isGet: false },
  context_get: { method: "get", path: "/api/v1/context/{key}", isGet: true }, context_search: { method: "get", path: "/api/v1/search", isGet: true },
  context_delete: { method: "delete", path: "/api/v1/context/{key}", isGet: false }, context_checkpoint: { method: "post", path: "/api/v1/checkpoint", isGet: false },
  context_status: { method: "get", path: "/api/v1/status", isGet: true }, context_query_relationships: { method: "get", path: "/api/v1/graph/relationships", isGet: true },
  context_hybrid_search: { method: "post", path: "/api/v1/graph/hybrid-search", isGet: false }, context_get_lineage: { method: "get", path: "/api/v1/graph/lineage/{entity}", isGet: true },
  context_query_evolution: { method: "get", path: "/api/v1/graph/evolution", isGet: true }, context_health: { method: "get", path: "/api/v1/graph/health", isGet: true },
  worklog_record: { method: "post", path: "/api/v1/worklog", isGet: false }, worklog_list: { method: "get", path: "/api/v1/worklog", isGet: true },
  diagnostics_ingest: { method: "post", path: "/api/v1/diagnostics/ingest", isGet: false }, diagnostics_latest: { method: "get", path: "/api/v1/diagnostics/latest", isGet: true },
  diagnostics_list: { method: "get", path: "/api/v1/diagnostics/findings/{analysisId}", isGet: true }, diagnostics_diff: { method: "post", path: "/api/v1/diagnostics/diff", isGet: false },
  diagnostics_summary: { method: "get", path: "/api/v1/diagnostics/summary/{analysisId}", isGet: true }, diagnostics_compare_tools: { method: "get", path: "/api/v1/diagnostics/compare", isGet: true },
  diagnostics_by_symbol: { method: "get", path: "/api/v1/diagnostics/by-symbol", isGet: true }, diagnostics_summarize: { method: "post", path: "/api/v1/diagnostics/summarize/{analysisId}", isGet: false },
  codebase_ingest: { method: "post", path: "/api/v1/codebase/ingest", isGet: false }, codebase_verify: { method: "post", path: "/api/v1/codebase/verify", isGet: false },
  codebase_search: { method: "get", path: "/api/v1/codebase/search", isGet: true }, codebase_timeline: { method: "get", path: "/api/v1/codebase/timeline", isGet: true },
  codebase_list_projects: { method: "get", path: "/api/v1/codebase/projects", isGet: true }, project_delete: { method: "delete", path: "/api/v1/codebase/projects/{id}", isGet: false },
  memory_stats: { method: "get", path: "/api/v1/memory/stats", isGet: true }, memory_consolidate: { method: "post", path: "/api/v1/memory/consolidate", isGet: false },
  memory_subscribe: { method: "post", path: "/api/v1/memory/subscribe", isGet: false }, memory_unsubscribe: { method: "post", path: "/api/v1/memory/unsubscribe", isGet: false },
  memory_compress: { method: "post", path: "/api/v1/memory/compress", isGet: false }, search_causes: { method: "get", path: "/api/v1/causal/causes", isGet: true },
  search_effects: { method: "get", path: "/api/v1/causal/effects", isGet: true }, get_causal_chain: { method: "get", path: "/api/v1/causal/chain", isGet: true },
  trigger_causal_discovery: { method: "post", path: "/api/v1/causal/discover", isGet: false }, knowledge_search: { method: "post", path: "/api/v1/knowledge/search", isGet: false },
  knowledge_ingest: { method: "post", path: "/api/v1/knowledge/ingest", isGet: false }, agent_register: { method: "post", path: "/api/v1/agents/register", isGet: false },
  agent_quota_status: { method: "get", path: "/api/v1/agents/quotas", isGet: true }, agent_deregister: { method: "delete", path: "/api/v1/agents/{agentId}", isGet: false },
};

function generate(): Record<string, unknown> {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const tool of TOOLS) {
    const ep = EP[tool.name]; if (!ep) continue;
    const op: Record<string, unknown> = { summary: tool.description, operationId: tool.name, tags: [inferTag(tool.name)], responses: { "200": { description: "Success" }, "400": { description: "Bad request" }, "500": { description: "Server error" } } };
    const pp = ep.path.match(/\{(\w+)\}/g); const ppn = new Set(pp?.map((p) => p.slice(1, -1)) ?? []);
    if (ep.isGet) { const params: Array<Record<string, unknown>> = []; for (const [k, v] of Object.entries(tool.inputSchema.properties)) { const d = v as Record<string, unknown>; params.push(ppn.has(k) ? { name: k, in: "path", required: true, schema: ps(d), description: d.description } : { name: k, in: "query", required: tool.inputSchema.required?.includes(k) ?? false, schema: ps(d), description: d.description }); } if (params.length > 0) op.parameters = params; }
    else { if (ppn.size > 0) op.parameters = Array.from(ppn).map((n) => ({ name: n, in: "path", required: true, schema: { type: "string" } })); const bp: Record<string, unknown> = {}; for (const [k, v] of Object.entries(tool.inputSchema.properties)) if (!ppn.has(k)) bp[k] = ps(v as Record<string, unknown>); if (Object.keys(bp).length > 0) op.requestBody = { required: true, content: { "application/json": { schema: { type: "object", properties: bp, required: tool.inputSchema.required ?? [] } } } }; }
    if (!paths[ep.path]) paths[ep.path] = {}; paths[ep.path]![ep.method] = op;
  }
  paths["/health"] = { get: { summary: "Health check", operationId: "healthCheck", tags: ["Infrastructure"], responses: { "200": { description: "OK" } } } };
  paths["/api/v1/tools"] = { get: { summary: "List tools", operationId: "listTools", tags: ["Tools"], responses: { "200": { description: "Tool list" } } } };
  paths["/api/v1/tools/{name}"] = { get: { summary: "Get tool", operationId: "getToolSchema", tags: ["Tools"], parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" }, "404": { description: "Not found" } } } };
  paths["/api/v1/tools/{name}/invoke"] = { post: { summary: "Invoke tool", operationId: "invokeTool", tags: ["Tools"], parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { arguments: { type: "object" } } } } } }, responses: { "200": { description: "OK" } } } };
  return { openapi: "3.1.0", info: { title: "ping-mem REST API", version: "2.0.0", description: "Universal Memory Layer for AI agents." }, servers: [{ url: "http://localhost:3000", description: "Local" }], paths, components: { securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" }, BearerAuth: { type: "http", scheme: "bearer" } }, schemas: { ErrorResponse: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } }, required: ["error", "message"] } } }, security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }] };
}

let cached: Record<string, unknown> | null = null;
export function registerOpenAPIRoute(app: Hono<AppEnv>): void { app.get("/openapi.json", (c) => { if (!cached) cached = generate(); return c.json(cached); }); }
