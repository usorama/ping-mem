/**
 * HTMX partial responses for Memory Explorer
 *
 * These handlers return HTML fragments (not full pages) for HTMX swaps.
 * Queries EventStore SQLite directly for cross-session memory browsing.
 */

import type { Context } from "hono";
import { escapeHtml, formatDate, timeAgo } from "../layout.js";
import { priorityBadge, categoryBadge, pagination, emptyState } from "../components.js";
import type { EventStore } from "../../../storage/EventStore.js";
import type { UIDependencies } from "../routes.js";
import type { MemoryEventData } from "../../../types/index.js";

// ============================================================================
// Types
// ============================================================================

interface MemoryRow {
  key: string;
  value: string;
  sessionId: string;
  category: string | undefined;
  priority: string;
  channel: string | undefined;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

interface MemoryFilters {
  query: string;
  category: string;
  priority: string;
  limit: number;
  offset: number;
}

// ============================================================================
// Query Helpers
// ============================================================================

function queryMemories(
  eventStore: EventStore,
  filters: MemoryFilters
): { memories: MemoryRow[]; total: number } {
  const db = eventStore.getDatabase();

  // Query MEMORY_SAVED events, deduplicated by key (most recent wins)
  // Then exclude keys that have MEMORY_DELETED events after the save
  const sql = `
    SELECT e.payload, e.timestamp
    FROM events e
    WHERE e.event_type = 'MEMORY_SAVED'
    AND NOT EXISTS (
      SELECT 1 FROM events d
      WHERE d.event_type = 'MEMORY_DELETED'
      AND json_extract(d.payload, '$.key') = json_extract(e.payload, '$.key')
      AND d.rowid > e.rowid
    )
    ORDER BY e.timestamp DESC
  `;

  const rows = db.prepare(sql).all() as Array<{ payload: string; timestamp: string }>;

  // Deduplicate by key (keep most recent save)
  const seen = new Set<string>();
  let memories: MemoryRow[] = [];

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as MemoryEventData;
      const key = payload.key;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const memData = payload.memory;
      if (!memData) continue;

      memories.push({
        key,
        value: memData.value ?? "",
        sessionId: payload.sessionId ?? "",
        category: memData.category as string | undefined,
        priority: (memData.priority as string) ?? "normal",
        channel: memData.channel as string | undefined,
        createdAt: memData.createdAt
          ? String(memData.createdAt)
          : row.timestamp,
        updatedAt: memData.updatedAt
          ? String(memData.updatedAt)
          : row.timestamp,
        metadata: (memData.metadata as Record<string, unknown>) ?? {},
      });
    } catch {
      continue;
    }
  }

  // Apply filters
  if (filters.query) {
    const q = filters.query.toLowerCase();
    memories = memories.filter(
      (m) =>
        m.key.toLowerCase().includes(q) ||
        m.value.toLowerCase().includes(q)
    );
  }

  if (filters.category) {
    memories = memories.filter((m) => m.category === filters.category);
  }

  if (filters.priority) {
    memories = memories.filter((m) => m.priority === filters.priority);
  }

  const total = memories.length;
  const paginated = memories.slice(filters.offset, filters.offset + filters.limit);

  return { memories: paginated, total };
}

function getMemoryByKey(eventStore: EventStore, key: string): MemoryRow | null {
  const db = eventStore.getDatabase();

  // Get most recent MEMORY_SAVED event for this key
  const row = db.prepare(`
    SELECT payload, timestamp FROM events
    WHERE event_type = 'MEMORY_SAVED'
    AND json_extract(payload, '$.key') = $key
    ORDER BY timestamp DESC
    LIMIT 1
  `).get({ $key: key }) as { payload: string; timestamp: string } | undefined;

  if (!row) return null;

  try {
    const payload = JSON.parse(row.payload) as MemoryEventData;
    const memData = payload.memory;
    if (!memData) return null;

    return {
      key: payload.key,
      value: memData.value ?? "",
      sessionId: payload.sessionId ?? "",
      category: memData.category as string | undefined,
      priority: (memData.priority as string) ?? "normal",
      channel: memData.channel as string | undefined,
      createdAt: memData.createdAt ? String(memData.createdAt) : row.timestamp,
      updatedAt: memData.updatedAt ? String(memData.updatedAt) : row.timestamp,
      metadata: (memData.metadata as Record<string, unknown>) ?? {},
    };
  } catch {
    return null;
  }
}

// ============================================================================
// HTML Renderers
// ============================================================================

export function renderMemoryTable(
  eventStore: EventStore,
  filters: MemoryFilters
): string {
  const { memories, total } = queryMemories(eventStore, filters);

  if (memories.length === 0) {
    return emptyState("No memories found", "\u29C9");
  }

  const rows = memories.map((m) => {
    const keyShort = m.key.length > 40 ? m.key.slice(0, 40) + "..." : m.key;
    const valueShort = m.value.length > 60 ? m.value.slice(0, 60) + "..." : m.value;

    return `<tr class="clickable"
      hx-get="/ui/partials/memory/${encodeURIComponent(m.key)}"
      hx-target="#detail-panel"
      hx-swap="innerHTML"
    >
      <td class="mono" title="${escapeHtml(m.key)}">${escapeHtml(keyShort)}</td>
      <td class="truncate">${escapeHtml(valueShort)}</td>
      <td>${m.category ? categoryBadge(m.category) : "<span class='muted'>-</span>"}</td>
      <td>${priorityBadge(m.priority)}</td>
      <td title="${escapeHtml(m.createdAt)}">${timeAgo(m.createdAt)}</td>
    </tr>`;
  }).join("\n");

  const baseUrl = `/ui/partials/memories?query=${encodeURIComponent(filters.query)}&category=${encodeURIComponent(filters.category)}&priority=${encodeURIComponent(filters.priority)}`;

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Key</th>
          <th>Value</th>
          <th>Category</th>
          <th>Priority</th>
          <th>Created</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagination(filters.offset, filters.limit, total, baseUrl)}
  `;
}

function renderMemoryDetail(memory: MemoryRow): string {
  const metadataJson = Object.keys(memory.metadata).length > 0
    ? JSON.stringify(memory.metadata, null, 2)
    : null;

  return `<div class="detail-panel">
    <div class="flex justify-between items-center" style="margin-bottom:16px">
      <h3>Memory Detail</h3>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('detail-panel').innerHTML=''">Close</button>
    </div>
    <div class="detail-row">
      <span class="detail-label">Key</span>
      <span class="detail-value mono">${escapeHtml(memory.key)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Value</span>
      <span class="detail-value"><pre>${escapeHtml(memory.value)}</pre></span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Session</span>
      <span class="detail-value mono">${escapeHtml(memory.sessionId)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Category</span>
      <span class="detail-value">${memory.category ? categoryBadge(memory.category) : "<span class='muted'>none</span>"}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Priority</span>
      <span class="detail-value">${priorityBadge(memory.priority)}</span>
    </div>
    ${memory.channel ? `<div class="detail-row">
      <span class="detail-label">Channel</span>
      <span class="detail-value">${escapeHtml(memory.channel)}</span>
    </div>` : ""}
    <div class="detail-row">
      <span class="detail-label">Created</span>
      <span class="detail-value">${formatDate(memory.createdAt)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Updated</span>
      <span class="detail-value">${formatDate(memory.updatedAt)}</span>
    </div>
    ${metadataJson ? `<div class="detail-row">
      <span class="detail-label">Metadata</span>
      <span class="detail-value"><pre>${escapeHtml(metadataJson)}</pre></span>
    </div>` : ""}
  </div>`;
}

// ============================================================================
// Route Handlers
// ============================================================================

export function registerMemoryPartialRoutes(deps: UIDependencies) {
  return {
    /** GET /ui/partials/memories — search/filter results (table fragment) */
    search: async (c: Context) => {
      const query = c.req.query("query") ?? "";
      const category = c.req.query("category") ?? "";
      const priority = c.req.query("priority") ?? "";
      const limit = parseInt(c.req.query("limit") ?? "25");
      const offset = parseInt(c.req.query("offset") ?? "0");

      const html = renderMemoryTable(deps.eventStore, { query, category, priority, limit, offset });
      return c.html(html);
    },

    /** GET /ui/partials/memory/:key — detail panel */
    detail: async (c: Context) => {
      const key = decodeURIComponent(c.req.param("key"));
      const memory = getMemoryByKey(deps.eventStore, key);

      if (!memory) {
        return c.html(`<div class="detail-panel"><p class="muted">Memory not found</p></div>`);
      }

      return c.html(renderMemoryDetail(memory));
    },
  };
}
