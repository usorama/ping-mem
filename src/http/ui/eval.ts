/**
 * Eval dashboard view for ping-mem UI
 *
 * Shows search quality metrics: Recall@10, NDCG@10, MRR@10.
 * Reads eval run results from .ai/eval/runs/*.json.
 * Displays: latest metrics, run history, per-query-type breakdown, trends.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, formatDate, getCspNonce, getCsrfToken } from "./layout.js";
import { statCard, emptyState, badge } from "./components.js";
import { createLogger } from "../../util/logger.js";
import type { EvalRunResult, EvalResult } from "../../eval/types.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const log = createLogger("UI:Eval");

export interface EvalDashboardConfig {
  runsDir: string;
}

const DEFAULT_RUNS_DIR = ".ai/eval/runs";

export function loadEvalRuns(runsDir: string): EvalRunResult[] {
  if (!existsSync(runsDir)) return [];

  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const runs: EvalRunResult[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(runsDir, file), "utf-8");
      runs.push(JSON.parse(content) as EvalRunResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("Failed to parse eval run file", { file, error: msg });
    }
  }
  return runs;
}

function qualityBadge(value: number): string {
  if (value >= 0.9) return badge(`${(value * 100).toFixed(1)}%`, "success");
  if (value >= 0.7) return badge(`${(value * 100).toFixed(1)}%`, "info");
  if (value >= 0.5) return badge(`${(value * 100).toFixed(1)}%`, "warning");
  return badge(`${(value * 100).toFixed(1)}%`, "error");
}

function renderLatestMetrics(run: EvalRunResult): string {
  const a = run.aggregate;
  return `
    <div class="stats-grid">
      ${statCard("Recall@10", `${(a.meanRecallAt10 * 100).toFixed(1)}%`, "mean across queries")}
      ${statCard("NDCG@10", `${(a.meanNdcgAt10 * 100).toFixed(1)}%`, "normalized DCG")}
      ${statCard("MRR@10", `${(a.meanMrrAt10 * 100).toFixed(1)}%`, "reciprocal rank")}
      ${statCard("Latency", `${a.meanLatencyMs.toFixed(0)}ms`, `p95: ${a.p95LatencyMs.toFixed(0)}ms`)}
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">
      Run: ${escapeHtml(run.runId.slice(0, 8))} | ${escapeHtml(run.timestamp)} | ${run.results.length} queries | dataset ${escapeHtml(run.datasetVersion)}
    </div>
  `;
}

function renderQueryTypeBreakdown(results: EvalResult[]): string {
  const byType = new Map<string, EvalResult[]>();
  for (const r of results) {
    const list = byType.get(r.searchMode) ?? [];
    list.push(r);
    byType.set(r.searchMode, list);
  }

  if (byType.size === 0) return emptyState("No results to break down");

  const rows = [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, typeResults]) => {
      const avgRecall = mean(typeResults.map((r) => r.scores.recallAt10));
      const avgNdcg = mean(typeResults.map((r) => r.scores.ndcgAt10));
      const avgMrr = mean(typeResults.map((r) => r.scores.mrrAt10));
      const avgLatency = mean(typeResults.map((r) => r.latencyMs));

      return `<tr>
        <td>${escapeHtml(type)}</td>
        <td>${typeResults.length}</td>
        <td>${qualityBadge(avgRecall)}</td>
        <td>${qualityBadge(avgNdcg)}</td>
        <td>${qualityBadge(avgMrr)}</td>
        <td>${avgLatency.toFixed(0)}ms</td>
      </tr>`;
    })
    .join("\n");

  return `<div class="table-wrap">
    <table>
      <thead><tr>
        <th>Query Type</th><th>Count</th><th>Recall@10</th><th>NDCG@10</th><th>MRR@10</th><th>Avg Latency</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderRunHistory(runs: EvalRunResult[]): string {
  if (runs.length === 0) return emptyState("No eval runs yet");

  const rows = runs
    .slice(0, 20)
    .map((run) => {
      const a = run.aggregate;
      return `<tr>
        <td class="mono" title="${escapeHtml(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</td>
        <td>${escapeHtml(formatDate(run.timestamp))}</td>
        <td>${qualityBadge(a.meanRecallAt10)}</td>
        <td>${qualityBadge(a.meanNdcgAt10)}</td>
        <td>${qualityBadge(a.meanMrrAt10)}</td>
        <td>${a.meanLatencyMs.toFixed(0)}ms</td>
        <td>${run.results.length}</td>
      </tr>`;
    })
    .join("\n");

  return `<div class="table-wrap">
    <table>
      <thead><tr>
        <th>Run ID</th><th>Time</th><th>Recall@10</th><th>NDCG@10</th><th>MRR@10</th><th>Latency</th><th>Queries</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderTrends(runs: EvalRunResult[]): string {
  if (runs.length < 2) return emptyState("Need at least 2 runs to show trends");

  const sorted = [...runs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const latest = sorted[sorted.length - 1]!;
  const previous = sorted[sorted.length - 2]!;

  const delta = (curr: number, prev: number): string => {
    const diff = curr - prev;
    if (Math.abs(diff) < 0.001) return `<span style="color:var(--text-muted)">~0</span>`;
    const sign = diff > 0 ? "+" : "";
    const color = diff > 0 ? "var(--success)" : "var(--error)";
    return `<span style="color:${color}">${sign}${(diff * 100).toFixed(1)}pp</span>`;
  };

  return `<div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Recall@10 trend</div>
      <div class="stat-value">${delta(latest.aggregate.meanRecallAt10, previous.aggregate.meanRecallAt10)}</div>
      <div class="stat-sub">${(previous.aggregate.meanRecallAt10 * 100).toFixed(1)}% &rarr; ${(latest.aggregate.meanRecallAt10 * 100).toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">NDCG@10 trend</div>
      <div class="stat-value">${delta(latest.aggregate.meanNdcgAt10, previous.aggregate.meanNdcgAt10)}</div>
      <div class="stat-sub">${(previous.aggregate.meanNdcgAt10 * 100).toFixed(1)}% &rarr; ${(latest.aggregate.meanNdcgAt10 * 100).toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">MRR@10 trend</div>
      <div class="stat-value">${delta(latest.aggregate.meanMrrAt10, previous.aggregate.meanMrrAt10)}</div>
      <div class="stat-sub">${(previous.aggregate.meanMrrAt10 * 100).toFixed(1)}% &rarr; ${(latest.aggregate.meanMrrAt10 * 100).toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Latency trend</div>
      <div class="stat-value">${delta(-latest.aggregate.meanLatencyMs / 1000, -previous.aggregate.meanLatencyMs / 1000)}</div>
      <div class="stat-sub">${previous.aggregate.meanLatencyMs.toFixed(0)}ms &rarr; ${latest.aggregate.meanLatencyMs.toFixed(0)}ms</div>
    </div>
  </div>`;
}

export function registerEvalRoutes(config?: Partial<EvalDashboardConfig>) {
  const runsDir = config?.runsDir ?? DEFAULT_RUNS_DIR;

  return async (c: Context) => {
    try {
      const runs = loadEvalRuns(runsDir);
      const latest = runs[0];

      let content: string;
      if (!latest) {
        content = `
          <div class="card" style="padding:24px">
            ${emptyState("No eval runs found. Run the eval suite first: bun run eval")}
          </div>
        `;
      } else {
        content = `
          <div class="card" style="padding:16px;margin-bottom:16px">
            <h3 style="margin:0 0 12px 0">Latest Search Quality</h3>
            ${renderLatestMetrics(latest)}
          </div>

          <div class="card" style="padding:16px;margin-bottom:16px">
            <h3 style="margin:0 0 12px 0">Improvement Trends</h3>
            ${renderTrends(runs)}
          </div>

          <div class="card" style="padding:16px;margin-bottom:16px">
            <h3 style="margin:0 0 12px 0">Per-Query-Type Breakdown</h3>
            ${renderQueryTypeBreakdown(latest.results)}
          </div>

          <div class="card" style="padding:16px">
            <h3 style="margin:0 0 12px 0">Run History</h3>
            ${renderRunHistory(runs)}
          </div>
        `;
      }

      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Eval Dashboard",
        content,
        activeRoute: "eval",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Eval page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Eval Dashboard",
        content: `<div class="card" style="padding:24px;color:var(--error)">Eval error: ${escapeHtml(errMsg)}</div>`,
        activeRoute: "eval",
        nonce,
        csrfToken,
      }));
    }
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
