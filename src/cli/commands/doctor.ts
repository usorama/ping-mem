/**
 * `ping-mem doctor` — observability CLI for the 29-gate health board.
 *
 * Runs all gates in parallel with per-gate timeouts, persists a JSONL
 * run file to ~/.ping-mem/doctor-runs/, emits dedup'd macOS notifications
 * on pass→fail transitions, and exits non-zero on any failure.
 */

import { defineCommand } from "citty";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadAllGates, type DoctorGate, type GateContext, type GateResult } from "../../doctor/gates.js";
import { dispatchAlerts, openAlertsDb } from "../../doctor/alerts.js";

const TOTAL_BUDGET_MS = 15_000;
const PER_GATE_TIMEOUT_MS = 7_000;
const RUN_RING_BUFFER_SIZE = 96; // 24h at 15-min cadence

interface DoctorRunRecord {
  runId: string;
  startedAt: string;
  durationMs: number;
  results: GateResult[];
  summary: { total: number; pass: number; fail: number; skip: number; exitCode: number };
}

async function runGate(gate: DoctorGate, ctx: GateContext): Promise<GateResult> {
  const started = Date.now();
  try {
    const timed = await Promise.race([
      gate.run(ctx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("gate timeout")), ctx.perGateTimeoutMs),
      ),
    ]);
    return {
      id: gate.id,
      group: gate.group,
      status: timed.status,
      durationMs: Date.now() - started,
      ...(timed.detail !== undefined ? { detail: timed.detail } : {}),
      ...(timed.metrics !== undefined ? { metrics: timed.metrics } : {}),
    };
  } catch (err) {
    return {
      id: gate.id,
      group: gate.group,
      status: "fail",
      durationMs: Date.now() - started,
      detail: `error: ${(err as Error).message}`,
    };
  }
}

export async function runDoctor(opts: {
  json?: boolean;
  gate?: string;
  continuous?: boolean;
  quiet?: boolean;
  fix?: boolean;
}): Promise<DoctorRunRecord> {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const pingMemDir = path.join(os.homedir(), ".ping-mem");
  fs.mkdirSync(pingMemDir, { recursive: true });
  fs.mkdirSync(path.join(pingMemDir, "doctor-runs"), { recursive: true });

  const restUrl = process.env.PING_MEM_REST_URL ?? "http://localhost:3003";
  const ctx: GateContext = {
    pingMemDir,
    restUrl,
    adminUser: process.env.PING_MEM_ADMIN_USER ?? "admin",
    adminPass: process.env.PING_MEM_ADMIN_PASS ?? undefined,
    perGateTimeoutMs: PER_GATE_TIMEOUT_MS,
  };
  // When caller runs the doctor via `bun run doctor` without an explicit
  // env, fall back to the documented dev-local admin creds so data/regression
  // gates don't skip.
  if (!ctx.adminPass) ctx.adminPass = process.env.PING_MEM_ADMIN_PASS_FALLBACK ?? "ping-mem-dev-local";

  let gates: DoctorGate[] = await loadAllGates();
  if (opts.gate) {
    const filter = opts.gate;
    gates = gates.filter((g) => g.id === filter || g.group === filter);
    if (gates.length === 0) {
      throw new Error(`No gates match filter "${filter}"`);
    }
  }

  // Global budget wrapper: if gates individually exceed 10s, the outer
  // race still kills them.
  const runsP = Promise.all(gates.map((g) => runGate(g, ctx)));
  const timeoutP = new Promise<GateResult[]>((resolve) =>
    setTimeout(() => {
      resolve(
        gates.map((g) => ({
          id: g.id,
          group: g.group,
          status: "fail" as const,
          durationMs: TOTAL_BUDGET_MS,
          detail: "total doctor budget exceeded",
        })),
      );
    }, TOTAL_BUDGET_MS + 500),
  );
  const results = await Promise.race([runsP, timeoutP]);

  // Alerts: dedup + notification
  const alertsDbPath = path.join(pingMemDir, "alerts.db");
  try {
    const db = openAlertsDb(alertsDbPath);
    await dispatchAlerts(db, results, { quiet: opts.quiet === true });
    db.close();
  } catch (err) {
    if (!opts.quiet) {
      console.error(`[doctor] alerts dispatch error: ${(err as Error).message}`);
    }
  }

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
    exitCode: 0,
  };
  // Exit codes: 0 = all pass (skip allowed), 2 = any fail. Reserve 1 for runtime errors.
  summary.exitCode = summary.fail > 0 ? 2 : 0;

  const record: DoctorRunRecord = {
    runId,
    startedAt,
    durationMs: Date.now() - started,
    results,
    summary,
  };

  // Persist to ring-buffer directory (one JSONL file per run).
  const runsDir = path.join(pingMemDir, "doctor-runs");
  const runFile = path.join(runsDir, `${runId}.jsonl`);
  fs.writeFileSync(runFile, JSON.stringify(record) + "\n");

  // Trim ring buffer
  try {
    const existing = fs
      .readdirSync(runsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(runsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = RUN_RING_BUFFER_SIZE; i < existing.length; i++) {
      const entry = existing[i];
      if (!entry) continue;
      try { fs.unlinkSync(path.join(runsDir, entry.f)); } catch { /* ignore */ }
    }
  } catch {
    /* non-fatal */
  }

  return record;
}

function printHuman(record: DoctorRunRecord): void {
  const { results, summary, durationMs } = record;
  const grouped = new Map<string, GateResult[]>();
  for (const r of results) {
    const list = grouped.get(r.group) ?? [];
    list.push(r);
    grouped.set(r.group, list);
  }
  for (const [group, list] of grouped) {
    console.log(`\n== ${group} ==`);
    for (const r of list) {
      const marker = r.status === "pass" ? "[OK]   " : r.status === "fail" ? "[FAIL] " : "[SKIP] ";
      const detail = r.detail ? ` — ${r.detail}` : "";
      console.log(`${marker}${r.id} (${r.durationMs}ms)${detail}`);
    }
  }
  console.log(
    `\nSummary: ${summary.pass} pass, ${summary.fail} fail, ${summary.skip} skip, total ${summary.total} (${durationMs}ms)`,
  );
}

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Run the 29-gate ping-mem health board (exit 0 on all-pass, 2 on any fail)",
  },
  args: {
    json: { type: "boolean", description: "Emit JSON", default: false },
    quiet: { type: "boolean", description: "Suppress per-gate output", default: false },
    gate: { type: "string", description: "Filter to a single gate id or group" },
    fix: { type: "boolean", description: "Attempt self-repair (reserved; no-op today)", default: false },
    continuous: { type: "boolean", description: "Loop every 15 min (foreground)", default: false },
  },
  async run({ args }) {
    async function once(): Promise<number> {
      const rec = await runDoctor({
        json: args.json,
        quiet: args.quiet,
        ...(typeof args.gate === "string" ? { gate: args.gate } : {}),
        fix: args.fix,
        continuous: args.continuous,
      });
      if (args.json) {
        console.log(JSON.stringify(rec));
      } else if (!args.quiet) {
        printHuman(rec);
      }
      return rec.summary.exitCode;
    }

    if (args.continuous) {
      const intervalMs = 15 * 60 * 1000;
      // eslint-disable-next-line no-constant-condition -- long-running loop is the contract
      while (true) {
        await once();
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } else {
      const code = await once();
      process.exit(code);
    }
  },
});
