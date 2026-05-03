/**
 * Ingestion Monitor view for ping-mem UI
 *
 * Shows registered projects, ingestion status, and provides reingest actions.
 * When IngestionService is not available (no Neo4j/Qdrant), shows info state.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator } from "./components.js";
import type { UIDependencies } from "./routes.js";
import * as path from "path";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Ingestion");

export function registerIngestionRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
    const { ingestionService } = deps;
    const available = !!ingestionService;

    let projects: Array<{ projectId?: string; rootPath: string }> = [];
    let registryError: string | null = null;
    if (ingestionService) {
      try {
        projects = await ingestionService.listProjects({
          scope: "registered",
          limit: 1000,
          sortBy: "rootPath",
        });
      } catch (err) {
        registryError = err instanceof Error ? err.message : String(err);
        log.error("Failed to load registered projects from runtime registry", { error: registryError });
      }
    }

    const statusBadge = available
      ? `<span class="badge badge-success">Connected</span>`
      : `<span class="badge badge-error">Unavailable</span>`;

    // Build project list
    let projectsHtml: string;
    if (registryError) {
      projectsHtml = `<div class="empty-state"><p>Registered project registry unavailable: ${escapeHtml(registryError)}</p></div>`;
    } else if (projects.length === 0) {
      projectsHtml = `<div class="empty-state"><p>No registered projects reported by the runtime registry.</p></div>`;
    } else {
      const rows = projects.map((project) => {
        const projectPath = project.rootPath;
        const projectName = path.basename(projectPath);
        return `<tr>
          <td class="mono">${escapeHtml(projectName)}</td>
          <td class="mono" style="font-size:12px" title="${escapeHtml(projectPath)}">${escapeHtml(projectPath)}</td>
          <td>
            ${available
              ? `<button class="btn btn-ghost btn-sm"
                  hx-post="/ui/partials/ingestion/reingest"
                  hx-vals="${escapeHtml(JSON.stringify({ projectDir: projectPath }))}"
                  hx-target="#ingestion-status"
                  hx-swap="innerHTML"
                  hx-indicator="#reingest-indicator"
                >Reingest</button>`
              : `<span class="muted">N/A</span>`
            }
          </td>
        </tr>`;
      }).join("\n");

      projectsHtml = `<div class="table-wrap">
        <table>
          <thead><tr>
            <th>Project</th>
            <th>Path</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    const content = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">INGESTION SERVICE</div>
          <div class="stat-value">${statusBadge}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">REGISTERED PROJECTS</div>
          <div class="stat-value">${registryError ? "Blocked" : projects.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">NEO4J</div>
          <div class="stat-value">${available ? `<span class="badge badge-success">Up</span>` : `<span class="badge badge-muted">N/A</span>`}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">QDRANT</div>
          <div class="stat-value">${available ? `<span class="badge badge-success">Up</span>` : `<span class="badge badge-muted">N/A</span>`}</div>
        </div>
      </div>

      <div class="card mb-4">
        <div class="card-header">
          <div class="card-title">Registered Projects</div>
          ${loadingIndicator()}
        </div>
        ${projectsHtml}
      </div>

      <div id="ingestion-status">
        <div id="reingest-indicator" class="htmx-indicator" style="text-align:center;padding:16px;color:var(--text-secondary)">
          Ingesting... this may take a while for large projects.
        </div>
      </div>

      ${!available ? `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Setup Required</div>
        </div>
        <div style="padding:16px;color:var(--text-secondary);font-size:14px">
          <p>Ingestion requires Neo4j and Qdrant. Start them with:</p>
          <pre style="margin:12px 0;padding:12px;background:var(--bg-secondary);border-radius:6px;overflow-x:auto">docker-compose up -d neo4j qdrant</pre>
          <p>Then set environment variables: NEO4J_URI, NEO4J_PASSWORD, QDRANT_URL</p>
        </div>
      </div>` : ""}
    `;

    const nonce = getCspNonce(c);
    const csrfToken = getCsrfToken(c);
    return c.html(renderLayout({
      title: "Ingestion Monitor",
      content,
      activeRoute: "ingestion",
      nonce,
      csrfToken,
    }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Ingestion Monitor",
        content: `<div class="card" style="padding:24px;color:var(--error)">Ingestion error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "ingestion",
        nonce,
        csrfToken,
      }));
    }
  };
}
