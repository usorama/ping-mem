/**
 * HTMX partial responses for Ingestion Monitor
 *
 * Handles reingest action and returns status fragments.
 */

import type { Context } from "hono";
import { escapeHtml } from "../layout.js";
import { badge } from "../components.js";
import type { UIDependencies } from "../routes.js";

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
