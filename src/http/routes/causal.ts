import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import type { RESTErrorResponse } from "../types.js";
import type { CausalGraphManager } from "../../graph/CausalGraphManager.js";
import type { CausalDiscoveryAgent } from "../../graph/CausalDiscoveryAgent.js";

export interface CausalRoutesDeps { causalGraphManager: CausalGraphManager | null; causalDiscoveryAgent: CausalDiscoveryAgent | null; }

export function registerCausalRoutes(app: Hono<AppEnv>, deps: CausalRoutesDeps): void {
  app.get("/api/v1/causal/causes", async (c) => {
    try {
      if (!deps.causalGraphManager) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "Causal graph not configured" }, 503);
      const entityId = c.req.query("entityId"); if (!entityId) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "entityId is required" }, 400);
      const causes = await deps.causalGraphManager.getCausesOf(entityId, { limit: parseInt(c.req.query("limit") ?? "10", 10) });
      return c.json({ data: { query: c.req.query("query") ?? "", causes } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
  app.get("/api/v1/causal/effects", async (c) => {
    try {
      if (!deps.causalGraphManager) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "Causal graph not configured" }, 503);
      const entityId = c.req.query("entityId"); if (!entityId) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "entityId is required" }, 400);
      const effects = await deps.causalGraphManager.getEffectsOf(entityId, { limit: parseInt(c.req.query("limit") ?? "10", 10) });
      return c.json({ data: { query: c.req.query("query") ?? "", effects } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
  app.get("/api/v1/causal/chain", async (c) => {
    try {
      if (!deps.causalGraphManager) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "Causal graph not configured" }, 503);
      const s = c.req.query("startEntityId"), e = c.req.query("endEntityId");
      if (!s || !e) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "startEntityId and endEntityId are required" }, 400);
      return c.json({ data: { startEntityId: s, endEntityId: e, chain: await deps.causalGraphManager.getCausalChain(s, e) } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
  app.post("/api/v1/causal/discover", async (c) => {
    try {
      if (!deps.causalDiscoveryAgent) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "Causal discovery not configured" }, 503);
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON" }, 400); }
      if (typeof body.text !== "string" || (body.text as string).length === 0) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "text is required" }, 400);
      if ((body.text as string).length > 50_000) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Text too long" }, 400);
      if (body.persist === true) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Persistence not yet supported" }, 400);
      const links = await deps.causalDiscoveryAgent.discover(body.text as string);
      return c.json({ data: { discovered: links.length, links, persisted: false } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
}
