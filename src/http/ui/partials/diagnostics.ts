/**
 * HTMX partial responses for Diagnostics view
 *
 * These handlers return HTML fragments for HTMX swaps.
 * Queries DiagnosticsStore for findings tables and diff views.
 */

import type { Context } from "hono";
import { escapeHtml, formatDate } from "../layout.js";
import { badge, emptyState, pagination } from "../components.js";
import type { UIDependencies } from "../routes.js";
import type { NormalizedFinding } from "../../../diagnostics/types.js";

// ============================================================================
// Severity badge helper
// ============================================================================

function severityBadge(severity: string): string {
  const variants: Record<string, "error" | "warning" | "info" | "muted"> = {
    error: "error",
    warning: "warning",
    note: "info",
    info: "info",
  };
  return badge(severity, variants[severity] ?? "muted");
}

// ============================================================================
// HTML Renderers
// ============================================================================

function renderFindingsTable(findings: NormalizedFinding[], analysisId: string): string {
  if (findings.length === 0) {
    return emptyState("No findings for this analysis", "\u2713");
  }

  const rows = findings.map((f) => {
    const location = f.startLine
      ? `${escapeHtml(f.filePath)}:${f.startLine}${f.startColumn ? `:${f.startColumn}` : ""}`
      : escapeHtml(f.filePath);

    return `<tr>
      <td>${severityBadge(f.severity)}</td>
      <td class="mono">${escapeHtml(f.ruleId)}</td>
      <td>${escapeHtml(f.message.length > 80 ? f.message.slice(0, 80) + "..." : f.message)}</td>
      <td class="mono" style="font-size:12px" title="${escapeHtml(f.filePath)}">${escapeHtml(location)}</td>
      ${f.symbolName ? `<td class="mono">${escapeHtml(f.symbolName)}</td>` : "<td><span class='muted'>-</span></td>"}
    </tr>`;
  }).join("\n");

  return `<div class="card">
    <div class="card-header">
      <div class="card-title">Findings for ${escapeHtml(analysisId.slice(0, 12))}...</div>
      <span class="badge badge-muted">${findings.length} findings</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Severity</th>
          <th>Rule</th>
          <th>Message</th>
          <th>Location</th>
          <th>Symbol</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function renderDiffView(
  diff: { introduced: string[]; resolved: string[]; unchanged: string[] },
  findingsA: NormalizedFinding[],
  findingsB: NormalizedFinding[],
  analysisIdA: string,
  analysisIdB: string,
): string {
  const findingsMapB = new Map(findingsB.map((f) => [f.findingId, f]));
  const findingsMapA = new Map(findingsA.map((f) => [f.findingId, f]));

  let html = `<div class="card">
    <div class="card-header">
      <div class="card-title">Diff: ${escapeHtml(analysisIdA.slice(0, 12))}... vs ${escapeHtml(analysisIdB.slice(0, 12))}...</div>
    </div>
    <div class="stats-grid" style="margin-bottom:16px">
      <div class="stat-card">
        <div class="stat-label">INTRODUCED</div>
        <div class="stat-value" style="color:var(--error)">${diff.introduced.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">RESOLVED</div>
        <div class="stat-value" style="color:var(--success)">${diff.resolved.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">UNCHANGED</div>
        <div class="stat-value">${diff.unchanged.length}</div>
      </div>
    </div>`;

  if (diff.introduced.length > 0) {
    const introRows = diff.introduced.slice(0, 50).map((id) => {
      const f = findingsMapB.get(id);
      if (!f) return "";
      return `<tr style="background:rgba(220,38,38,0.05)">
        <td>${severityBadge(f.severity)}</td>
        <td class="mono">${escapeHtml(f.ruleId)}</td>
        <td>${escapeHtml(f.message.length > 60 ? f.message.slice(0, 60) + "..." : f.message)}</td>
        <td class="mono" style="font-size:12px">${escapeHtml(f.filePath)}</td>
      </tr>`;
    }).join("\n");

    html += `<h4 style="margin:12px 0 8px;color:var(--error)">Introduced (new issues)</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>Severity</th><th>Rule</th><th>Message</th><th>File</th></tr></thead>
      <tbody>${introRows}</tbody>
    </table></div>`;
  }

  if (diff.resolved.length > 0) {
    const resolvedRows = diff.resolved.slice(0, 50).map((id) => {
      const f = findingsMapA.get(id);
      if (!f) return "";
      return `<tr style="background:rgba(34,197,94,0.05)">
        <td>${severityBadge(f.severity)}</td>
        <td class="mono">${escapeHtml(f.ruleId)}</td>
        <td>${escapeHtml(f.message.length > 60 ? f.message.slice(0, 60) + "..." : f.message)}</td>
        <td class="mono" style="font-size:12px">${escapeHtml(f.filePath)}</td>
      </tr>`;
    }).join("\n");

    html += `<h4 style="margin:12px 0 8px;color:var(--success)">Resolved (fixed issues)</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>Severity</th><th>Rule</th><th>Message</th><th>File</th></tr></thead>
      <tbody>${resolvedRows}</tbody>
    </table></div>`;
  }

  html += `</div>`;
  return html;
}

// ============================================================================
// Route Handlers
// ============================================================================

export function registerDiagnosticsPartialRoutes(deps: UIDependencies) {
  return {
    /** GET /ui/partials/diagnostics/findings/:analysisId — findings table */
    findings: async (c: Context) => {
      try {
        const analysisId = decodeURIComponent(c.req.param("analysisId"));
        const { diagnosticsStore } = deps;
        const findings = diagnosticsStore.listFindings(analysisId);
        return c.html(renderFindingsTable(findings, analysisId));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[Diagnostics] Findings error:", errMsg);
        return c.html(`<div class="card" style="padding:16px;color:var(--error)">Failed to load findings: ${escapeHtml(errMsg)}</div>`);
      }
    },

    /** GET /ui/partials/diagnostics/diff?a=...&b=... — diff view */
    diff: async (c: Context) => {
      try {
        const analysisIdA = c.req.query("a") ?? "";
        const analysisIdB = c.req.query("b") ?? "";
        const { diagnosticsStore } = deps;

        if (!analysisIdA || !analysisIdB) {
          return c.html(`<div class="detail-panel"><p class="muted">Select two analyses to compare</p></div>`);
        }

        const diff = diagnosticsStore.diffAnalyses(analysisIdA, analysisIdB);
        const findingsA = diagnosticsStore.listFindings(analysisIdA);
        const findingsB = diagnosticsStore.listFindings(analysisIdB);

        return c.html(renderDiffView(diff, findingsA, findingsB, analysisIdA, analysisIdB));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[Diagnostics] Diff error:", errMsg);
        return c.html(`<div class="card" style="padding:16px;color:var(--error)">Failed to load diff: ${escapeHtml(errMsg)}</div>`);
      }
    },
  };
}
