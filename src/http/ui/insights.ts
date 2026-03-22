/**
 * Insights view for ping-mem UI
 *
 * Shows derived insights extracted by the dreaming engine.
 * Data is server-rendered and fetched via the HTMX partial.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator, emptyState } from "./components.js";
import { renderInsightsTable } from "./partials/insights.js";
import type { UIDependencies } from "./routes.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Insights");

export function registerInsightsRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);

      const tableHtml = await renderInsightsTable(deps);

      const content = `
        <div class="page-header" style="margin-bottom:20px">
          <p style="color:var(--text-secondary);margin:0">
            Derived insights extracted from conversation transcripts by the dreaming engine.
          </p>
        </div>

        <div class="search-bar">
          <button
            class="btn btn-ghost btn-sm"
            hx-get="/ui/partials/insights"
            hx-target="#results"
            hx-swap="innerHTML"
          >Refresh</button>
          ${loadingIndicator()}
        </div>

        <div id="results">
          ${tableHtml}
        </div>

        <div id="detail-panel"></div>
      `;

      return c.html(renderLayout({
        title: "Insights",
        content,
        activeRoute: "insights",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Insights",
        content: emptyState(`Insights unavailable: ${errMsg}`),
        activeRoute: "insights",
        nonce,
        csrfToken,
      }));
    }
  };
}
