import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import type { RESTErrorResponse, RESTSuccessResponse } from "../types.js";
import { TOOLS } from "../../mcp/PingMemServer.js";
import type { ToolDefinition } from "../../mcp/types.js";

function inferModule(n: string): string {
  if (n.startsWith("context_")) return "context"; if (n.startsWith("codebase_") || n === "project_delete") return "codebase";
  if (n.startsWith("diagnostics_")) return "diagnostics"; if (n.startsWith("memory_")) return "memory";
  if (n.startsWith("worklog_")) return "worklog"; if (n.startsWith("agent_")) return "agent";
  if (n.startsWith("knowledge_")) return "knowledge";
  if (n.startsWith("search_") || n.startsWith("get_causal_") || n === "trigger_causal_discovery") return "causal";
  return "unknown";
}
export interface ToolListItem { name: string; description: string; inputSchema: ToolDefinition["inputSchema"]; module: string; }

export function registerToolDiscoveryRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/tools", (c) => {
    const mod = c.req.query("module"); let tools = TOOLS; if (mod) tools = TOOLS.filter((t) => inferModule(t.name) === mod);
    const items: ToolListItem[] = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, module: inferModule(t.name) }));
    return c.json<RESTSuccessResponse<{ tools: ToolListItem[]; count: number }>>({ data: { tools: items, count: items.length } });
  });
  app.get("/api/v1/tools/:name", (c) => {
    const name = c.req.param("name"); const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return c.json<RESTErrorResponse>({ error: "Not Found", message: `Tool '${name}' not found` }, 404);
    return c.json<RESTSuccessResponse<ToolListItem>>({ data: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, module: inferModule(tool.name) } });
  });
  app.post("/api/v1/tools/:name/invoke", async (c) => {
    const name = c.req.param("name"); const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return c.json<RESTErrorResponse>({ error: "Not Found", message: `Tool '${name}' not found` }, 404);
    let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON" }, 400); }
    const args = (body.arguments ?? body) as Record<string, unknown>;
    const map: Record<string, { method: string; path: string }> = {
      context_session_start: { method: "POST", path: "/api/v1/session/start" }, context_session_end: { method: "POST", path: "/api/v1/session/end" },
      context_session_list: { method: "GET", path: "/api/v1/session/list" }, context_save: { method: "POST", path: "/api/v1/context" },
      context_get: { method: "GET", path: `/api/v1/context/${args.key ?? ":key"}` }, context_search: { method: "GET", path: "/api/v1/search" },
      context_delete: { method: "DELETE", path: `/api/v1/context/${args.key ?? ":key"}` }, context_checkpoint: { method: "POST", path: "/api/v1/checkpoint" },
      context_status: { method: "GET", path: "/api/v1/status" }, context_query_relationships: { method: "GET", path: "/api/v1/graph/relationships" },
      context_hybrid_search: { method: "POST", path: "/api/v1/graph/hybrid-search" }, context_get_lineage: { method: "GET", path: `/api/v1/graph/lineage/${args.entityId ?? ":entity"}` },
      context_query_evolution: { method: "GET", path: "/api/v1/graph/evolution" }, context_health: { method: "GET", path: "/api/v1/graph/health" },
      worklog_record: { method: "POST", path: "/api/v1/worklog" }, worklog_list: { method: "GET", path: "/api/v1/worklog" },
      diagnostics_ingest: { method: "POST", path: "/api/v1/diagnostics/ingest" }, diagnostics_latest: { method: "GET", path: "/api/v1/diagnostics/latest" },
      diagnostics_list: { method: "GET", path: `/api/v1/diagnostics/findings/${args.analysisId ?? ":analysisId"}` }, diagnostics_diff: { method: "POST", path: "/api/v1/diagnostics/diff" },
      diagnostics_summary: { method: "GET", path: `/api/v1/diagnostics/summary/${args.analysisId ?? ":analysisId"}` }, diagnostics_compare_tools: { method: "GET", path: "/api/v1/diagnostics/compare" },
      diagnostics_by_symbol: { method: "GET", path: "/api/v1/diagnostics/by-symbol" }, diagnostics_summarize: { method: "POST", path: `/api/v1/diagnostics/summarize/${args.analysisId ?? ":analysisId"}` },
      codebase_ingest: { method: "POST", path: "/api/v1/codebase/ingest" }, codebase_verify: { method: "POST", path: "/api/v1/codebase/verify" },
      codebase_search: { method: "GET", path: "/api/v1/codebase/search" }, codebase_timeline: { method: "GET", path: "/api/v1/codebase/timeline" },
      codebase_list_projects: { method: "GET", path: "/api/v1/codebase/projects" }, project_delete: { method: "DELETE", path: `/api/v1/codebase/projects/${encodeURIComponent(String(args.projectDir ?? ":id"))}` },
      memory_stats: { method: "GET", path: "/api/v1/memory/stats" }, memory_consolidate: { method: "POST", path: "/api/v1/memory/consolidate" },
      memory_subscribe: { method: "POST", path: "/api/v1/memory/subscribe" }, memory_unsubscribe: { method: "POST", path: "/api/v1/memory/unsubscribe" },
      memory_compress: { method: "POST", path: "/api/v1/memory/compress" }, search_causes: { method: "GET", path: "/api/v1/causal/causes" },
      search_effects: { method: "GET", path: "/api/v1/causal/effects" }, get_causal_chain: { method: "GET", path: "/api/v1/causal/chain" },
      trigger_causal_discovery: { method: "POST", path: "/api/v1/causal/discover" }, knowledge_search: { method: "POST", path: "/api/v1/knowledge/search" },
      knowledge_ingest: { method: "POST", path: "/api/v1/knowledge/ingest" }, agent_register: { method: "POST", path: "/api/v1/agents/register" },
      agent_quota_status: { method: "GET", path: "/api/v1/agents/quotas" }, agent_deregister: { method: "DELETE", path: `/api/v1/agents/${args.agentId ?? ":agentId"}` },
    };
    const ep = map[name]; if (!ep) return c.json<RESTErrorResponse>({ error: "Not Implemented", message: `No REST mapping for '${name}'` }, 501);
    return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { tool: name, restEndpoint: ep, arguments: args, message: `Use ${ep.method} ${ep.path} directly.` } });
  });
}
