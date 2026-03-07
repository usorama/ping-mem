/**
 * Agents view for ping-mem UI
 *
 * Shows registered agent quotas, roles, TTLs, and status.
 * Queries the agent_quotas table via EventStore's SQLite database.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator } from "./components.js";
import { renderAgentsTable } from "./partials/agents.js";
import type { UIDependencies } from "./routes.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Agents");

export function registerAgentsRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const query = c.req.query("query") ?? "";
      const tableHtml = renderAgentsTable(deps.eventStore, { query });

      const content = `
        <div class="search-bar">
          <input
            type="search"
            name="query"
            value="${escapeHtml(query)}"
            placeholder="Search agents by ID or role..."
            hx-get="/ui/partials/agents"
            hx-trigger="input changed delay:300ms, search"
            hx-target="#results"
            hx-swap="innerHTML"
          >
          ${loadingIndicator()}
        </div>

        <div id="results">
          ${tableHtml}
        </div>
      `;

      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Agents",
        content,
        activeRoute: "agents",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Agents",
        content: `<div class="card" style="padding:24px;color:var(--error)">Agents error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "agents",
        nonce,
        csrfToken,
      }));
    }
  };
}
