/**
 * Shell event ingestion route.
 *
 * POST /api/v1/shell/event — accepts events from the shell daemon
 * and stores them as context memories.
 */

import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import type { RESTErrorResponse, RESTSuccessResponse } from "../types.js";
import type { EventStore } from "../../storage/EventStore.js";
import type { SessionId } from "../../types/index.js";

export interface ShellRoutesDeps {
  eventStore: EventStore;
  getCurrentSessionId: () => SessionId | null;
}

interface ShellEventBody {
  type: "precmd" | "chdir";
  directory: string;
  timestamp?: string;
  gitRoot?: string | null;
  gitBranch?: string | null;
}

export function registerShellRoutes(app: Hono<AppEnv>, deps: ShellRoutesDeps): void {
  app.post("/api/v1/shell/event", async (c) => {
    try {
      let body: ShellEventBody;
      try {
        body = await c.req.json<ShellEventBody>();
      } catch {
        return c.json<RESTErrorResponse>(
          { error: "Bad Request", message: "Invalid JSON" },
          400,
        );
      }

      // Validate required fields
      if (!body.type || !["precmd", "chdir"].includes(body.type)) {
        return c.json<RESTErrorResponse>(
          { error: "Bad Request", message: "type must be 'precmd' or 'chdir'" },
          400,
        );
      }
      if (!body.directory || typeof body.directory !== "string") {
        return c.json<RESTErrorResponse>(
          { error: "Bad Request", message: "directory is required" },
          400,
        );
      }

      const sessionId: string | null =
        c.req.header("x-session-id") ?? deps.getCurrentSessionId();

      if (!sessionId) {
        return c.json<RESTErrorResponse>(
          { error: "Bad Request", message: "No active session. Start a session first." },
          400,
        );
      }

      const timestamp = body.timestamp ?? new Date().toISOString();

      // Store as a CONTEXT_SAVED event with shell-specific metadata
      const payload = {
        key: "shell:latest-dir",
        value: body.directory,
        category: "note" as const,
        tags: ["shell", "auto-context"],
      };

      const metadata: Record<string, unknown> = {
        shellEventType: body.type,
        directory: body.directory,
        timestamp,
      };

      if (body.gitRoot) {
        metadata.gitRoot = body.gitRoot;
      }
      if (body.gitBranch) {
        metadata.gitBranch = body.gitBranch;
      }

      const event = await deps.eventStore.createEvent(
        sessionId,
        "MEMORY_SAVED",
        payload,
        metadata,
      );

      return c.json<RESTSuccessResponse<Record<string, unknown>>>({
        data: {
          success: true,
          eventId: event.eventId,
          type: body.type,
          directory: body.directory,
          timestamp,
          gitRoot: body.gitRoot ?? null,
          gitBranch: body.gitBranch ?? null,
        },
      });
    } catch (error) {
      return c.json<RESTErrorResponse>(
        {
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : "Unknown",
        },
        500,
      );
    }
  });

  // GET /api/v1/shell/latest — retrieve the latest shell directory
  app.get("/api/v1/shell/latest", async (c) => {
    try {
      const sessionId: string | null =
        c.req.query("sessionId") ?? c.req.header("x-session-id") ?? deps.getCurrentSessionId();

      if (!sessionId) {
        return c.json<RESTErrorResponse>(
          { error: "Bad Request", message: "No active session" },
          400,
        );
      }

      const events = await deps.eventStore.getBySession(sessionId);
      const shellEvents = events
        .filter(
          (e) =>
            e.eventType === "MEMORY_SAVED" &&
            (e.payload as Record<string, unknown>)?.key === "shell:latest-dir",
        )
        .slice(-1);

      if (shellEvents.length === 0) {
        return c.json<RESTSuccessResponse<Record<string, unknown>>>({
          data: { directory: null, message: "No shell events recorded" },
        });
      }

      const latest = shellEvents[0];
      const latestPayload = latest?.payload as Record<string, unknown> | undefined;
      const latestMeta = latest?.metadata as Record<string, unknown> | undefined;

      return c.json<RESTSuccessResponse<Record<string, unknown>>>({
        data: {
          directory: latestPayload?.value ?? null,
          type: latestMeta?.shellEventType ?? null,
          gitRoot: latestMeta?.gitRoot ?? null,
          gitBranch: latestMeta?.gitBranch ?? null,
          timestamp: latestMeta?.timestamp ?? latest?.timestamp?.toISOString() ?? null,
        },
      });
    } catch (error) {
      return c.json<RESTErrorResponse>(
        {
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : "Unknown",
        },
        500,
      );
    }
  });
}
