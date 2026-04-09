import type { Hono } from "hono";
import type { AppEnv } from "../rest-server.js";
import type { RESTErrorResponse, RESTSuccessResponse } from "../types.js";
import type { IngestionService } from "../../ingest/IngestionService.js";
import type { EventStore } from "../../storage/EventStore.js";
import type { DiagnosticsStore } from "../../diagnostics/index.js";
import type { AdminStore } from "../../admin/AdminStore.js";
import { ProjectScanner } from "../../ingest/ProjectScanner.js";
import { isProjectDirSafe } from "../../util/path-safety.js";
import { createLogger } from "../../util/logger.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const log = createLogger("CodebaseExtraRoutes");
export interface CodebaseExtraRoutesDeps { ingestionService: IngestionService | null; eventStore: EventStore; diagnosticsStore: DiagnosticsStore; adminStore: AdminStore | null; }

export function registerCodebaseExtraRoutes(app: Hono<AppEnv>, deps: CodebaseExtraRoutesDeps): void {
  app.get("/api/v1/codebase/projects", async (c) => {
    try {
      if (!deps.ingestionService) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "Ingestion service not configured" }, 503);
      const projectId = c.req.query("projectId"); const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10), 1), 1000);
      const sortBy = (c.req.query("sortBy") as "lastIngestedAt" | "filesCount" | "rootPath") ?? "lastIngestedAt";
      const opts: { limit: number; sortBy: "lastIngestedAt" | "filesCount" | "rootPath"; projectId?: string } = { limit, sortBy }; if (projectId) opts.projectId = projectId;
      const projects = await deps.ingestionService.listProjects(opts);
      return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { count: projects.length, sortBy, projects: projects.map((p) => ({ projectId: p.projectId, rootPath: p.rootPath, treeHash: p.treeHash, filesCount: p.filesCount, chunksCount: p.chunksCount, commitsCount: p.commitsCount, lastIngestedAt: p.lastIngestedAt })) } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });

  app.delete("/api/v1/codebase/projects/:id", async (c) => {
    try {
      if (!deps.ingestionService) return c.json<RESTErrorResponse>({ error: "Service Unavailable", message: "Ingestion service not configured" }, 503);
      const projectDir = decodeURIComponent(c.req.param("id")); const normalized = path.resolve(projectDir);
      if (!isProjectDirSafe(normalized)) return c.json<RESTErrorResponse>({ error: "Forbidden", message: "Outside allowed roots" }, 403);
      let projectId: string | null = null;
      if (fs.existsSync(normalized)) { try { projectId = (await new ProjectScanner().scanProject(normalized)).manifest.projectId; } catch (e) { log.error("scan failed", { error: e instanceof Error ? e.message : String(e) }); } }
      if (!projectId) return c.json<RESTErrorResponse>({ error: "Not Found", message: `Project not found at ${normalized}` }, 404);
      await deps.ingestionService.deleteProject(projectId); deps.diagnosticsStore.deleteProject(projectId);
      let sessionsDeleted = 0;
      const warnings: string[] = [];
      try { const ids = deps.eventStore.findSessionIdsByProjectDir(normalized); if (ids.length > 0) { deps.eventStore.deleteSessions(ids); sessionsDeleted = ids.length; } } catch (e) { warnings.push(`Session cleanup failed: ${e instanceof Error ? e.message : String(e)}`); log.warn("Project delete: session cleanup failed", { projectId, error: e instanceof Error ? e.message : String(e) }); }
      const mp = path.join(normalized, ".ping-mem", "manifest.json"); try { fs.rmSync(mp, { force: true }); } catch (e) { warnings.push(`Manifest delete failed: ${e instanceof Error ? e.message : String(e)}`); log.warn("Project delete: manifest cleanup failed", { projectId, error: e instanceof Error ? e.message : String(e) }); }
      try { const { AdminStore: AC } = await import("../../admin/AdminStore.js"); const a = new AC({ dbPath: process.env.PING_MEM_ADMIN_DB_PATH ?? path.join(os.homedir(), ".ping-mem", "admin.db") }); a.deleteProject(projectId); a.close(); } catch (e) { warnings.push(`Admin cleanup failed: ${e instanceof Error ? e.message : String(e)}`); log.warn("Project delete: admin cleanup failed", { projectId, error: e instanceof Error ? e.message : String(e) }); }
      return c.json<RESTSuccessResponse<Record<string, unknown>>>({ data: { success: true, projectId, projectDir: normalized, sessionsDeleted, ...(warnings.length > 0 && { warnings }) } });
    } catch (error) { return c.json<RESTErrorResponse>({ error: "Internal Server Error", message: error instanceof Error ? error.message : "Unknown" }, 500); }
  });
}
