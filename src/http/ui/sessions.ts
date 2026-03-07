/**
 * Sessions view for ping-mem UI
 *
 * Lists all sessions from SessionManager with status, start time, and memory count.
 * Clicking a session shows its events timeline in a detail panel.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator } from "./components.js";
import { renderSessionsTable } from "./partials/sessions.js";
import type { UIDependencies } from "./routes.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Sessions");

export function registerSessionsRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const statusFilter = c.req.query("status") ?? "";
      const tableHtml = renderSessionsTable(deps.sessionManager, { status: statusFilter });

      const content = `
        <div class="search-bar">
          <select name="status"
            hx-get="/ui/partials/sessions"
            hx-trigger="change"
            hx-target="#results"
            hx-swap="innerHTML"
          >
            <option value="">All sessions</option>
            <option value="active"${statusFilter === "active" ? " selected" : ""}>Active</option>
            <option value="ended"${statusFilter === "ended" ? " selected" : ""}>Ended</option>
          </select>
          ${loadingIndicator()}
        </div>

        <div id="results">
          ${tableHtml}
        </div>

        <div id="detail-panel"></div>
      `;

      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Sessions",
        content,
        activeRoute: "sessions",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Sessions",
        content: `<div class="card" style="padding:24px;color:var(--error)">Sessions error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "sessions",
        nonce,
        csrfToken,
      }));
    }
  };
}
