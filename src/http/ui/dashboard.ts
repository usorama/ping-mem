/**
 * Dashboard view for ping-mem UI
 *
 * Shows stats cards, recent events, and quick-access links.
 * Data is queried directly from EventStore, SessionManager, etc.
 */

import type { Context } from "hono";
import { renderLayout, formatDate, escapeHtml } from "./layout.js";
import { statCard, card, eventTypeBadge, emptyState } from "./components.js";
import type { UIDependencies } from "./routes.js";

export function registerDashboardRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const { eventStore, sessionManager } = deps;

      // Gather stats
      const eventStats = eventStore.getStats();
      const sessions = sessionManager.listSessions();
      const activeSessions = sessionManager.listSessions({ status: "active" });
      const recentEvents = eventStore.getRecentEvents(20);

      // Count memories across sessions (from event store)
      const db = eventStore.getDatabase();
      const memoryCountRow = db.prepare(
        "SELECT COUNT(DISTINCT json_extract(payload, '$.key')) as cnt FROM events WHERE event_type = 'MEMORY_SAVED'"
      ).get() as { cnt: number } | undefined;
      const memoryCount = memoryCountRow?.cnt ?? 0;

      // Recent events HTML
      let recentEventsHtml: string;
      if (recentEvents.length === 0) {
        recentEventsHtml = emptyState("No events yet");
      } else {
        const rows = recentEvents.map((evt) => {
          const sessionShort = evt.sessionId.slice(0, 8);
          return `<tr>
            <td>${formatDate(evt.timestamp)}</td>
            <td>${eventTypeBadge(evt.eventType)}</td>
            <td class="mono truncate" title="${escapeHtml(evt.sessionId)}">${escapeHtml(sessionShort)}</td>
            <td class="truncate">${escapeHtml(summarizePayload(evt.payload))}</td>
          </tr>`;
        }).join("\n");

        recentEventsHtml = `<div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Session</th><th>Detail</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      }

      const content = `
        <div class="stats-grid">
          ${statCard("Memories", memoryCount, "across all sessions")}
          ${statCard("Sessions", sessions.length, `${activeSessions.length} active`)}
          ${statCard("Events", eventStats.eventCount)}
          ${statCard("Checkpoints", eventStats.checkpointCount)}
        </div>

        ${card("Recent Events", recentEventsHtml)}

        <div class="mt-4 stats-grid">
          <a href="/ui/memories" class="stat-card" style="text-decoration:none;color:inherit">
            <div class="stat-label">EXPLORE</div>
            <div style="font-size:16px;font-weight:600;margin-top:4px">Memory Explorer</div>
            <div class="stat-sub">Browse and search all memories</div>
          </a>
          <a href="/ui/diagnostics" class="stat-card" style="text-decoration:none;color:inherit">
            <div class="stat-label">ANALYZE</div>
            <div style="font-size:16px;font-weight:600;margin-top:4px">Diagnostics</div>
            <div class="stat-sub">View findings and diffs</div>
          </a>
          <a href="/ui/ingestion" class="stat-card" style="text-decoration:none;color:inherit">
            <div class="stat-label">MONITOR</div>
            <div style="font-size:16px;font-weight:600;margin-top:4px">Ingestion</div>
            <div class="stat-sub">Project pipeline status</div>
          </a>
        </div>
      `;

      return c.html(renderLayout({
        title: "Dashboard",
        content,
        activeRoute: "dashboard",
      }));
    } catch (err) {
      console.error("[Dashboard] Error:", err);
      return c.html(renderLayout({
        title: "Dashboard",
        content: `<div class="card" style="padding:24px;color:var(--error)">Error loading dashboard. Check server logs.</div>`,
        activeRoute: "dashboard",
      }));
    }
  };
}

function summarizePayload(payload: unknown): string {
  const p = payload as Record<string, unknown>;
  if (typeof p.key === "string") return p.key;
  if (typeof p.name === "string") return p.name;
  if (typeof p.title === "string") return String(p.title);
  if (typeof p.operation === "string") return String(p.operation);
  return "";
}
