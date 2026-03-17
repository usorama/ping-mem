import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import type { RESTErrorResponse } from "../types.js";
import type { GraphManager } from "../../graph/GraphManager.js";
import type { HybridSearchEngine } from "../../search/HybridSearchEngine.js";
import type { LineageEngine } from "../../graph/LineageEngine.js";
import type { EvolutionEngine } from "../../graph/EvolutionEngine.js";
import type { EventStore } from "../../storage/EventStore.js";
import type { QdrantClientWrapper } from "../../search/QdrantClient.js";
import type { DiagnosticsStore } from "../../diagnostics/index.js";
import { RelationshipType } from "../../types/index.js";
import type { Entity, SessionId } from "../../types/index.js";
import type { SearchWeights } from "../../search/HybridSearchEngine.js";
import { probeSystemHealth, sanitizeHealthError } from "../../observability/health-probes.js";

export interface GraphRoutesDeps {
  graphManager: GraphManager | null;
  hybridSearchEngine: HybridSearchEngine | null;
  lineageEngine: LineageEngine | null;
  evolutionEngine: EvolutionEngine | null;
  eventStore: EventStore;
  qdrantClient: QdrantClientWrapper | null;
  diagnosticsStore: DiagnosticsStore | null;
}

export function registerGraphRoutes(app: Hono<AppEnv>, deps: GraphRoutesDeps): void {
  app.get("/api/v1/graph/relationships", async (c) => {
    try {
      if (!deps.graphManager) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "GraphManager not configured" }, 503);
      const entityId = c.req.query("entityId");
      if (!entityId) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "entityId is required" }, 400);
      const depth = parseInt(c.req.query("depth") ?? "1", 10);
      const direction = (c.req.query("direction") as "incoming" | "outgoing" | "both") ?? "both";
      const rtRaw = c.req.query("relationshipTypes");
      const validRT = rtRaw ? new Set(rtRaw.split(",").map((t) => t as RelationshipType)) : null;
      const allR = await deps.graphManager.findRelationshipsByEntity(entityId);
      const filtered = allR.filter((r) => { if (direction === "outgoing" && r.sourceId !== entityId) return false; if (direction === "incoming" && r.targetId !== entityId) return false; if (validRT && !validRT.has(r.type)) return false; return true; });
      const ids = new Set<string>(); for (const r of filtered) { if (r.sourceId !== entityId) ids.add(r.sourceId); if (r.targetId !== entityId) ids.add(r.targetId); }
      const entities: Entity[] = []; for (const id of ids) { const e = await deps.graphManager.getEntity(id); if (e) entities.push(e); }
      const paths = filtered.map((r) => ({ from: r.sourceId, relationship: r.type, to: r.targetId }));
      if (depth > 1) { const vis = new Set([entityId, ...ids]); let lv = [...ids]; for (let d = 1; d < depth && lv.length > 0; d++) { const nx: string[] = []; for (const cur of lv) { for (const r of await deps.graphManager.findRelationshipsByEntity(cur)) { if (validRT && !validRT.has(r.type)) continue; if (direction === "outgoing" && r.sourceId !== cur) continue; if (direction === "incoming" && r.targetId !== cur) continue; const o = r.sourceId === cur ? r.targetId : r.sourceId; if (!vis.has(o)) { vis.add(o); nx.push(o); const e = await deps.graphManager.getEntity(o); if (e) entities.push(e); paths.push({ from: r.sourceId, relationship: r.type, to: r.targetId }); } } } lv = nx; } }
      return c.json({ data: { entities: entities.map((e) => ({ id: e.id, type: e.type, name: e.name, properties: e.properties, createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString() })), relationships: filtered.map((r) => ({ id: r.id, type: r.type, sourceId: r.sourceId, targetId: r.targetId, weight: r.weight, properties: r.properties, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() })), paths } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown error" }, 500); }
  });

  app.post("/api/v1/graph/hybrid-search", async (c) => {
    try {
      if (!deps.hybridSearchEngine) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "HybridSearchEngine not configured" }, 503);
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON" }, 400); }
      if (typeof body.query !== "string" || body.query.length === 0) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "query is required" }, 400);
      const opts: { limit?: number; sessionId?: SessionId; weights?: Partial<SearchWeights> } = {};
      if (typeof body.limit === "number") opts.limit = body.limit; if (typeof body.sessionId === "string") opts.sessionId = body.sessionId as SessionId; if (body.weights && typeof body.weights === "object") opts.weights = body.weights as Partial<SearchWeights>;
      const res = await deps.hybridSearchEngine.search(body.query as string, opts);
      return c.json({ data: { query: body.query, count: res.length, results: res.map((r) => ({ memoryId: r.memoryId, sessionId: r.sessionId, content: r.content, hybridScore: r.hybridScore, searchModes: r.searchModes, graphContext: r.graphContext, modeScores: r.modeScores })) } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown error" }, 500); }
  });

  app.get("/api/v1/graph/lineage/:entity", async (c) => {
    try {
      if (!deps.lineageEngine) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "LineageEngine not configured" }, 503);
      const entityId = c.req.param("entity"); const dir = (c.req.query("direction") as "upstream" | "downstream" | "both") ?? "both";
      const md = c.req.query("maxDepth") ? parseInt(c.req.query("maxDepth")!, 10) : undefined;
      let up: Entity[] = []; let dn: Entity[] = [];
      if (dir === "upstream" || dir === "both") up = await deps.lineageEngine.getAncestors(entityId, md);
      if (dir === "downstream" || dir === "both") dn = await deps.lineageEngine.getDescendants(entityId, md);
      return c.json({ data: { entityId, direction: dir, upstream: up.map((e) => ({ id: e.id, type: e.type, name: e.name, properties: e.properties, eventTime: e.eventTime.toISOString() })), downstream: dn.map((e) => ({ id: e.id, type: e.type, name: e.name, properties: e.properties, eventTime: e.eventTime.toISOString() })), upstreamCount: up.length, downstreamCount: dn.length } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown error" }, 500); }
  });

  app.get("/api/v1/graph/evolution", async (c) => {
    try {
      if (!deps.evolutionEngine) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "EvolutionEngine not configured" }, 503);
      const eid = c.req.query("entityId"); if (!eid) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "entityId is required" }, 400);
      const qo: { startTime?: Date; endTime?: Date } = {}; if (c.req.query("startTime")) qo.startTime = new Date(c.req.query("startTime")!); if (c.req.query("endTime")) qo.endTime = new Date(c.req.query("endTime")!);
      const ev = await deps.evolutionEngine.getEvolution(eid, qo);
      return c.json({ data: { entityId: ev.entityId, entityName: ev.entityName, startTime: ev.startTime.toISOString(), endTime: ev.endTime.toISOString(), totalChanges: ev.totalChanges, changes: ev.changes.map((ch) => ({ timestamp: ch.timestamp.toISOString(), changeType: ch.changeType, entityId: ch.entityId, entityName: ch.entityName, previousState: ch.previousState ? { id: ch.previousState.id, type: ch.previousState.type, name: ch.previousState.name, properties: ch.previousState.properties } : null, currentState: ch.currentState ? { id: ch.currentState.id, type: ch.currentState.type, name: ch.currentState.name, properties: ch.currentState.properties } : null, metadata: ch.metadata })) } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown error" }, 500); }
  });

  app.get("/api/v1/graph/health", async (c) => {
    try {
      const snap = await probeSystemHealth({ eventStore: deps.eventStore, ...(deps.graphManager ? { graphManager: deps.graphManager } : {}), ...(deps.qdrantClient ? { qdrantClient: deps.qdrantClient } : {}), ...(deps.diagnosticsStore ? { diagnosticsStore: deps.diagnosticsStore } : {}) });
      const comps = Object.fromEntries(Object.entries(snap.components).map(([k, v]) => [k, v.error ? { ...v, error: sanitizeHealthError(v.error) } : v]));
      return c.json({ data: { status: snap.status === "ok" ? "healthy" : snap.status === "degraded" ? "degraded" : "unhealthy", timestamp: new Date().toISOString(), version: "1.0.0", components: comps } });
    } catch { return c.json({ data: { status: "unhealthy", timestamp: new Date().toISOString(), version: "1.0.0", error: "Health probe failed" } }); }
  });
}
