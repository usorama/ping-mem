/**
 * Events view for ping-mem UI
 *
 * Full paginated event log from EventStore with type filtering and session search.
 * Shows timestamp, event type, session, and detail summary.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator } from "./components.js";
import { renderEventsTable, EVENT_TYPES } from "./partials/events.js";
import type { UIDependencies } from "./routes.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Events");

export function registerEventsRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const eventType = c.req.query("eventType") ?? "";
      const sessionId = c.req.query("sessionId") ?? "";
      const MAX_LIMIT = 500;
      const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50), MAX_LIMIT);
      const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);

      const tableHtml = renderEventsTable(deps.eventStore, { eventType, sessionId, limit, offset });

      const eventTypeOptions = EVENT_TYPES.map(
        (et) => `<option value="${escapeHtml(et)}"${eventType === et ? " selected" : ""}>${escapeHtml(et.replace(/_/g, " "))}</option>`
      ).join("");

      const content = `
        <div class="search-bar">
          <input
            type="search"
            name="sessionId"
            value="${escapeHtml(sessionId)}"
            placeholder="Filter by session ID..."
            hx-get="/ui/partials/events"
            hx-trigger="input changed delay:300ms, search"
            hx-target="#results"
            hx-swap="innerHTML"
            hx-include="[name='eventType']"
          >
          <select name="eventType"
            hx-get="/ui/partials/events"
            hx-trigger="change"
            hx-target="#results"
            hx-swap="innerHTML"
            hx-include="[name='sessionId']"
          >
            <option value="">All event types</option>
            ${eventTypeOptions}
          </select>
          ${loadingIndicator()}
        </div>

        <div id="results">
          ${tableHtml}
        </div>
      `;

      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Events",
        content,
        activeRoute: "events",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Events",
        content: `<div class="card" style="padding:24px;color:var(--error)">Events error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "events",
        nonce,
        csrfToken,
      }));
    }
  };
}
