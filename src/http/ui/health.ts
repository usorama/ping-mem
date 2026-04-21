/**
 * /ui/health — doctor dashboard.
 *
 * Reads ~/.ping-mem/doctor-runs/*.jsonl (ring buffer, last 96 = 24h at 15-min),
 * shows per-gate status with a sparkline over the last 7 days. HTMX auto-poll
 * every 60s. "Run now" button triggers a fresh doctor run (basic-auth gated).
 */

import type { Context } from "hono";
import type { AppEnv } from "../rest-server.js";
import * as fs from "node:fs";
import * as os from "node:os";
import { timingSafeStringEqual } from "../../util/auth-utils.js";
import * as path from "node:path";

import { renderLayout, escapeHtml, formatDate, getCspNonce, getCsrfToken, getClientIp } from "./layout.js";
import { statCard, badge } from "./components.js";
import { createLogger } from "../../util/logger.js";
import { runDoctor } from "../../cli/commands/doctor.js";

const log = createLogger("UI:Health");

// In-container, the doctor runs on the HOST (via launchd); its JSONL output lives in
// ~/.ping-mem/doctor-runs/. docker-compose.yml bind-mounts that directory into
// /data/doctor-runs so this UI can read it. Respect PING_MEM_DOCTOR_RUNS_DIR when
// set (container deployment) and fall back to ~/.ping-mem/doctor-runs otherwise.
const RUNS_DIR = process.env.PING_MEM_DOCTOR_RUNS_DIR
  ?? path.join(os.homedir(), ".ping-mem", "doctor-runs");
const MAX_RUNS_LOADED = 96; // 24h at 15-min
const SPARK_WINDOW_RUNS = 96;

interface PersistedRun {
  runId: string;
  startedAt: string;
  durationMs: number;
  results: Array<{
    id: string;
    group: string;
    status: "pass" | "fail" | "skip";
    durationMs: number;
    detail?: string;
    metrics?: Record<string, number | string | boolean>;
  }>;
  summary: { total: number; pass: number; fail: number; skip: number; exitCode: number };
}

function loadRuns(dir: string, limit = MAX_RUNS_LOADED): PersistedRun[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const out: PersistedRun[] = [];
  for (const { f } of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8").trim();
      if (!raw) continue;
      // Each file contains exactly one JSON object (followed by newline)
      const parsed = JSON.parse(raw) as PersistedRun;
      out.push(parsed);
    } catch (err) {
      log.warn("failed to parse doctor run", { file: f, error: (err as Error).message });
    }
  }
  return out;
}

function gateStatusBadge(status: "pass" | "fail" | "skip"): string {
  if (status === "pass") return badge("PASS", "success");
  if (status === "fail") return badge("FAIL", "error");
  return badge("SKIP", "muted");
}

/**
 * Render a very small inline SVG sparkline.
 * dots: 1 = pass, 0 = fail, -1 = skip.
 */
function sparkline(points: Array<"pass" | "fail" | "skip">): string {
  const W = 140;
  const H = 18;
  if (points.length === 0) return `<svg width="${W}" height="${H}" />`;
  const step = W / Math.max(points.length, 1);
  const circles: string[] = [];
  points.forEach((p, i) => {
    const cx = (i + 0.5) * step;
    const cy = H / 2;
    let fill = "#9ca3af";
    if (p === "pass") fill = "#10b981";
    if (p === "fail") fill = "#ef4444";
    circles.push(`<circle cx="${cx.toFixed(1)}" cy="${cy}" r="3" fill="${fill}" />`);
  });
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${circles.join("")}</svg>`;
}

function renderOverview(runs: PersistedRun[]): string {
  const latest = runs[0];
  if (!latest) {
    return `<div class="card" style="padding:24px">No doctor runs yet. Trigger one via "Run now" below.</div>`;
  }
  const totalRuns = runs.length;
  const last7dFails = runs.reduce((n, r) => n + r.summary.fail, 0);
  const last7dPassRate = runs.length === 0
    ? 0
    : runs.reduce((n, r) => n + r.summary.pass, 0) / Math.max(1, runs.reduce((n, r) => n + r.summary.total, 0));
  return `
    <div class="stats-grid">
      ${statCard("Latest", `${latest.summary.pass}/${latest.summary.total} pass`, `exit ${latest.summary.exitCode}`)}
      ${statCard("Last fail", String(latest.summary.fail), latest.summary.fail === 0 ? "all green" : "see below")}
      ${statCard("Runs loaded", String(totalRuns), "last 24h window")}
      ${statCard("Pass rate", `${(last7dPassRate * 100).toFixed(1)}%`, `${last7dFails} fails total`)}
    </div>
    <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">
      Last run: ${escapeHtml(formatDate(latest.startedAt))} (${latest.durationMs}ms) | Run id ${escapeHtml(latest.runId.slice(0, 14))}
    </div>
  `;
}

function renderGateTable(runs: PersistedRun[]): string {
  const latest = runs[0];
  if (!latest) return "";

  // Collect per-gate history for sparkline (most recent first → reverse to chronological)
  const historyByGate = new Map<string, Array<"pass" | "fail" | "skip">>();
  const orderedRuns = [...runs].slice(0, SPARK_WINDOW_RUNS).reverse();
  for (const run of orderedRuns) {
    for (const r of run.results) {
      const arr = historyByGate.get(r.id) ?? [];
      arr.push(r.status);
      historyByGate.set(r.id, arr);
    }
  }

  const byGroup = new Map<string, typeof latest.results>();
  for (const r of latest.results) {
    const list = byGroup.get(r.group) ?? [];
    list.push(r);
    byGroup.set(r.group, list);
  }

  const sections: string[] = [];
  for (const [group, list] of byGroup) {
    const rows = list
      .map((r) => {
        const hist = historyByGate.get(r.id) ?? [];
        return `<tr>
          <td>${escapeHtml(r.id)}</td>
          <td>${gateStatusBadge(r.status)}</td>
          <td>${r.durationMs}ms</td>
          <td style="max-width:420px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.detail ?? "")}</td>
          <td>${sparkline(hist)}</td>
        </tr>`;
      })
      .join("\n");

    sections.push(`
      <div class="card" style="padding:16px;margin-bottom:16px">
        <h3 style="margin:0 0 12px 0;text-transform:capitalize">${escapeHtml(group)}</h3>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Gate</th><th>Status</th><th>Duration</th><th>Detail</th><th>Trend (7d)</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `);
  }
  return sections.join("\n");
}

function renderRunNowButton(csrfToken: string | undefined): string {
  // HTMX POST to /ui/partials/health/run — server triggers doctor, partial re-renders
  const csrf = escapeHtml(csrfToken ?? "");
  return `
    <form class="card" style="padding:16px;margin-bottom:16px"
          hx-post="/ui/partials/health/run"
          hx-target="#health-latest"
          hx-swap="innerHTML"
          hx-headers='{"x-csrf-token":"${csrf}"}'>
      <button type="submit" class="btn">Run doctor now</button>
      <span style="margin-left:12px;font-size:12px;color:var(--text-muted)">
        Triggers a fresh health run and refreshes this page. Basic-Auth required.
      </span>
    </form>
  `;
}

export function registerHealthPage() {
  return async (c: Context<AppEnv>) => {
    try {
      const runs = loadRuns(RUNS_DIR, MAX_RUNS_LOADED);
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      const content = `
        <div class="card" style="padding:16px;margin-bottom:16px">
          <h3 style="margin:0 0 12px 0">Overview</h3>
          <div id="health-latest"
               hx-get="/ui/partials/health/latest"
               hx-trigger="every 60s"
               hx-swap="innerHTML">
            ${renderOverview(runs)}
          </div>
        </div>
        ${renderRunNowButton(csrfToken)}
        <div id="health-gates">
          ${renderGateTable(runs)}
        </div>
      `;
      return c.html(
        renderLayout({
          title: "Doctor Health",
          content,
          activeRoute: "health",
          nonce,
          csrfToken,
        }),
      );
    } catch (err) {
      log.error("health page render failed", { error: (err as Error).message });
      return c.text("health page error", 500);
    }
  };
}

/**
 * Latest partial — used by HTMX auto-poll every 60s.
 */
export function registerHealthLatestPartial() {
  return async (c: Context<AppEnv>) => {
    const runs = loadRuns(RUNS_DIR, MAX_RUNS_LOADED);
    return c.html(renderOverview(runs));
  };
}

/**
 * "Run now" endpoint — requires admin basic auth and triggers a fresh doctor run.
 */
export function registerHealthRunNow() {
  return async (c: Context<AppEnv>) => {
    const adminUser = process.env.PING_MEM_ADMIN_USER;
    const adminPass = process.env.PING_MEM_ADMIN_PASS;
    if (adminUser && adminPass) {
      const authHeader = c.req.header("Authorization") ?? "";
      let ok = false;
      if (authHeader.startsWith("Basic ")) {
        try {
          const decoded = atob(authHeader.slice(6));
          const [user, ...rest] = decoded.split(":");
          const pass = rest.join(":");
          ok = timingSafeStringEqual(user ?? "", adminUser) && timingSafeStringEqual(pass ?? "", adminPass);
        } catch {
          log.warn("health run-now: malformed auth header", { ip: getClientIp(c) });
        }
      }
      if (!ok) {
        c.header("WWW-Authenticate", 'Basic realm="ping-mem UI"');
        log.warn("health run-now: unauthorized", { ip: getClientIp(c) });
        return c.html("Unauthorized", 401);
      }
    }
    try {
      const rec = await runDoctor({ quiet: true });
      const runs = loadRuns(RUNS_DIR, MAX_RUNS_LOADED);
      const banner = `<div style="padding:8px;background:var(--success);color:white;margin-bottom:8px">Fresh run: ${rec.summary.pass}/${rec.summary.total} pass (exit ${rec.summary.exitCode})</div>`;
      return c.html(banner + renderOverview(runs));
    } catch (err) {
      log.error("health run-now failed", { error: (err as Error).message });
      return c.html(`<div style="color:var(--error)">doctor run failed: ${escapeHtml((err as Error).message)}</div>`, 500);
    }
  };
}
