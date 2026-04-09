/**
 * HTMX partial responses for Mining view
 *
 * Server-renders mining stats summary and recent progress entries
 * from the mining_progress table in the EventStore database.
 * Returns HTML fragments for HTMX swap.
 */

import type { Context } from "hono";
import { escapeHtml, formatDate } from "../layout.js";
import { statCard, badge, emptyState } from "../components.js";
import type { UIDependencies } from "../routes.js";
import { createLogger } from "../../../util/logger.js";

const log = createLogger("UI:Mining:Partial");

// ============================================================================
// Types
// ============================================================================

interface MiningStats {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  facts_extracted: number;
}

interface MiningProgressRow {
  session_file: string;
  project: string | null;
  status: string;
  user_messages_count: number;
  facts_extracted: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

// ============================================================================
// Render helpers
// ============================================================================

function getDb(deps: UIDependencies): import("bun:sqlite").Database | null {
  return (deps.eventStore as { getDatabase?: () => import("bun:sqlite").Database }).getDatabase?.() ?? null;
}

function queryStats(db: import("bun:sqlite").Database): MiningStats {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'completed'  THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END) as failed,
        COALESCE(SUM(facts_extracted), 0) as facts_extracted
      FROM mining_progress
    `).get() as MiningStats | null;
    return row ?? { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, facts_extracted: 0 };
  } catch {
    // Table doesn't exist yet — mining hasn't run
    return { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, facts_extracted: 0 };
  }
}

function queryRecentProgress(db: import("bun:sqlite").Database, limit = 50): MiningProgressRow[] {
  try {
    return db.prepare(`
      SELECT
        session_file,
        project,
        status,
        user_messages_count,
        facts_extracted,
        started_at,
        completed_at,
        error
      FROM mining_progress
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC
      LIMIT ?
    `).all(limit) as MiningProgressRow[];
  } catch (error) {
    log.warn("Failed to query mining progress", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function renderStatsGrid(stats: MiningStats): string {
  return `<div class="stats-grid" style="margin-bottom:24px">
    ${statCard("Total Sessions", stats.total)}
    ${statCard("Pending", stats.pending)}
    ${statCard("Processing", stats.processing)}
    ${statCard("Completed", stats.completed)}
    ${statCard("Failed", stats.failed)}
    ${statCard("Facts Extracted", stats.facts_extracted)}
  </div>`;
}

function statusBadge(status: string): string {
  const variantMap: Record<string, "success" | "warning" | "error" | "muted" | "info"> = {
    completed: "success",
    processing: "info",
    pending: "muted",
    failed: "error",
  };
  return badge(status, variantMap[status] ?? "muted");
}

function renderProgressTable(rows: MiningProgressRow[]): string {
  if (rows.length === 0) {
    return emptyState("No mining activity yet. Click 'Start Mining' to begin.", "\u25BC");
  }

  const headerCells = ["Session File", "Project", "Status", "Messages", "Facts", "Started", "Completed", "Error"]
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join("");

  const bodyRows = rows.map((row) => {
    const filename = row.session_file.split("/").pop() ?? row.session_file;
    const started = row.started_at ? formatDate(row.started_at) : "-";
    const completed = row.completed_at ? formatDate(row.completed_at) : "-";
    const errorTruncated = row.error ? (row.error.length > 60 ? `${row.error.slice(0, 60)}...` : row.error) : "";

    return `<tr>
      <td class="mono truncate" style="max-width:200px" title="${escapeHtml(row.session_file)}">${escapeHtml(filename)}</td>
      <td class="truncate" style="max-width:120px">${escapeHtml(row.project ?? "-")}</td>
      <td>${statusBadge(row.status)}</td>
      <td style="text-align:right">${escapeHtml(String(row.user_messages_count))}</td>
      <td style="text-align:right">${escapeHtml(String(row.facts_extracted))}</td>
      <td style="white-space:nowrap">${escapeHtml(started)}</td>
      <td style="white-space:nowrap">${escapeHtml(completed)}</td>
      <td class="truncate" style="max-width:160px;color:var(--error)" title="${escapeHtml(row.error ?? "")}">${escapeHtml(errorTruncated)}</td>
    </tr>`;
  }).join("\n");

  return `<div class="table-wrap">
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>
  <div style="margin-top:12px;color:var(--text-secondary);font-size:12px">${rows.length} recent session(s)</div>`;
}

/**
 * Render the complete mining dashboard: stats grid + progress table.
 * Used by both the full page view and the HTMX partial (refresh).
 */
export async function renderMiningTable(deps: UIDependencies): Promise<{ statsHtml: string; tableHtml: string }> {
  const db = getDb(deps);
  if (!db) {
    return {
      statsHtml: renderStatsGrid({ total: 0, pending: 0, processing: 0, completed: 0, failed: 0, facts_extracted: 0 }),
      tableHtml: emptyState("EventStore database unavailable."),
    };
  }

  const stats = queryStats(db);
  const rows = queryRecentProgress(db);

  return {
    statsHtml: renderStatsGrid(stats),
    tableHtml: renderProgressTable(rows),
  };
}

// ============================================================================
// HTMX partial route handler
// ============================================================================

export function registerMiningPartialRoutes(deps: UIDependencies) {
  return {
    dashboard: async (c: Context) => {
      try {
        const { statsHtml, tableHtml } = await renderMiningTable(deps);
        return c.html(`${statsHtml}${tableHtml}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Partial render error", { error: msg });
        return c.html(emptyState(`Error: ${msg}`));
      }
    },
  };
}
