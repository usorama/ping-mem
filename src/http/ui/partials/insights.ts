/**
 * HTMX partial responses for Insights view
 *
 * Server-renders derived insights from MemoryManager (category=derived_insight).
 * Returns an HTML table fragment for HTMX swap.
 */

import type { Context } from "hono";
import { escapeHtml, formatDate } from "../layout.js";
import { badge, emptyState } from "../components.js";
import type { UIDependencies } from "../routes.js";
import { createLogger } from "../../../util/logger.js";

const log = createLogger("UI:Insights:Partial");

// ============================================================================
// Types
// ============================================================================

interface InsightRow {
  key: string;
  value: string;
  category: string;
  priority: string;
  createdAt: string | null;
}

// ============================================================================
// Render helpers
// ============================================================================

/**
 * Fetch derived insights from MemoryManager and render an HTML table.
 * Called by both the full page (initial load) and the HTMX partial (refresh).
 */
export async function renderInsightsTable(deps: UIDependencies): Promise<string> {
  try {
    const { sessionManager } = deps;

    // We need an active session to query memories. Use the most recent session.
    const sessions = sessionManager.listSessions({ status: "active" });
    const session = sessions[0] ?? sessionManager.listSessions()[0];

    if (!session) {
      return emptyState("No active session. Start a session to view insights.", "\u25CE");
    }

    // Query the event store for MEMORY_SAVED events with derived_insight category
    const db = (deps.eventStore as { getDatabase?: () => import("bun:sqlite").Database }).getDatabase?.();
    if (!db) {
      return emptyState("EventStore database unavailable.");
    }

    let rows: InsightRow[];
    try {
      const raw = db.prepare(`
        SELECT
          json_extract(payload, '$.key') as key,
          json_extract(payload, '$.value') as value,
          json_extract(payload, '$.metadata.category') as category,
          json_extract(payload, '$.metadata.priority') as priority,
          json_extract(payload, '$.createdAt') as created_at
        FROM events
        WHERE event_type = 'MEMORY_SAVED'
          AND json_extract(payload, '$.metadata.category') = 'derived_insight'
        ORDER BY created_at DESC
        LIMIT 200
      `).all() as Array<{ key: string; value: string; category: string; priority: string; created_at: string }>;

      rows = raw.map((r) => ({
        key: r.key ?? "",
        value: r.value ?? "",
        category: r.category ?? "derived_insight",
        priority: r.priority ?? "normal",
        createdAt: r.created_at ?? null,
      }));
    } catch {
      return emptyState("No insights found. Run dreaming to generate insights.");
    }

    if (rows.length === 0) {
      return emptyState("No insights found. Run dreaming to generate insights.", "\u25CE");
    }

    const headerCells = ["Key", "Value", "Category", "Priority", "Created"]
      .map((h) => `<th>${escapeHtml(h)}</th>`)
      .join("");

    const bodyRows = rows.map((row) => {
      const truncatedValue = row.value.length > 120 ? `${row.value.slice(0, 120)}...` : row.value;
      const priorityVariant = row.priority === "high" ? "error" : row.priority === "low" ? "muted" : "info";
      const created = row.createdAt ? formatDate(row.createdAt) : "-";

      return `<tr>
        <td class="mono truncate" style="max-width:200px" title="${escapeHtml(row.key)}">${escapeHtml(row.key)}</td>
        <td class="truncate" style="max-width:320px" title="${escapeHtml(row.value)}">${escapeHtml(truncatedValue)}</td>
        <td>${badge(row.category, "muted")}</td>
        <td>${badge(row.priority, priorityVariant)}</td>
        <td style="white-space:nowrap">${escapeHtml(created)}</td>
      </tr>`;
    }).join("\n");

    return `<div class="table-wrap">
      <table>
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <div style="margin-top:12px;color:var(--text-secondary);font-size:12px">${rows.length} insight(s)</div>`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("renderInsightsTable failed", { error: msg });
    return emptyState(`Failed to load insights: ${msg}`);
  }
}

// ============================================================================
// HTMX partial route handlers
// ============================================================================

export function registerInsightsPartialRoutes(deps: UIDependencies) {
  return {
    list: async (c: Context) => {
      try {
        const html = await renderInsightsTable(deps);
        return c.html(html);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Partial render error", { error: msg });
        return c.html(emptyState(`Error: ${msg}`));
      }
    },
  };
}
