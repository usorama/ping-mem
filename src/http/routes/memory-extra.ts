import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import type { RESTErrorResponse, RESTSuccessResponse } from "../types.js";
import type { MemoryPubSub } from "../../pubsub/index.js";
import type { MemoryManager } from "../../memory/MemoryManager.js";
import type { SessionId, MemoryCategory } from "../../types/index.js";
import { SemanticCompressor } from "../../memory/SemanticCompressor.js";

export interface MemoryExtraRoutesDeps { pubsub: MemoryPubSub; getMemoryManager: (sessionId: SessionId) => Promise<MemoryManager>; getSessionId: (headerValue: string | undefined, fallback: SessionId | null) => SessionId | null; }

export function registerMemoryExtraRoutes(app: Hono<AppEnv>, deps: MemoryExtraRoutesDeps): void {
  app.post("/api/v1/memory/subscribe", async (c) => {
    try {
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON" }, 400); }
      const ch = typeof body.channel === "string" ? body.channel : undefined; const cat = typeof body.category === "string" ? body.category : undefined; const aid = typeof body.agentId === "string" ? body.agentId : undefined;
      const subId = deps.pubsub.subscribe({ ...(ch ? { channel: ch } : {}), ...(cat ? { category: cat } : {}), ...(aid ? { agentId: aid } : {}) }, () => {});
      return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { subscriptionId: subId, message: "Use GET /api/v1/events/stream for real-time events." } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
  app.post("/api/v1/memory/unsubscribe", async (c) => {
    try {
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON" }, 400); }
      if (typeof body.subscriptionId !== "string") return c.json<RESTErrorResponse>({ error: "Bad Request", message: "subscriptionId is required" }, 400);
      return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { success: deps.pubsub.unsubscribe(body.subscriptionId as string), subscriberCount: deps.pubsub.subscriberCount } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
  app.post("/api/v1/memory/compress", async (c) => {
    try {
      const sid = deps.getSessionId(c.req.header("x-session-id"), null); if (!sid) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "No active session" }, 400);
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON" }, 400); }
      const mm = await deps.getMemoryManager(sid);
      const lo: { limit?: number; category?: MemoryCategory; channel?: string } = {}; if (typeof body.category === "string") lo.category = body.category as MemoryCategory; if (typeof body.channel === "string") lo.channel = body.channel; lo.limit = typeof body.maxCount === "number" ? body.maxCount : 100;
      const mems = mm.list(lo); if (mems.length === 0) return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { facts: [], sourceCount: 0, compressionRatio: 1, strategy: "heuristic", digestSaved: false } });
      const res = await new SemanticCompressor().compress(mems); let saved = false;
      if (res.facts.length > 0) { await mm.saveOrUpdate(`digest::${body.channel ?? "all"}::${body.category ?? "all"}::${new Date().toISOString()}`, res.facts.join("\n"), { category: "digest" as MemoryCategory, priority: "normal", metadata: { sourceCount: res.sourceCount, compressionRatio: res.compressionRatio, strategy: res.strategy, costEstimate: res.costEstimate } }); saved = true; }
      return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { facts: res.facts, sourceCount: res.sourceCount, compressionRatio: res.compressionRatio, strategy: res.strategy, costEstimate: res.costEstimate, digestSaved: saved } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
}
