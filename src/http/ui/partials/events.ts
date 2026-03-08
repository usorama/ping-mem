/**
 * HTMX partial responses for Events view
 *
 * Returns HTML fragments for the paginated event log with type/session filters.
 * Queries EventStore SQLite directly for cross-session event browsing.
 */

import type { Context } from "hono";
import { escapeHtml, formatDate } from "../layout.js";
import { eventTypeBadge, pagination, emptyState } from "../components.js";
import type { EventStore } from "../../../storage/EventStore.js";
import type { UIDependencies } from "../routes.js";
import { createLogger } from "../../../util/logger.js";

const log = createLogger("UI:Events");

// ============================================================================
// Constants
// ============================================================================

export const EVENT_TYPES = [
  "SESSION_STARTED",
  "SESSION_ENDED",
  "SESSION_PAUSED",
  "SESSION_RESUMED",
  "MEMORY_SAVED",
  "MEMORY_UPDATED",
  "MEMORY_DELETED",
  "MEMORY_RECALLED",
  "CHECKPOINT_CREATED",
  "CONTEXT_LOADED",
  "TOOL_RUN_RECORDED",
  "DIAGNOSTICS_INGESTED",
  "GIT_OPERATION_RECORDED",
  "AGENT_TASK_STARTED",
  "AGENT_TASK_SUMMARY",
  "AGENT_TASK_COMPLETED",
];

// ============================================================================
// Types
// ============================================================================

interface EventFilters {
  eventType: string;
  sessionId: string;
  limit: number;
  offset: number;
}

interface EventRow {
  event_id: string;
  timestamp: string;
  session_id: string;
  event_type: string;
  payload: string;
}

// ============================================================================
// Query Helpers
// ============================================================================

function queryEvents(
  eventStore: EventStore,
  filters: EventFilters
): { events: EventRow[]; total: number } {
  const db = eventStore.getDatabase();

  const escapeLike = (s: string): string =>
    s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (filters.eventType) {
    conditions.push("e.event_type = $eventType");
    params.$eventType = filters.eventType;
  }

  if (filters.sessionId) {
    conditions.push("e.session_id LIKE $sessionPattern ESCAPE '\\\\'");
    params.$sessionPattern = `%${escapeLike(filters.sessionId)}%`;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count total
  const countSql = `SELECT COUNT(*) as cnt FROM events e ${whereClause}`;
  const countRow = db.prepare(countSql).get(params) as { cnt: number };
  const total = countRow.cnt;

  // Fetch page
  const sql = `
    SELECT e.event_id, e.timestamp, e.session_id, e.event_type, e.payload
    FROM events e
    ${whereClause}
    ORDER BY e.timestamp DESC
    LIMIT $limit OFFSET $offset
  `;

  const rows = db.prepare(sql).all({
    ...params,
    $limit: filters.limit,
    $offset: filters.offset,
  }) as EventRow[];

  return { events: rows, total };
}

// ============================================================================
// HTML Renderers
// ============================================================================

function summarizePayload(payloadStr: string): string {
  try {
    const p = JSON.parse(payloadStr) as Record<string, unknown>;
    if (typeof p.key === "string") return p.key;
    if (typeof p.name === "string") return p.name;
    if (typeof p.title === "string") return String(p.title);
    if (typeof p.operation === "string") return String(p.operation);
    return "";
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log.debug("Failed to extract event label from payload", { error: msg });
    return "";
  }
}

export function renderEventsTable(eventStore: EventStore, filters: EventFilters): string {
  const { events, total } = queryEvents(eventStore, filters);

  if (events.length === 0) {
    return emptyState("No events found", "\u2261");
  }

  const rows = events.map((evt) => {
    const sessionShort = evt.session_id.slice(0, 8);
    const detail = summarizePayload(evt.payload);

    return `<tr>
      <td>${formatDate(evt.timestamp)}</td>
      <td>${eventTypeBadge(evt.event_type)}</td>
      <td class="mono" title="${escapeHtml(evt.session_id)}">${escapeHtml(sessionShort)}...</td>
      <td class="truncate">${escapeHtml(detail)}</td>
    </tr>`;
  }).join("\n");

  const baseUrl = `/ui/partials/events?eventType=${encodeURIComponent(filters.eventType)}&sessionId=${encodeURIComponent(filters.sessionId)}`;

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Timestamp</th>
          <th>Event Type</th>
          <th>Session</th>
          <th>Detail</th>
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

export function registerEventsPartialRoutes(deps: UIDependencies) {
  return {
    /** GET /ui/partials/events -- paginated event list with filters */
    list: async (c: Context) => {
      try {
        const eventType = c.req.query("eventType") ?? "";
        const sessionId = c.req.query("sessionId") ?? "";
        const MAX_LIMIT = 500;
        const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50), MAX_LIMIT);
        const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);

        const html = renderEventsTable(deps.eventStore, { eventType, sessionId, limit, offset });
        return c.html(html);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("List error", { error: errMsg });
        return c.html(`<div class="empty-state"><p style="color:var(--error)">Failed to load events</p></div>`);
      }
    },
  };
}
