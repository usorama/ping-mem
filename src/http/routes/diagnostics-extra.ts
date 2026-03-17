import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import type { RESTErrorResponse, RESTSuccessResponse } from "../types.js";
import type { DiagnosticsStore } from "../../diagnostics/index.js";

export interface DiagnosticsExtraRoutesDeps { diagnosticsStore: DiagnosticsStore; }
const AID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function registerDiagnosticsExtraRoutes(app: Hono<AppEnv>, deps: DiagnosticsExtraRoutesDeps): void {
  app.get("/api/v1/diagnostics/compare", async (c) => {
    try {
      const projectId = c.req.query("projectId"), treeHash = c.req.query("treeHash");
      if (!projectId || !treeHash) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "projectId and treeHash are required" }, 400);
      if (projectId.length > 128 || treeHash.length > 200) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Parameter too long" }, 400);
      const toolNames = c.req.query("toolNames")?.split(",") ?? ["tsc", "eslint", "prettier"];
      const runs: Array<{ toolName: string; analysisId: string; status: string; createdAt: string }> = [];
      for (const tn of toolNames) { const r = deps.diagnosticsStore.getLatestRun({ projectId, treeHash, toolName: tn }); if (r) runs.push({ toolName: r.tool.name, analysisId: r.analysisId, status: r.status, createdAt: r.createdAt }); }
      const summaries = runs.map((r) => { const f = deps.diagnosticsStore.listFindings(r.analysisId); const bs: Record<string, number> = {}; const fs = new Set<string>(); for (const x of f) { bs[x.severity] = (bs[x.severity] ?? 0) + 1; fs.add(x.filePath); } return { ...r, total: f.length, bySeverity: bs, affectedFiles: fs.size }; });
      const af = new Map<string, string[]>(); for (const r of runs) for (const f of deps.diagnosticsStore.listFindings(r.analysisId)) { if (!af.has(f.filePath)) af.set(f.filePath, []); af.get(f.filePath)!.push(r.toolName); }
      const overlap = Array.from(af.entries()).filter(([, t]) => t.length > 1).map(([fp, t]) => ({ filePath: fp, tools: Array.from(new Set(t)).sort() }));
      const agg: Record<string, number> = {}; for (const s of summaries) for (const [k, v] of Object.entries(s.bySeverity)) agg[k] = (agg[k] ?? 0) + v;
      return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { projectId, treeHash, toolCount: summaries.length, tools: summaries, overlappingFiles: overlap.slice(0, 20), aggregateSeverity: agg, totalFindings: summaries.reduce((s, x) => s + x.total, 0) } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });

  app.get("/api/v1/diagnostics/by-symbol", async (c) => {
    try {
      const aid = c.req.query("analysisId"); if (!aid || !AID_RE.test(aid)) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Valid analysisId is required" }, 400);
      const groupBy = (c.req.query("groupBy") as "symbol" | "file") ?? "symbol";
      const findings = deps.diagnosticsStore.listFindings(aid);
      if (groupBy === "symbol") {
        const g = new Map<string, { symbolName: string; symbolKind: string; filePath: string; count: number; bySeverity: Record<string, number> }>();
        for (const f of findings) { if (!f.symbolId || !f.symbolName) continue; if (!g.has(f.symbolId)) g.set(f.symbolId, { symbolName: f.symbolName, symbolKind: f.symbolKind ?? "unknown", filePath: f.filePath, count: 0, bySeverity: {} }); const x = g.get(f.symbolId)!; x.count++; x.bySeverity[f.severity] = (x.bySeverity[f.severity] ?? 0) + 1; }
        const symbols = Array.from(g.entries()).map(([id, x]) => ({ symbolId: id, ...x, total: x.count })).sort((a, b) => b.total - a.total);
        return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { analysisId: aid, groupBy: "symbol", symbolCount: symbols.length, symbols, totalAttributed: symbols.reduce((s, x) => s + x.total, 0), totalUnattributed: findings.filter((f) => !f.symbolId).length } });
      } else {
        const g = new Map<string, { symbols: Map<string, { symbolName: string; symbolKind: string; count: number }>; total: number }>();
        for (const f of findings) { if (!g.has(f.filePath)) g.set(f.filePath, { symbols: new Map(), total: 0 }); const x = g.get(f.filePath)!; x.total++; if (f.symbolId && f.symbolName) { if (!x.symbols.has(f.symbolId)) x.symbols.set(f.symbolId, { symbolName: f.symbolName, symbolKind: f.symbolKind ?? "unknown", count: 0 }); x.symbols.get(f.symbolId)!.count++; } }
        const files = Array.from(g.entries()).map(([fp, x]) => ({ filePath: fp, total: x.total, symbols: Array.from(x.symbols.entries()).map(([id, s]) => ({ symbolId: id, ...s })).sort((a, b) => b.count - a.count) })).sort((a, b) => b.total - a.total);
        return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { analysisId: aid, groupBy: "file", fileCount: files.length, files } });
      }
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
}
