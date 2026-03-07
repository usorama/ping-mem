/**
 * Worklog view for ping-mem UI
 *
 * Shows worklog events (TOOL_RUN_RECORDED) from EventStore.
 * Displays title, kind, status, tool, duration, and session.
 * Filterable by kind dropdown.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator } from "./components.js";
import { renderWorklogTable, WORKLOG_KINDS } from "./partials/worklog.js";
import type { UIDependencies } from "./routes.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Worklog");

export function registerWorklogRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const kind = c.req.query("kind") ?? "";
      const MAX_LIMIT = 500;
      const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50), MAX_LIMIT);
      const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);

      const tableHtml = renderWorklogTable(deps.eventStore, { kind, limit, offset });

      const kindOptions = WORKLOG_KINDS.map(
        (k) => `<option value="${escapeHtml(k)}"${kind === k ? " selected" : ""}>${escapeHtml(k)}</option>`
      ).join("");

      const content = `
        <div class="search-bar">
          <select name="kind"
            hx-get="/ui/partials/worklog"
            hx-trigger="change"
            hx-target="#results"
            hx-swap="innerHTML"
          >
            <option value="">All kinds</option>
            ${kindOptions}
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
        title: "Worklog",
        content,
        activeRoute: "worklog",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Worklog",
        content: `<div class="card" style="padding:24px;color:var(--error)">Worklog error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "worklog",
        nonce,
        csrfToken,
      }));
    }
  };
}
