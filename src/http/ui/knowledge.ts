/**
 * Knowledge view for ping-mem UI
 *
 * Shows knowledge entries with search via KnowledgeStore FTS5.
 * Displays title, project, tags, and detail panel for full entry.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator, emptyState } from "./components.js";
import { renderKnowledgeTable } from "./partials/knowledge.js";
import type { UIDependencies } from "./routes.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Knowledge");

export function registerKnowledgeRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const { knowledgeStore } = deps;

      if (!knowledgeStore) {
        const nonce = getCspNonce(c);
        const csrfToken = getCsrfToken(c);
        return c.html(renderLayout({
          title: "Knowledge",
          content: emptyState("KnowledgeStore not configured"),
          activeRoute: "knowledge",
          nonce,
          csrfToken,
        }));
      }

      const query = c.req.query("query") ?? "";
      const tableHtml = renderKnowledgeTable(knowledgeStore, { query });

      const content = `
        <div class="search-bar">
          <input
            type="search"
            name="query"
            value="${escapeHtml(query)}"
            placeholder="Search knowledge entries..."
            hx-get="/ui/partials/knowledge"
            hx-trigger="input changed delay:300ms, search"
            hx-target="#results"
            hx-swap="innerHTML"
          >
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
        title: "Knowledge",
        content,
        activeRoute: "knowledge",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Knowledge",
        content: `<div class="card" style="padding:24px;color:var(--error)">Knowledge error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "knowledge",
        nonce,
        csrfToken,
      }));
    }
  };
}
