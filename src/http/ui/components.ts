/**
 * Reusable HTML components for ping-mem UI
 *
 * Pure functions that return HTML strings. Used by all views.
 */

import { escapeHtml } from "./layout.js";

// ============================================================================
// Stat Card
// ============================================================================

export function statCard(label: string, value: string | number, sub?: string): string {
  return `<div class="stat-card">
    <div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value">${escapeHtml(String(value))}</div>
    ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}
  </div>`;
}

// ============================================================================
// Badge
// ============================================================================

type BadgeVariant = "info" | "success" | "warning" | "error" | "muted";

export function badge(text: string, variant: BadgeVariant = "muted"): string {
  return `<span class="badge badge-${variant}">${escapeHtml(text)}</span>`;
}

export function priorityBadge(priority: string): string {
  const variants: Record<string, BadgeVariant> = {
    high: "error",
    normal: "info",
    low: "muted",
  };
  return badge(priority, variants[priority] ?? "muted");
}

export function categoryBadge(category: string): string {
  const variants: Record<string, BadgeVariant> = {
    task: "info",
    decision: "warning",
    progress: "success",
    note: "muted",
    error: "error",
  };
  return badge(category, variants[category] ?? "muted");
}

export function eventTypeBadge(eventType: string): string {
  const variants: Record<string, BadgeVariant> = {
    SESSION_STARTED: "success",
    SESSION_ENDED: "muted",
    MEMORY_SAVED: "info",
    MEMORY_UPDATED: "warning",
    MEMORY_DELETED: "error",
    MEMORY_RECALLED: "muted",
    CHECKPOINT_CREATED: "success",
    WORKLOG_RECORDED: "info",
    DIAGNOSTICS_INGESTED: "warning",
  };
  return badge(eventType.replace(/_/g, " "), variants[eventType] ?? "muted");
}

// ============================================================================
// Table
// ============================================================================

interface TableColumn {
  header: string;
  key: string;
  render?: (row: Record<string, unknown>) => string;
  class?: string;
}

export function table(columns: TableColumn[], rows: Record<string, unknown>[], options?: {
  clickable?: boolean;
  hxGet?: (row: Record<string, unknown>) => string;
  hxTarget?: string;
}): string {
  if (rows.length === 0) {
    return emptyState("No data found");
  }

  const headerCells = columns
    .map((col) => `<th${col.class ? ` class="${col.class}"` : ""}>${escapeHtml(col.header)}</th>`)
    .join("");

  const bodyRows = rows
    .map((row) => {
      const cells = columns
        .map((col) => {
          const value = col.render ? col.render(row) : escapeHtml(String(row[col.key] ?? ""));
          return `<td${col.class ? ` class="${col.class}"` : ""}>${value}</td>`;
        })
        .join("");

      const attrs: string[] = [];
      if (options?.clickable) attrs.push('class="clickable"');
      if (options?.hxGet) {
        attrs.push(`hx-get="${options.hxGet(row)}"`);
        attrs.push(`hx-target="${options.hxTarget ?? "#detail-panel"}"`);
        attrs.push('hx-swap="innerHTML"');
      }

      return `<tr ${attrs.join(" ")}>${cells}</tr>`;
    })
    .join("\n");

  return `<div class="table-wrap">
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>`;
}

// ============================================================================
// Pagination
// ============================================================================

export function pagination(offset: number, limit: number, total: number, baseUrl: string): string {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;

  return `<div class="pagination">
    <span>Showing ${offset + 1}-${Math.min(offset + limit, total)} of ${total}</span>
    <div class="pagination-btns">
      ${hasPrev
        ? `<a class="btn btn-ghost btn-sm" hx-get="${baseUrl}&offset=${prevOffset}&limit=${limit}" hx-target="#results" hx-swap="innerHTML">Prev</a>`
        : `<span class="btn btn-ghost btn-sm" style="opacity:0.4">Prev</span>`
      }
      <span class="btn btn-ghost btn-sm" style="pointer-events:none">${currentPage}/${totalPages}</span>
      ${hasNext
        ? `<a class="btn btn-ghost btn-sm" hx-get="${baseUrl}&offset=${nextOffset}&limit=${limit}" hx-target="#results" hx-swap="innerHTML">Next</a>`
        : `<span class="btn btn-ghost btn-sm" style="opacity:0.4">Next</span>`
      }
    </div>
  </div>`;
}

// ============================================================================
// Empty State
// ============================================================================

export function emptyState(message: string, icon?: string): string {
  return `<div class="empty-state">
    ${icon ? `<div class="icon">${icon}</div>` : ""}
    <p>${escapeHtml(message)}</p>
  </div>`;
}

// ============================================================================
// Card
// ============================================================================

export function card(title: string, content: string, headerRight?: string): string {
  return `<div class="card">
    <div class="card-header">
      <div class="card-title">${escapeHtml(title)}</div>
      ${headerRight ?? ""}
    </div>
    ${content}
  </div>`;
}

// ============================================================================
// Loading indicator
// ============================================================================

export function loadingIndicator(): string {
  return `<span class="htmx-indicator" style="margin-left:8px;font-size:12px;color:var(--text-secondary)">Loading...</span>`;
}
