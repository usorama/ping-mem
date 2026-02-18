/**
 * Memory Explorer view for ping-mem UI
 *
 * Full-page render with search bar, filter dropdowns, results table, and
 * HTMX-powered search/detail. Queries EventStore SQLite directly for
 * cross-session memory browsing.
 */

import type { Context } from "hono";
import { renderLayout } from "./layout.js";
import { loadingIndicator } from "./components.js";
import { renderMemoryTable } from "./partials/memories.js";
import type { UIDependencies } from "./routes.js";

const CATEGORIES = ["task", "decision", "progress", "note", "error", "warning", "fact", "observation"];
const PRIORITIES = ["high", "normal", "low"];

export function registerMemoryRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    const query = c.req.query("query") ?? "";
    const category = c.req.query("category") ?? "";
    const priority = c.req.query("priority") ?? "";
    const limit = parseInt(c.req.query("limit") ?? "25");
    const offset = parseInt(c.req.query("offset") ?? "0");

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
          value="${escapeAttr(query)}"
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

    const html = renderLayout({
      title: "Memory Explorer",
      content,
      activeRoute: "memories",
    });

    return c.html(html);
  };
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
