/**
 * HTMX partial responses for Worklog view
 *
 * Returns HTML fragments for the worklog event list with kind filtering.
 * Queries EventStore for TOOL_RUN_RECORDED events with WorklogEventData payloads.
 */

import type { Context } from "hono";
import { escapeHtml, formatDate } from "../layout.js";
import { badge, pagination, emptyState } from "../components.js";
import type { EventStore } from "../../../storage/EventStore.js";
import type { UIDependencies } from "../routes.js";
import { createLogger } from "../../../util/logger.js";

const log = createLogger("UI:Worklog");

// ============================================================================
// Constants
// ============================================================================

export const WORKLOG_KINDS = ["tool", "diagnostics", "git", "task"];

// ============================================================================
// Types
// ============================================================================

interface WorklogFilters {
  kind: string;
  limit: number;
  offset: number;
}

interface WorklogRow {
  event_id: string;
  timestamp: string;
  session_id: string;
  payload: string;
}

interface WorklogPayload {
  kind?: string;
  title?: string;
  status?: string;
  toolName?: string;
  durationMs?: number;
  sessionId?: string;
}

// ============================================================================
// Query Helpers
// ============================================================================

function queryWorklog(
  eventStore: EventStore,
  filters: WorklogFilters
): { entries: WorklogRow[]; total: number } {
  const db = eventStore.getDatabase();

  const conditions = ["e.event_type = 'TOOL_RUN_RECORDED'"];
  const params: Record<string, string | number> = {};

  if (filters.kind) {
    conditions.push("json_extract(e.payload, '$.kind') = $kind");
    params.$kind = filters.kind;
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  // Count total
  const countSql = `SELECT COUNT(*) as cnt FROM events e ${whereClause}`;
  const countRow = db.prepare(countSql).get(params) as { cnt: number };
  const total = countRow.cnt;

  // Fetch page
  const sql = `
    SELECT e.event_id, e.timestamp, e.session_id, e.payload
    FROM events e
    ${whereClause}
    ORDER BY e.timestamp DESC
    LIMIT $limit OFFSET $offset
  `;

  const rows = db.prepare(sql).all({
    ...params,
    $limit: filters.limit,
    $offset: filters.offset,
  }) as WorklogRow[];

  return { entries: rows, total };
}

// ============================================================================
// HTML Renderers
// ============================================================================

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function statusBadge(status: string | undefined): string {
  if (!status) return badge("unknown", "muted");
  const variants: Record<string, "success" | "error" | "warning" | "muted"> = {
    success: "success",
    failed: "error",
    partial: "warning",
  };
  return badge(status, variants[status] ?? "muted");
}

function kindBadge(kind: string | undefined): string {
  if (!kind) return badge("unknown", "muted");
  const variants: Record<string, "info" | "warning" | "success" | "muted"> = {
    tool: "info",
    diagnostics: "warning",
    git: "success",
    task: "muted",
  };
  return badge(kind, variants[kind] ?? "muted");
}

export function renderWorklogTable(eventStore: EventStore, filters: WorklogFilters): string {
  const { entries, total } = queryWorklog(eventStore, filters);

  if (entries.length === 0) {
    return emptyState("No worklog entries found", "\u25F7");
  }

  const rows = entries.map((entry) => {
    let payload: WorklogPayload = {};
    try {
      payload = JSON.parse(entry.payload) as WorklogPayload;
    } catch {
      // ignore parse errors
    }

    const sessionShort = entry.session_id.slice(0, 8);
    const titleShort = (payload.title ?? "").length > 50
      ? (payload.title ?? "").slice(0, 50) + "..."
      : (payload.title ?? "");

    return `<tr>
      <td title="${escapeHtml(payload.title ?? "")}">${escapeHtml(titleShort)}</td>
      <td>${kindBadge(payload.kind)}</td>
      <td>${statusBadge(payload.status)}</td>
      <td>${payload.toolName ? escapeHtml(payload.toolName) : "<span class='muted'>-</span>"}</td>
      <td>${escapeHtml(formatDuration(payload.durationMs))}</td>
      <td class="mono" title="${escapeHtml(entry.session_id)}">${escapeHtml(sessionShort)}...</td>
      <td>${formatDate(entry.timestamp)}</td>
    </tr>`;
  }).join("\n");

  const baseUrl = `/ui/partials/worklog?kind=${encodeURIComponent(filters.kind)}`;

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Title</th>
          <th>Kind</th>
          <th>Status</th>
          <th>Tool</th>
          <th>Duration</th>
          <th>Session</th>
          <th>Timestamp</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagination(filters.offset, filters.limit, total, baseUrl)}
  `;
}

// ============================================================================
// Route Handlers
// ============================================================================

export function registerWorklogPartialRoutes(deps: UIDependencies) {
  return {
    /** GET /ui/partials/worklog -- paginated worklog list with kind filter */
    list: async (c: Context) => {
      try {
        const kind = c.req.query("kind") ?? "";
        const MAX_LIMIT = 500;
        const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50), MAX_LIMIT);
        const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);

        const html = renderWorklogTable(deps.eventStore, { kind, limit, offset });
        return c.html(html);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("List error", { error: errMsg });
        return c.html(`<div class="empty-state"><p style="color:var(--error)">Failed to load worklog</p></div>`);
      }
    },
  };
}
