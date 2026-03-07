/**
 * HTMX partial responses for Agents view
 *
 * Returns HTML fragments for the agents table with search filtering.
 * Queries the agent_quotas table via EventStore's SQLite database.
 */

import type { Context } from "hono";
import { escapeHtml, timeAgo } from "../layout.js";
import { badge, emptyState } from "../components.js";
import type { EventStore } from "../../../storage/EventStore.js";
import type { UIDependencies } from "../routes.js";
import { createLogger } from "../../../util/logger.js";

const log = createLogger("UI:Agents");

// ============================================================================
// Types
// ============================================================================

interface AgentRow {
  agent_id: string;
  role: string;
  admin: number;
  ttl_ms: number;
  expires_at: string | null;
  current_bytes: number;
  current_count: number;
  quota_bytes: number;
  quota_count: number;
  created_at: string;
  updated_at: string;
}

interface AgentFilters {
  query: string;
}

// ============================================================================
// Query Helpers
// ============================================================================

function queryAgents(eventStore: EventStore, filters: AgentFilters): AgentRow[] {
  const db = eventStore.getDatabase();

  // Check if agent_quotas table exists
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_quotas'"
  ).get() as { name: string } | null;

  if (!tableCheck) {
    return [];
  }

  const escapeLike = (s: string): string =>
    s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

  if (filters.query) {
    const pattern = `%${escapeLike(filters.query)}%`;
    return db.prepare(`
      SELECT * FROM agent_quotas
      WHERE agent_id LIKE $pattern ESCAPE '\\'
        OR role LIKE $pattern ESCAPE '\\'
      ORDER BY updated_at DESC
    `).all({ $pattern: pattern }) as AgentRow[];
  }

  return db.prepare(
    "SELECT * FROM agent_quotas ORDER BY updated_at DESC"
  ).all() as AgentRow[];
}

function getAgentCount(eventStore: EventStore): number {
  const db = eventStore.getDatabase();
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_quotas'"
  ).get() as { name: string } | null;

  if (!tableCheck) return 0;

  const row = db.prepare("SELECT COUNT(*) as cnt FROM agent_quotas").get() as { cnt: number };
  return row.cnt;
}

// ============================================================================
// HTML Renderers
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function statusBadge(expiresAt: string | null): string {
  if (!expiresAt) return badge("active", "success");
  const expires = new Date(expiresAt);
  if (expires.getTime() > Date.now()) return badge("active", "success");
  return badge("expired", "error");
}

export function renderAgentsTable(eventStore: EventStore, filters: AgentFilters): string {
  const agents = queryAgents(eventStore, filters);

  if (agents.length === 0) {
    return emptyState("No agents registered", "\u2295");
  }

  const rows = agents.map((a) => {
    const bytesUsage = `${formatBytes(a.current_bytes)} / ${formatBytes(a.quota_bytes)}`;
    const countUsage = `${a.current_count} / ${a.quota_count}`;

    return `<tr>
      <td class="mono">${escapeHtml(a.agent_id)}</td>
      <td>${escapeHtml(a.role)}${a.admin ? ` ${badge("admin", "warning")}` : ""}</td>
      <td>${escapeHtml(bytesUsage)}</td>
      <td>${escapeHtml(countUsage)}</td>
      <td>${escapeHtml(formatDuration(a.ttl_ms))}</td>
      <td>${a.expires_at ? `<span title="${escapeHtml(a.expires_at)}">${timeAgo(a.expires_at)}</span>` : "<span class='muted'>-</span>"}</td>
      <td>${statusBadge(a.expires_at)}</td>
    </tr>`;
  }).join("\n");

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Agent ID</th>
          <th>Role</th>
          <th>Bytes Usage</th>
          <th>Count Usage</th>
          <th>TTL</th>
          <th>Expires</th>
          <th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ============================================================================
// Route Handlers
// ============================================================================

export { getAgentCount };

export function registerAgentsPartialRoutes(deps: UIDependencies) {
  return {
    /** GET /ui/partials/agents -- search/filter results (table fragment) */
    search: async (c: Context) => {
      try {
        const query = c.req.query("query") ?? "";
        const html = renderAgentsTable(deps.eventStore, { query });
        return c.html(html);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Search error", { error: errMsg });
        return c.html(`<div class="empty-state"><p style="color:var(--error)">Search failed</p></div>`);
      }
    },
  };
}
