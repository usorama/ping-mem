/**
 * Memory Explorer view for ping-mem UI
 *
 * Full-page render with search bar, filter dropdowns, results table, and
 * HTMX-powered search/detail. Queries EventStore SQLite directly for
 * cross-session memory browsing.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce, getCsrfToken } from "./layout.js";
import { loadingIndicator } from "./components.js";
import { renderMemoryTable } from "./partials/memories.js";
import type { UIDependencies } from "./routes.js";

const CATEGORIES = ["task", "decision", "progress", "note", "error", "warning", "fact", "observation"];
const PRIORITIES = ["high", "normal", "low"];

export function registerMemoryRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
    const query = c.req.query("query") ?? "";
    const category = c.req.query("category") ?? "";
    const priority = c.req.query("priority") ?? "";
    const MAX_LIMIT = 500;
    const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "25", 10) || 25), MAX_LIMIT);
    const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);

    // Initial load: render full page with results
    const tableHtml = renderMemoryTable(deps.eventStore, { query, category, priority, limit, offset });

    const categoryOptions = CATEGORIES.map(
      (cat) => `<option value="${cat}"${category === cat ? " selected" : ""}>${cat}</option>`
    ).join("");

    const priorityOptions = PRIORITIES.map(
      (p) => `<option value="${p}"${priority === p ? " selected" : ""}>${p}</option>`
    ).join("");

    const content = `
      <div class="search-bar">
        <input
          type="search"
          name="query"
          value="${escapeHtml(query)}"
          placeholder="Search memories..."
          hx-get="/ui/partials/memories"
          hx-trigger="input changed delay:300ms, search"
          hx-target="#results"
          hx-swap="innerHTML"
          hx-include="[name='category'], [name='priority']"
        >
        <select name="category"
          hx-get="/ui/partials/memories"
          hx-trigger="change"
          hx-target="#results"
          hx-swap="innerHTML"
          hx-include="[name='query'], [name='priority']"
        >
          <option value="">All categories</option>
          ${categoryOptions}
        </select>
        <select name="priority"
          hx-get="/ui/partials/memories"
          hx-trigger="change"
          hx-target="#results"
          hx-swap="innerHTML"
          hx-include="[name='query'], [name='category']"
        >
          <option value="">All priorities</option>
          ${priorityOptions}
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
    const html = renderLayout({
      title: "Memory Explorer",
      content,
      activeRoute: "memories",
      nonce,
      csrfToken,
    });

    return c.html(html);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[Memories] Page render error:", errMsg);
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Memory Explorer",
        content: `<div class="card" style="padding:24px;color:var(--error)">Memory Explorer error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "memories",
        nonce,
        csrfToken,
      }));
    }
  };
}
