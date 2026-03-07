/**
 * HTMX partial responses for Sessions view
 *
 * Returns HTML fragments for session list and session detail (events timeline).
 * Queries SessionManager for session data and EventStore for session events.
 */

import type { Context } from "hono";
import { escapeHtml, formatDate, timeAgo } from "../layout.js";
import { badge, emptyState, eventTypeBadge } from "../components.js";
import type { SessionManager } from "../../../session/SessionManager.js";
import type { SessionStatus, SessionId } from "../../../types/index.js";
import type { UIDependencies } from "../routes.js";
import { createLogger } from "../../../util/logger.js";

const log = createLogger("UI:Sessions");

// ============================================================================
// Types
// ============================================================================

interface SessionFilters {
  status: string;
}

// ============================================================================
// HTML Renderers
// ============================================================================

function sessionStatusBadge(status: SessionStatus): string {
  const variants: Record<string, "success" | "muted" | "warning" | "info"> = {
    active: "success",
    ended: "muted",
    paused: "warning",
    archived: "info",
  };
  return badge(status, variants[status] ?? "muted");
}

export function renderSessionsTable(sessionManager: SessionManager, filters: SessionFilters): string {
  const filterOpts = filters.status
    ? { status: filters.status as SessionStatus }
    : undefined;
  const sessions = sessionManager.listSessions(filterOpts);

  if (sessions.length === 0) {
    return emptyState("No sessions found", "\u25A1");
  }

  // Sort by most recent first
  const sorted = [...sessions].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const rows = sorted.map((s) => {
    const nameShort = s.name.length > 30 ? s.name.slice(0, 30) + "..." : s.name;
    const idShort = s.id.slice(0, 8);

    return `<tr class="clickable"
      hx-get="/ui/partials/sessions/${encodeURIComponent(s.id)}"
      hx-target="#detail-panel"
      hx-swap="innerHTML"
    >
      <td class="mono" title="${escapeHtml(s.id)}">${escapeHtml(idShort)}...</td>
      <td title="${escapeHtml(s.name)}">${escapeHtml(nameShort)}</td>
      <td>${sessionStatusBadge(s.status)}</td>
      <td title="${escapeHtml(s.startedAt.toISOString())}">${timeAgo(s.startedAt)}</td>
      <td>${s.memoryCount}</td>
      <td>${s.eventCount}</td>
    </tr>`;
  }).join("\n");

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>ID</th>
          <th>Name</th>
          <th>Status</th>
          <th>Started</th>
          <th>Memories</th>
          <th>Events</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderSessionDetail(
  session: { id: string; name: string; status: SessionStatus; startedAt: Date; endedAt?: Date; projectDir?: string; memoryCount: number; eventCount: number },
  events: Array<{ eventId: string; timestamp: Date; eventType: string; payload: unknown }>
): string {
  const eventsHtml = events.length > 0
    ? `<div class="table-wrap" style="margin-top:12px">
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>
          <tbody>${events.slice(0, 100).map((evt) => `<tr>
            <td>${formatDate(evt.timestamp)}</td>
            <td>${eventTypeBadge(evt.eventType)}</td>
            <td class="truncate">${escapeHtml(summarizePayload(evt.payload))}</td>
          </tr>`).join("\n")}</tbody>
        </table>
      </div>`
    : `<p class="muted" style="margin-top:12px">No events in this session</p>`;

  return `<div class="detail-panel">
    <div class="flex justify-between items-center" style="margin-bottom:16px">
      <h3>Session Detail</h3>
      <button class="btn btn-ghost btn-sm" id="detail-close-btn">Close</button>
    </div>
    <div class="detail-row">
      <span class="detail-label">ID</span>
      <span class="detail-value mono">${escapeHtml(session.id)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Name</span>
      <span class="detail-value">${escapeHtml(session.name)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Status</span>
      <span class="detail-value">${sessionStatusBadge(session.status)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Started</span>
      <span class="detail-value">${formatDate(session.startedAt)}</span>
    </div>
    ${session.endedAt ? `<div class="detail-row">
      <span class="detail-label">Ended</span>
      <span class="detail-value">${formatDate(session.endedAt)}</span>
    </div>` : ""}
    ${session.projectDir ? `<div class="detail-row">
      <span class="detail-label">Project Dir</span>
      <span class="detail-value mono">${escapeHtml(session.projectDir)}</span>
    </div>` : ""}
    <div class="detail-row">
      <span class="detail-label">Memories</span>
      <span class="detail-value">${session.memoryCount}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Events</span>
      <span class="detail-value">${session.eventCount}</span>
    </div>
    <h4 style="margin-top:16px">Events Timeline</h4>
    ${eventsHtml}
  </div>`;
}

function summarizePayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (typeof p.key === "string") return p.key;
  if (typeof p.name === "string") return p.name;
  if (typeof p.title === "string") return String(p.title);
  if (typeof p.operation === "string") return String(p.operation);
  return "";
}

// ============================================================================
// Route Handlers
// ============================================================================

export function registerSessionsPartialRoutes(deps: UIDependencies) {
  return {
    /** GET /ui/partials/sessions -- session list (table fragment) */
    list: async (c: Context) => {
      try {
        const status = c.req.query("status") ?? "";
        const html = renderSessionsTable(deps.sessionManager, { status });
        return c.html(html);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("List error", { error: errMsg });
        return c.html(`<div class="empty-state"><p style="color:var(--error)">Failed to list sessions</p></div>`);
      }
    },

    /** GET /ui/partials/sessions/:sessionId -- session detail with events */
    detail: async (c: Context) => {
      try {
        const sessionId = decodeURIComponent(c.req.param("sessionId")) as SessionId;
        const session = deps.sessionManager.getSession(sessionId);

        if (!session) {
          return c.html(`<div class="detail-panel"><p class="muted">Session not found</p></div>`);
        }

        const events = await deps.eventStore.getBySession(sessionId);
        const eventData = events.map((e) => ({
          eventId: e.eventId,
          timestamp: e.timestamp,
          eventType: e.eventType,
          payload: e.payload,
        }));

        return c.html(renderSessionDetail(session, eventData));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Detail error", { error: errMsg });
        return c.html(`<div class="detail-panel"><p style="color:var(--error)">Failed to load session detail</p></div>`);
      }
    },
  };
}
