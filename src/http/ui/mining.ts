/**
 * Mining view for ping-mem UI
 *
 * Shows mining pipeline status: stats summary and recent progress entries.
 * Provides a "Start Mining" button that triggers the mining pipeline.
 */

import type { Context } from "hono";
import { renderLayout, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator, emptyState } from "./components.js";
import { renderMiningTable } from "./partials/mining.js";
import type { UIDependencies } from "./routes.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Mining");

export function registerMiningRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);

      const { statsHtml, tableHtml } = await renderMiningDashboard(deps);

      const content = `
        <div class="search-bar" style="margin-bottom:20px;gap:12px">
          <button
            class="btn btn-sm"
            style="background:var(--accent);color:#fff;border:none;cursor:pointer;padding:6px 16px;border-radius:4px"
            hx-post="/api/v1/mining/start"
            hx-target="#mining-result"
            hx-swap="innerHTML"
            hx-confirm="Start mining transcripts? This may take a while."
          >Start Mining</button>
          <button
            class="btn btn-ghost btn-sm"
            hx-get="/ui/partials/mining"
            hx-target="#mining-dashboard"
            hx-swap="innerHTML"
          >Refresh</button>
          ${loadingIndicator()}
        </div>

        <div id="mining-result" style="margin-bottom:16px"></div>

        <div id="mining-dashboard">
          ${statsHtml}
          ${tableHtml}
        </div>
      `;

      return c.html(renderLayout({
        title: "Mining",
        content,
        activeRoute: "mining",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Mining",
        content: emptyState(`Mining dashboard unavailable: ${errMsg}`),
        activeRoute: "mining",
        nonce,
        csrfToken,
      }));
    }
  };
}

async function renderMiningDashboard(deps: UIDependencies): Promise<{ statsHtml: string; tableHtml: string }> {
  return renderMiningTable(deps);
}
