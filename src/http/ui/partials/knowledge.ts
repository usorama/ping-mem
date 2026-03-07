/**
 * HTMX partial responses for Knowledge view
 *
 * Returns HTML fragments for knowledge search results and detail panels.
 * Uses KnowledgeStore FTS5 search.
 */

import type { Context } from "hono";
import { escapeHtml, formatDate } from "../layout.js";
import { badge, emptyState } from "../components.js";
import type { KnowledgeStore, KnowledgeEntry } from "../../../knowledge/KnowledgeStore.js";
import type { UIDependencies } from "../routes.js";
import { createLogger } from "../../../util/logger.js";

const log = createLogger("UI:Knowledge");

// ============================================================================
// Types
// ============================================================================

interface KnowledgeFilters {
  query: string;
}

// ============================================================================
// Query Helpers
// ============================================================================

function queryKnowledge(knowledgeStore: KnowledgeStore, filters: KnowledgeFilters): KnowledgeEntry[] {
  if (!filters.query) {
    // No query: list recent entries directly from the database
    // KnowledgeStore doesn't expose a listAll, so we use an empty FTS search workaround:
    // just return stats-based empty or query with wildcard approach
    const stats = knowledgeStore.stats();
    if (stats.totalEntries === 0) return [];

    // Search for a very broad term -- FTS5 needs a query, so we list via the DB
    // We'll need to access the db indirectly. Since KnowledgeStore only exposes search/get/stats,
    // we'll show a prompt to search instead.
    return [];
  }

  try {
    const results = knowledgeStore.search({
      query: filters.query,
      crossProject: true,
      limit: 50,
    });
    return results.map((r) => r.entry);
  } catch (err) {
    log.warn("Knowledge search failed", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// ============================================================================
// HTML Renderers
// ============================================================================

export function renderKnowledgeTable(knowledgeStore: KnowledgeStore, filters: KnowledgeFilters): string {
  if (!filters.query) {
    const stats = knowledgeStore.stats();
    if (stats.totalEntries === 0) {
      return emptyState("No knowledge entries found. Ingest entries via the knowledge API.", "\u25C8");
    }
    return `<div class="empty-state">
      <p>${stats.totalEntries} knowledge entries across ${Object.keys(stats.byProject).length} projects. Type a query to search.</p>
    </div>`;
  }

  const entries = queryKnowledge(knowledgeStore, filters);

  if (entries.length === 0) {
    return emptyState("No matching knowledge entries", "\u25C8");
  }

  const rows = entries.map((entry) => {
    const titleShort = entry.title.length > 60 ? entry.title.slice(0, 60) + "..." : entry.title;
    const projectShort = entry.projectId.length > 12 ? entry.projectId.slice(0, 12) + "..." : entry.projectId;
    const tags = entry.tags.slice(0, 3).map((t) => badge(t, "info")).join(" ");

    return `<tr class="clickable"
      hx-get="/ui/partials/knowledge/${encodeURIComponent(entry.id)}"
      hx-target="#detail-panel"
      hx-swap="innerHTML"
    >
      <td title="${escapeHtml(entry.title)}">${escapeHtml(titleShort)}</td>
      <td class="mono" title="${escapeHtml(entry.projectId)}">${escapeHtml(projectShort)}</td>
      <td>${tags}</td>
      <td title="${escapeHtml(entry.updatedAt)}">${formatDate(entry.updatedAt)}</td>
    </tr>`;
  }).join("\n");

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Title</th>
          <th>Project</th>
          <th>Tags</th>
          <th>Updated</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderKnowledgeDetail(entry: KnowledgeEntry): string {
  const tags = entry.tags.map((t) => badge(t, "info")).join(" ");

  return `<div class="detail-panel">
    <div class="flex justify-between items-center" style="margin-bottom:16px">
      <h3>Knowledge Detail</h3>
      <button class="btn btn-ghost btn-sm" id="detail-close-btn">Close</button>
    </div>
    <div class="detail-row">
      <span class="detail-label">Title</span>
      <span class="detail-value">${escapeHtml(entry.title)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Solution</span>
      <span class="detail-value"><pre>${escapeHtml(entry.solution)}</pre></span>
    </div>
    ${entry.symptoms ? `<div class="detail-row">
      <span class="detail-label">Symptoms</span>
      <span class="detail-value"><pre>${escapeHtml(entry.symptoms)}</pre></span>
    </div>` : ""}
    ${entry.rootCause ? `<div class="detail-row">
      <span class="detail-label">Root Cause</span>
      <span class="detail-value"><pre>${escapeHtml(entry.rootCause)}</pre></span>
    </div>` : ""}
    <div class="detail-row">
      <span class="detail-label">Project ID</span>
      <span class="detail-value mono">${escapeHtml(entry.projectId)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Tags</span>
      <span class="detail-value">${tags || "<span class='muted'>none</span>"}</span>
    </div>
    ${entry.agentId ? `<div class="detail-row">
      <span class="detail-label">Agent</span>
      <span class="detail-value mono">${escapeHtml(entry.agentId)}</span>
    </div>` : ""}
    <div class="detail-row">
      <span class="detail-label">Created</span>
      <span class="detail-value">${formatDate(entry.createdAt)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Updated</span>
      <span class="detail-value">${formatDate(entry.updatedAt)}</span>
    </div>
  </div>`;
}

// ============================================================================
// Route Handlers
// ============================================================================

export function registerKnowledgePartialRoutes(deps: UIDependencies) {
  return {
    /** GET /ui/partials/knowledge -- search results (table fragment) */
    search: async (c: Context) => {
      try {
        const { knowledgeStore } = deps;
        if (!knowledgeStore) {
          return c.html(emptyState("KnowledgeStore not configured"));
        }
        const query = c.req.query("query") ?? "";
        const html = renderKnowledgeTable(knowledgeStore, { query });
        return c.html(html);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Search error", { error: errMsg });
        return c.html(`<div class="empty-state"><p style="color:var(--error)">Search failed</p></div>`);
      }
    },

    /** GET /ui/partials/knowledge/:id -- detail panel */
    detail: async (c: Context) => {
      try {
        const { knowledgeStore } = deps;
        if (!knowledgeStore) {
          return c.html(`<div class="detail-panel"><p class="muted">KnowledgeStore not configured</p></div>`);
        }
        const id = decodeURIComponent(c.req.param("id"));
        const entry = knowledgeStore.get(id);

        if (!entry) {
          return c.html(`<div class="detail-panel"><p class="muted">Knowledge entry not found</p></div>`);
        }

        return c.html(renderKnowledgeDetail(entry));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Detail error", { error: errMsg });
        return c.html(`<div class="detail-panel"><p style="color:var(--error)">Failed to load detail</p></div>`);
      }
    },
  };
}
