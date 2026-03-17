/**
 * Tests for shell event REST routes.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { registerShellRoutes } from "../shell.js";
import { EventStore } from "../../../storage/EventStore.js";
import { SessionManager } from "../../../session/SessionManager.js";
import type { AppEnv } from "../../rest-server.js";

describe("shell routes", () => {
  let app: Hono<AppEnv>;
  let eventStore: EventStore;
  let sessionId: string;

  beforeEach(async () => {
    eventStore = new EventStore({ dbPath: ":memory:" });
    const sessionManager = new SessionManager({ eventStore });
    const session = await sessionManager.startSession({ name: "test-shell" });
    sessionId = session.id;

    app = new Hono<AppEnv>();
    registerShellRoutes(app, {
      eventStore,
      getCurrentSessionId: () => sessionId,
    });
  });

  test("POST /api/v1/shell/event — accepts precmd event", async () => {
    const res = await app.request("/api/v1/shell/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "precmd",
        directory: "/Users/test/project",
        timestamp: "2026-03-17T10:00:00.000Z",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { success: boolean; type: string; directory: string } };
    expect(body.data.success).toBe(true);
    expect(body.data.type).toBe("precmd");
    expect(body.data.directory).toBe("/Users/test/project");
  });

  test("POST /api/v1/shell/event — accepts chdir event with git info", async () => {
    const res = await app.request("/api/v1/shell/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "chdir",
        directory: "/Users/test/project",
        gitRoot: "/Users/test/project",
        gitBranch: "main",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { success: boolean; gitRoot: string; gitBranch: string } };
    expect(body.data.success).toBe(true);
    expect(body.data.gitRoot).toBe("/Users/test/project");
    expect(body.data.gitBranch).toBe("main");
  });

  test("POST /api/v1/shell/event — rejects invalid type", async () => {
    const res = await app.request("/api/v1/shell/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "invalid",
        directory: "/tmp",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /api/v1/shell/event — rejects missing directory", async () => {
    const res = await app.request("/api/v1/shell/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "precmd",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("POST /api/v1/shell/event — rejects invalid JSON", async () => {
    const res = await app.request("/api/v1/shell/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });

  test("POST /api/v1/shell/event — returns 400 when no session", async () => {
    const noSessionApp = new Hono<AppEnv>();
    registerShellRoutes(noSessionApp, {
      eventStore,
      getCurrentSessionId: () => null,
    });

    const res = await noSessionApp.request("/api/v1/shell/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "precmd",
        directory: "/tmp",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain("No active session");
  });

  test("GET /api/v1/shell/latest — returns latest shell directory", async () => {
    // First post an event
    await app.request("/api/v1/shell/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "chdir",
        directory: "/Users/test/project-a",
      }),
    });

    // Then query latest
    const res = await app.request("/api/v1/shell/latest");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { directory: string } };
    expect(body.data.directory).toBe("/Users/test/project-a");
  });

  test("GET /api/v1/shell/latest — returns null when no events", async () => {
    const res = await app.request("/api/v1/shell/latest");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { directory: string | null } };
    expect(body.data.directory).toBeNull();
  });
});
