/**
 * HTMX partial responses for Ingestion Monitor
 *
 * Handles reingest action and returns status fragments.
 */

import type { Context } from "hono";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { escapeHtml } from "../layout.js";
import { badge } from "../components.js";
import type { UIDependencies } from "../routes.js";

// ============================================================================
// Rate Limiting
// ============================================================================

const reingestRateLimits = new Map<string, { count: number; resetAt: number }>();
const REINGEST_RATE_LIMIT = 5; // requests per minute
const REINGEST_RATE_WINDOW = 60_000;

function checkReingestRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = reingestRateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    reingestRateLimits.set(ip, { count: 1, resetAt: now + REINGEST_RATE_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= REINGEST_RATE_LIMIT;
}

// ============================================================================
// Route Handlers
// ============================================================================

export function registerIngestionPartialRoutes(deps: UIDependencies) {
  return {
    /** POST /ui/partials/ingestion/reingest — trigger reingest for a project */
    reingest: async (c: Context) => {
      const { ingestionService } = deps;

      if (!ingestionService) {
        return c.html(`<div class="card" style="margin-top:16px">
          <div style="padding:16px;color:var(--error)">
            Ingestion service not available. Start Neo4j and Qdrant first.
          </div>
        </div>`);
      }

      let projectDir: string;
      try {
        const body = await c.req.parseBody();
        projectDir = String(body["projectDir"] ?? "");
      } catch (err) {
        console.warn("[Ingestion] Failed to parse reingest request body:", err instanceof Error ? err.message : err);
        return c.html(`<div class="card" style="margin-top:16px">
          <div style="padding:16px;color:var(--error)">Invalid request body</div>
        </div>`);
      }

      if (!projectDir) {
        return c.html(`<div class="card" style="margin-top:16px">
          <div style="padding:16px;color:var(--error)">Missing projectDir</div>
        </div>`);
      }

      // Validate projectDir against registered projects
      const registeredPath = path.join(os.homedir(), ".ping-mem", "registered-projects.txt");
      let allowedProjects: string[] = [];
      try {
        if (fs.existsSync(registeredPath)) {
          allowedProjects = fs.readFileSync(registeredPath, "utf-8")
            .split("\n")
            .map(l => l.trim())
            .filter(Boolean)
            .map(l => path.resolve(l));
        }
      } catch { /* ignore read errors */ }

      const resolvedDir = path.resolve(projectDir);
      if (allowedProjects.length > 0 && !allowedProjects.includes(resolvedDir)) {
        return c.html(`<div class="card" style="margin-top:16px">
          <div style="padding:16px;color:var(--error)">
            ${badge("Forbidden", "error")} Project not in registered projects list
          </div>
        </div>`);
      }

      // Rate limit reingest requests (5 per minute per IP)
      const reingestIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
      if (!checkReingestRateLimit(reingestIp)) {
        return c.html(`<div class="card" style="margin-top:16px">
          <div style="padding:16px;color:var(--error)">
            ${badge("Rate Limited", "error")} Too many reingest requests. Try again later.
          </div>
        </div>`);
      }

      try {
        const result = await ingestionService.ingestProject({
          projectDir,
          forceReingest: true,
        });

        if (!result) {
          return c.html(`<div class="card" style="margin-top:16px">
            <div style="padding:16px">
              ${badge("No Changes", "muted")} Project is up to date.
            </div>
          </div>`);
        }

        return c.html(`<div class="card" style="margin-top:16px">
          <div class="card-header">
            <div class="card-title">Ingestion Complete</div>
            ${badge("Success", "success")}
          </div>
          <div style="padding:16px">
            <div class="detail-row">
              <span class="detail-label">Project ID</span>
              <span class="detail-value mono">${escapeHtml(result.projectId)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Tree Hash</span>
              <span class="detail-value mono">${escapeHtml(result.treeHash)}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Files</span>
              <span class="detail-value">${result.filesIndexed}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Chunks</span>
              <span class="detail-value">${result.chunksIndexed}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Commits</span>
              <span class="detail-value">${result.commitsIndexed}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Ingested At</span>
              <span class="detail-value">${escapeHtml(result.ingestedAt)}</span>
            </div>
          </div>
        </div>`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Ingestion] Reingest failed for", projectDir, ":", message);
        return c.html(`<div class="card" style="margin-top:16px">
          <div style="padding:16px;color:var(--error)">
            ${badge("Error", "error")} Ingestion failed: ${escapeHtml(message)}
          </div>
        </div>`);
      }
    },
  };
}
