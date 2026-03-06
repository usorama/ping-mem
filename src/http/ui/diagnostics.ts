/**
 * Diagnostics view for ping-mem UI
 *
 * Shows analysis runs list, findings tables, severity chart, and diff view.
 * Data queried directly from DiagnosticsStore.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, getCspNonce } from "./layout.js";
import { loadingIndicator } from "./components.js";
import type { UIDependencies } from "./routes.js";

export function registerDiagnosticsRoutes(deps: UIDependencies) {
  return async (c: Context) => {
    try {
    const { diagnosticsStore } = deps;

    // Get recent runs
    const runs = diagnosticsStore.listRuns({ limit: 30 });

    // Pre-fetch findings counts to avoid N+1 queries (one query per run)
    const findingsCache = new Map<string, number>();
    const severityCounts = { error: 0, warning: 0, note: 0 };

    for (const run of runs) {
      const findings = diagnosticsStore.listFindings(run.analysisId);
      findingsCache.set(run.analysisId, findings.length);
      // Aggregate severity for the first 10 runs
      if (findingsCache.size <= 10) {
        for (const f of findings) {
          if (f.severity === "error") severityCounts.error++;
          else if (f.severity === "warning") severityCounts.warning++;
          else severityCounts.note++;
        }
      }
    }

    // Build run list table
    let runsHtml: string;
    if (runs.length === 0) {
      runsHtml = `<div class="empty-state"><p>No diagnostic runs found. Run diagnostics:collect to ingest SARIF data.</p></div>`;
    } else {
      const rows = runs.map((run) => {
        const findingsCount = findingsCache.get(run.analysisId) ?? 0;
        return `<tr class="clickable"
          hx-get="/ui/partials/diagnostics/findings/${encodeURIComponent(run.analysisId)}"
          hx-target="#findings-panel"
          hx-swap="innerHTML"
        >
          <td class="mono" title="${escapeHtml(run.analysisId)}">${escapeHtml(run.analysisId.slice(0, 12))}...</td>
          <td>${escapeHtml(run.tool.name)}</td>
          <td>${escapeHtml(run.tool.version)}</td>
          <td class="mono" title="${escapeHtml(run.projectId)}">${escapeHtml(run.projectId.slice(0, 12))}...</td>
          <td>${findingsCount}</td>
          <td>${escapeHtml(run.createdAt)}</td>
        </tr>`;
      }).join("\n");

      runsHtml = `<div class="table-wrap">
        <table>
          <thead><tr>
            <th>Analysis ID</th>
            <th>Tool</th>
            <th>Version</th>
            <th>Project</th>
            <th>Findings</th>
            <th>Created</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    const chartData = JSON.stringify(severityCounts);
    const nonce = getCspNonce(c);
    const nonceAttr = nonce ? ` nonce="${nonce}"` : "";

    const content = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">TOTAL RUNS</div>
          <div class="stat-value">${runs.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">ERRORS</div>
          <div class="stat-value" style="color:var(--error)">${severityCounts.error}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">WARNINGS</div>
          <div class="stat-value" style="color:var(--warning)">${severityCounts.warning}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">NOTES</div>
          <div class="stat-value" style="color:var(--info)">${severityCounts.note}</div>
        </div>
      </div>

      <div class="card mb-4">
        <div class="card-header">
          <div class="card-title">Severity Distribution (Recent 10 Runs)</div>
        </div>
        <canvas id="severity-chart" width="400" height="200" style="max-width:100%"></canvas>
      </div>

      <div class="card mb-4">
        <div class="card-header">
          <div class="card-title">Analysis Runs</div>
          ${loadingIndicator()}
        </div>
        ${runsHtml}
      </div>

      <div id="findings-panel"></div>

      <script src="/static/chart.umd.min.js"${nonceAttr}></script>
      <script${nonceAttr}>
        (function() {
          var data = ${chartData};
          var ctx = document.getElementById('severity-chart');
          if (ctx && typeof Chart !== 'undefined') {
            new Chart(ctx, {
              type: 'bar',
              data: {
                labels: ['Errors', 'Warnings', 'Notes'],
                datasets: [{
                  data: [data.error, data.warning, data.note],
                  backgroundColor: ['#dc2626', '#d97706', '#0284c7'],
                  borderRadius: 4,
                }]
              },
              options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: {
                  y: { beginAtZero: true, ticks: { precision: 0 } }
                }
              }
            });
          }
        })();
      </script>
    `;

    return c.html(renderLayout({
      title: "Diagnostics",
      content,
      activeRoute: "diagnostics",
      nonce,
    }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[Diagnostics] Page render error:", errMsg);
      const nonce = getCspNonce(c);
      return c.html(renderLayout({
        title: "Diagnostics",
        content: `<div class="card" style="padding:24px;color:var(--error)">Diagnostics error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "diagnostics",
        nonce,
      }));
    }
  };
}
