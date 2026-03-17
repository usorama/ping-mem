import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import type { RESTErrorResponse, RESTSuccessResponse } from "../types.js";
import type { EventStore } from "../../storage/EventStore.js";
import type { EventType, WorklogEventData, SessionId } from "../../types/index.js";

export interface WorklogRoutesDeps { eventStore: EventStore; getCurrentSessionId: () => SessionId | null; }

export function registerWorklogRoutes(app: Hono<AppEnv>, deps: WorklogRoutesDeps): void {
  app.post("/api/v1/worklog", async (c) => {
    try {
      let body: Record<string, unknown>; try { body = await c.req.json(); } catch { return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid JSON" }, 400); }
      const sessionId: string | null = (body.sessionId as string | undefined) ?? c.req.header("x-session-id") ?? deps.getCurrentSessionId();
      if (!sessionId) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "No active session" }, 400);
      const kind = body.kind as WorklogEventData["kind"];
      if (!kind || !["tool", "diagnostics", "git", "task"].includes(kind)) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "kind must be: tool, diagnostics, git, task" }, 400);
      if (typeof body.title !== "string" || (body.title as string).length === 0) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "title is required" }, 400);
      const phase = body.phase as string | undefined;
      let eventType: EventType;
      switch (kind) { case "tool": eventType = "TOOL_RUN_RECORDED"; break; case "diagnostics": eventType = "DIAGNOSTICS_INGESTED"; break; case "git": eventType = "GIT_OPERATION_RECORDED"; break;
        case "task": if (phase === "started") eventType = "AGENT_TASK_STARTED"; else if (phase === "summary") eventType = "AGENT_TASK_SUMMARY"; else if (phase === "completed") eventType = "AGENT_TASK_COMPLETED"; else return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Task requires phase" }, 400); break;
        default: return c.json<RESTErrorResponse>({ error: "Bad Request", message: "Invalid kind" }, 400); }
      const payload: WorklogEventData = { sessionId, kind, title: body.title as string };
      if (body.status !== undefined) payload.status = body.status as WorklogEventData["status"];
      if (body.toolName !== undefined) payload.toolName = body.toolName as string;
      if (body.toolVersion !== undefined) payload.toolVersion = body.toolVersion as string;
      if (body.configHash !== undefined) payload.configHash = body.configHash as string;
      if (body.environmentHash !== undefined) payload.environmentHash = body.environmentHash as string;
      if (body.projectId !== undefined) payload.projectId = body.projectId as string;
      if (body.treeHash !== undefined) payload.treeHash = body.treeHash as string;
      if (body.commitHash !== undefined) payload.commitHash = body.commitHash as string;
      if (body.runId !== undefined) payload.runId = body.runId as string;
      if (body.command !== undefined) payload.command = body.command as string;
      if (body.summary !== undefined) payload.summary = body.summary as string;
      if (body.durationMs !== undefined) payload.durationMs = body.durationMs as number;
      if (body.metadata !== undefined) payload.metadata = body.metadata as Record<string, unknown>;
      const metadata = { kind, projectId: payload.projectId, treeHash: payload.treeHash, commitHash: payload.commitHash, toolName: payload.toolName, toolVersion: payload.toolVersion, runId: payload.runId };
      const event = await deps.eventStore.createEvent(sessionId, eventType, payload, metadata);
      return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { success: true, eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp.toISOString() } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
  app.get("/api/v1/worklog", async (c) => {
    try {
      const sessionId: string | null = c.req.query("sessionId") ?? c.req.header("x-session-id") ?? deps.getCurrentSessionId();
      if (!sessionId) return c.json<RESTErrorResponse>({ error: "Bad Request", message: "No active session" }, 400);
      const limit = parseInt(c.req.query("limit") ?? "100", 10);
      const etRaw = c.req.query("eventTypes");
      const allowed = new Set(etRaw ? etRaw.split(",") : ["TOOL_RUN_RECORDED", "DIAGNOSTICS_INGESTED", "GIT_OPERATION_RECORDED", "AGENT_TASK_STARTED", "AGENT_TASK_SUMMARY", "AGENT_TASK_COMPLETED"]);
      const events = await deps.eventStore.getBySession(sessionId);
      const sel = events.filter((e) => allowed.has(e.eventType)).slice(-limit);
      return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { sessionId, count: sel.length, events: sel.map((e) => ({ eventId: e.eventId, eventType: e.eventType, timestamp: e.timestamp.toISOString(), payload: e.payload, metadata: e.metadata, causedBy: e.causedBy })) } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
}
