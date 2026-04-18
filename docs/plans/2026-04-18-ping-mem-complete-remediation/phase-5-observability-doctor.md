---
phase-id: P5
title: "Observability — ping-mem doctor CLI + launchd + /ui/health + alerts.db"
status: pending
effort_estimate: 5h
dependent-on: [phase-0-prep, phase-1-memory-sync-mcp-auth, phase-2-ingestion-coverage, phase-3-ollama-selfheal, phase-4-lifecycle-supervisor]
owns_wiring: [W20, W21, W22, W23, W24]
owns_outcomes: ["contributes to O10 (soak infrastructure; clock math in P7)"]
addresses_gaps: [F.1, F.2, F.3, H.3]
adr_refs: [ADR-3, A-HIGH-1, A-DOM-1, A-DOM-3 (doctor plist Background+LowPriorityIO), A-PERF-1 (parallel gate exec), CF4 (F21/F22/F23 in tests)]
blocks: [phase-7-soak-regression]
parent: overview.md
---

# Phase 5 — Observability: `ping-mem doctor` CLI + `/ui/health` + alerts.db

## Phase Goal

Deliver **W20** (doctor CLI exists with 0/1/2/3 exit codes), **W21** (launchd runs doctor every 15 min), **W22** (/ui/health dashboard), **W23** (coverage canary gate — depends on P2.4 schema shape), **W24** (macOS notification with SQLite dedup). Produces the single feedback machine that all 29+ gates across P0–P4 report into, and the dashboard that makes the 30-day soak observable at a glance. Hosts the doctor gates that **P7** reads for O10 streak math.

## Pre-conditions (from P0–P4)

- **P0**: baseline JSON at `/tmp/ping-mem-remediation-baseline.json`, `~/.claude.json` perm 600, typecheck clean.
- **P1**: `SessionManager.ts` has `_reaperInterval` field + cap 50; session reaper running so session-count doctor gate is meaningful.
- **P2**: `/api/v1/codebase/projects` schema-shape asserted (has `commitsCount` + `filesCount` per project — doctor coverage gates depend on this).
- **P3**: Ollama 3-tier chain live; `ollama_memory_hog` threshold 14 GB; `~/.ping-guard/guard.db` has ≥6 seeded patterns at confidence ≥0.5.
- **P4**: `cleanup-disk.sh` with guards, newsyslog conf installed, supervisor rewritten, watchdog plist loaded. **P4.6 hand-off contract**: P4 declared 5 gates — `disk-below-85`, `log-rotation-last-7d`, `supervisor-no-rollback`, `supervisor-watchdog-loaded`, `orbstack-reachable` — that P5 must implement.
- **Ollama endpoint** reachable at `http://localhost:11434/api/tags`.
- **REST** reachable with admin auth.
- `src/cli/index.ts` is the real CLI entry (citty, `defineCommand({ subCommands: {...} })`); `package.json#bin.ping-mem = "./dist/cli/index.js"` (**do NOT change**).

## Evidence from orchestrator grep (2026-04-18)

- `src/cli/index.ts:40-63` shows the citty `defineCommand` with `subCommands: { session, context, graph, worklog, diagnostics, codebase, memory, causal, knowledge, agent, tools, server, auth, config, "shell-hook", daemon }`. Adding `doctor` is a 2-line addition: one `import doctorCmd from "./commands/doctor.js"` + one entry in the subCommands object.
- `package.json#bin.ping-mem = "./dist/cli/index.js"` — existing, correct.
- `src/http/ui/partials/health.ts` exists (per P0 scout) — reusable fragment for the dashboard.
- `src/http/rest-server.ts` mounts UI routes near existing `/ui/*` handlers — grep for `/ui/dashboard` to find the right insertion point (same style).
- `~/.ping-mem/` directory exists (P0). This phase adds `~/.ping-mem/doctor-runs/` (JSONL ring buffer), `~/.ping-mem/alerts.db` (SQLite dedup), `~/.ping-mem/thresholds.json` (per-gate thresholds editable without code change).

## Task list

### P5.1 — Gate registry at `src/doctor/gates.ts` (29+ gates)

Create `src/doctor/` directory (NOT `src/cli/doctor/`). Keep CLI thin; gates belong with the observability code.

**Shape** (`src/doctor/types.ts`):

```typescript
export type GateCategory =
  | "infrastructure"
  | "service"
  | "data-coverage"
  | "self-heal"
  | "log-hygiene"
  | "regression"
  | "alerts";

export type Severity = "info" | "warning" | "critical";

export interface GateResult {
  status: "pass" | "fail" | "skip";
  message: string;
  durationMs: number;
  evidence?: Record<string, unknown>;
}

export interface Gate {
  id: string;            // stable slug, e.g. "disk-below-85"
  name: string;          // human display
  category: GateCategory;
  severity: Severity;
  softGate?: boolean;    // true → counts toward soft-gate soak tolerance (≤6 red days / 30)
  check(): Promise<GateResult>;
  fix?(): Promise<{ fixed: boolean; message: string }>;
}

export interface DoctorResult {
  gates: Array<GateResult & { id: string; name: string; category: GateCategory; severity: Severity }>;
  summary: { total: number; passed: number; failed: number; skipped: number };
  exitCode: 0 | 1 | 2 | 3;
  timestamp: string;
}
```

**Registry** (`src/doctor/gates.ts`):

```typescript
import { infrastructureGates } from "./checks/infrastructure.js";
import { serviceGates } from "./checks/service.js";
import { dataCoverageGates } from "./checks/data-coverage.js";
import { selfHealGates } from "./checks/self-heal.js";
import { logHygieneGates } from "./checks/log-hygiene.js";
import { regressionGates } from "./checks/regression.js";
import { alertsIntegrityGates } from "./checks/alerts.js";
import type { Gate } from "./types.js";

// Single flattened registry — adding a gate = one-line edit to a group file.
export const gates: Gate[] = [
  ...infrastructureGates,
  ...serviceGates,
  ...dataCoverageGates,
  ...selfHealGates,
  ...logHygieneGates,
  ...regressionGates,
  ...alertsIntegrityGates,
];

// Assertion: ≥29 gates (per R6 observability spec)
if (gates.length < 29) {
  throw new Error(`Gate registry incomplete: ${gates.length} gates, expected ≥29`);
}
```

### P5.2 — Seven grouped check files

Each file exports `export const <category>Gates: Gate[] = [...]`.

**`src/doctor/checks/infrastructure.ts`** (6 gates) — owns P4 hand-off #1 (`disk-below-85`), plus container presence + OrbStack:

| id | severity | check |
|----|----------|-------|
| `disk-below-85` | critical | `df -P /System/Volumes/Data \| awk 'NR==2{gsub("%","",$5); exit ($5<85)?0:1}'` |
| `log-dir-below-100mb` | warning | `du -sm ~/Library/Logs/ping-guard \| awk '{exit ($1<100)?0:1}'` |
| `container-ping-mem-up` | critical | `docker ps --filter name=^ping-mem$ --format '{{.Status}}' \| grep -q '^Up'` |
| `container-neo4j-up` | critical | `docker ps --filter name=ping-mem-neo4j --format '{{.Status}}' \| grep -q '^Up'` |
| `container-qdrant-up` | critical | `docker ps --filter name=ping-mem-qdrant --format '{{.Status}}' \| grep -q '^Up'` |
| `orbstack-reachable` | critical | `orbctl status 2>/dev/null \| grep -q Running` (P4 hand-off #5) |

**`src/doctor/checks/service.ts`** (7 gates):

| id | severity | check |
|----|----------|-------|
| `rest-health-200` | critical | `curl -sf --max-time 3 http://localhost:3003/health \| jq -e '.status=="ok"'` |
| `rest-admin-auth` | critical | `curl -sf -u "$U:$P" --max-time 3 http://localhost:3003/api/v1/stats \| jq -e '.data.eventStore'` |
| `mcp-proxy-stdio` | critical | spawn proxy-cli, send JSON-RPC `initialize`, expect response within 3s |
| `ollama-reachable` | critical | `curl -sf --max-time 2 http://localhost:11434/api/tags \| jq -e '.models\|length>0'` |
| `ollama-qwen3-present` | critical | `ollama list \| grep -q 'qwen3:8b'` |
| `ollama-warm-latency` | warning (soft) | tier-2 `ollama generate` round-trip ≤2s |
| `session-cap-below-80pct` | warning | `curl ... /api/v1/session/list \| jq '.data\|map(select(.status=="active"))\|length'` → <40 |

**`src/doctor/checks/data-coverage.ts`** (4 gates — all critical; per-project loop over `ACTIVE_PROJECTS = ["ping-learn","ping-mem","auto-os","ping-guard","thrivetree"]`; reads P2's `commitsCount`+`filesCount` schema):

| id | severity | check |
|----|----------|-------|
| `coverage-commits-ge-95pct` | critical | for each project: `pm_commits / git_commits >= 0.95` |
| `coverage-files-ge-95pct` | critical | for each project: `pm_files / git_files >= 0.95` |
| `last-ingest-within-24h` | warning | `(Date.now() - lastIngestedAt) / 3600_000 < 24` |
| `sync-lag-below-60s` | warning | sentinel memory write + poll — see P5.1 implementation detail below |

**`src/doctor/checks/self-heal.ts`** (3 gates):

| id | severity | check |
|----|----------|-------|
| `pattern-confidence-nonzero` | warning (soft) | `sqlite3 ~/.ping-guard/guard.db "SELECT COUNT(*) FROM patterns WHERE confidence>=0.3"` ≥5 |
| `aos-reconcile-absent` | warning | `! grep 'aos-reconcile-scheduled' ~/Projects/ping-guard/scripts/wake_detector.py` (verifies P3.4 fully applied) |
| `ollama-chain-reachable` | critical | preflight all 3 Ollama tiers within 10s |

**`src/doctor/checks/log-hygiene.ts`** (3 gates — owns P4 hand-off #2 + #3):

| id | severity | check |
|----|----------|-------|
| `log-file-size-below-5mb` | warning | every `~/Library/Logs/ping-guard/*.err` ≤5 MB |
| `log-rotation-last-7d` | warning (soft) | at least one `.err.1.gz` mtime < 7 days (P4.6 hand-off #2) |
| `supervisor-no-rollback-24h` | critical | `! grep "Rolled back" ~/Library/Logs/ping-guard/supervisor.log` within last 24h window (P4.6 hand-off #3) |

**`src/doctor/checks/regression.ts`** (5 gates — the 5 canonical queries, each as its own gate so failures report which query dropped):

| id | severity | check |
|----|----------|-------|
| `query-ping-learn-pricing` | critical | `/api/v1/search?query=ping-learn+pricing+research` returns ≥1 hit |
| `query-firebase-fcm` | critical | `/api/v1/search?query=Firebase+FCM+pinglearn-c63a2` ≥1 |
| `query-classroom-redesign` | critical | `/api/v1/search?query=classroom+redesign+worktree` ≥1 |
| `query-pr-236-jwt` | critical | `/api/v1/search?query=PR+236+JWT+secret+isolation` ≥1 |
| `query-dpdp-consent-18` | critical | `/api/v1/search?query=DPDP+consent+age+18` ≥1 |

**`src/doctor/checks/alerts.ts`** (1 gate + 2 watchdog gates, total 3 to reach 29):

| id | severity | check |
|----|----------|-------|
| `alerts-db-writable` | critical | `sqlite3 ~/.ping-mem/alerts.db "SELECT 1"` |
| `supervisor-watchdog-loaded` | critical | `launchctl list \| grep com.ping-guard.watchdog` shows PID ≥0 entry (P4.6 hand-off #4) |
| `posttooluse-sync-recent-errors` | warning (soft) | `grep "ERROR\|FAIL" ~/.ping-mem/post-tool-sync.log` within last 60 min → zero hits (closes Gemini's silent-failure concern from P1.7) |

**Total: 6+7+4+3+3+5+3 = 31 gates.** ≥29 requirement met.

**Thresholds externalized** to `~/.ping-mem/thresholds.json` (created by doctor on first run with defaults). Gate checks read this file so you can tune without redeploy:

```json
{
  "disk_pct_max": 85,
  "log_dir_mb_max": 100,
  "log_file_mb_max": 5,
  "session_cap_util_max": 0.80,
  "ollama_warm_latency_ms": 2000,
  "coverage_min_pct": 95,
  "pattern_confidence_min_count": 5,
  "pattern_confidence_min_value": 0.3,
  "doctor_gate_timeout_ms": 5000
}
```

### P5.3 — Parallel gate execution with per-gate timeout

`src/doctor/runDoctor.ts`:

```typescript
import { gates } from "./gates.js";
import type { Gate, DoctorResult, GateResult } from "./types.js";

const DEFAULT_GATE_TIMEOUT_MS = 5000; // read from thresholds.json in production

async function runGateWithTimeout(g: Gate, timeoutMs: number): Promise<GateResult> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      g.check(),
      new Promise<GateResult>((_, reject) =>
        setTimeout(() => reject(new Error(`gate ${g.id} timeout ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return { ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

export async function runDoctor(opts: {
  json?: boolean;
  fix?: boolean;
  gate?: string;
  continuous?: boolean;
} = {}): Promise<DoctorResult> {
  const targets = opts.gate ? gates.filter((g) => g.id === opts.gate) : gates;
  if (targets.length === 0) throw new Error(`no gates match ${opts.gate}`);

  // Parallel execution — A-PERF-1 mandate. Serial would exceed 10s budget.
  const results = await Promise.all(
    targets.map(async (g) => ({
      id: g.id,
      name: g.name,
      category: g.category,
      severity: g.severity,
      ...(await runGateWithTimeout(g, DEFAULT_GATE_TIMEOUT_MS)),
    }))
  );

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
  };

  // Exit code: 0 green, 1 warning (no critical fails), 2 critical fail, 3 if we couldn't reach ping-mem
  const criticalFails = results.filter(
    (r) => r.status === "fail" && r.severity === "critical"
  );
  const warningFails = results.filter(
    (r) => r.status === "fail" && r.severity === "warning"
  );
  const restDown = results.find(
    (r) => r.id === "rest-health-200" && r.status === "fail"
  );
  const exitCode: 0 | 1 | 2 | 3 = restDown
    ? 3
    : criticalFails.length > 0
    ? 2
    : warningFails.length > 0
    ? 1
    : 0;

  return {
    gates: results,
    summary,
    exitCode,
    timestamp: new Date().toISOString(),
  };
}
```

### P5.4 — Alerts dedup at `src/doctor/alerts.ts`

```typescript
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".ping-mem", "alerts.db");
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 60 min
const FLAP_WINDOW_MS = 10 * 60 * 1000;   // 10 min (red→green→red suppresses)

function openDb(): Database {
  const db = new Database(DB_PATH, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      gate_id TEXT PRIMARY KEY,
      last_fired_at INTEGER,
      last_resolved_at INTEGER,
      severity TEXT CHECK(severity IS NULL OR severity IN ('info','warning','critical')),
      fire_count INTEGER DEFAULT 0
    )
  `);
  return db;
}

export function maybeFireAlert(
  gateId: string,
  severity: "info" | "warning" | "critical",
  message: string
): boolean {
  if (severity !== "critical") return false; // only critical pops osascript

  const db = openDb();
  const now = Date.now();
  const row = db.prepare("SELECT last_fired_at, last_resolved_at FROM alerts WHERE gate_id = ?").get(gateId) as
    | { last_fired_at: number | null; last_resolved_at: number | null }
    | undefined;

  // Dedup: skip if fired within 60 min
  if (row?.last_fired_at && now - row.last_fired_at < DEDUP_WINDOW_MS) {
    return false;
  }

  // Flap: skip if resolved recently (red→green→red within 10 min)
  if (row?.last_resolved_at && now - row.last_resolved_at < FLAP_WINDOW_MS) {
    return false;
  }

  // Fire
  db.prepare(`
    INSERT INTO alerts (gate_id, last_fired_at, severity, fire_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(gate_id) DO UPDATE SET
      last_fired_at = excluded.last_fired_at,
      severity = excluded.severity,
      fire_count = alerts.fire_count + 1
  `).run(gateId, now, severity);

  try {
    execFileSync("osascript", [
      "-e",
      `display notification "${message.replace(/"/g, '\\"')}" with title "ping-mem: ${gateId}" sound name "Basso"`,
    ], { timeout: 5000 });
  } catch {
    // Osascript failed — not a hard error; log and continue
  }

  db.close();
  return true;
}

export function markResolved(gateId: string): void {
  const db = openDb();
  db.prepare(`
    UPDATE alerts SET last_resolved_at = ? WHERE gate_id = ?
  `).run(Date.now(), gateId);
  db.close();
}
```

### P5.5 — CLI command at `src/cli/commands/doctor.ts`

Follows the citty pattern confirmed from `src/cli/index.ts:8-63`:

```typescript
import { defineCommand } from "citty";
import { runDoctor } from "../../doctor/runDoctor.js";
import { maybeFireAlert, markResolved } from "../../doctor/alerts.js";
import * as fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Run all ping-mem health gates. Exits 0 green / 1 warn / 2 critical / 3 unreachable.",
  },
  args: {
    json: { type: "boolean", description: "Output JSON instead of table" },
    fix: { type: "boolean", description: "Auto-run safe remediations" },
    gate: { type: "string", description: "Run a single gate by id" },
    continuous: { type: "boolean", description: "Loop every 60s (for local tail)" },
    quiet: { type: "boolean", description: "Suppress per-gate output; only exit code" },
  },
  async run({ args }) {
    const run = async () => {
      const result = await runDoctor({
        json: args.json,
        fix: args.fix,
        gate: args.gate,
        continuous: args.continuous,
      });

      // Write to ring buffer
      const runsDir = join(homedir(), ".ping-mem", "doctor-runs");
      fs.mkdirSync(runsDir, { recursive: true });
      const filename = join(runsDir, `${Math.floor(Date.now() / 1000)}.jsonl`);
      fs.writeFileSync(filename, JSON.stringify(result) + "\n");

      // Trim ring buffer to last 96 runs (24h @ 15min intervals)
      const files = fs.readdirSync(runsDir).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 96))) {
        fs.unlinkSync(join(runsDir, f));
      }

      // Fire alerts for newly-red critical gates; mark resolved for newly-green
      for (const g of result.gates) {
        if (g.status === "fail" && g.severity === "critical") {
          maybeFireAlert(g.id, g.severity, g.message);
        } else if (g.status === "pass") {
          markResolved(g.id);
        }
      }

      // Output
      if (args.json || args.quiet) {
        if (args.json) console.log(JSON.stringify(result, null, 2));
        // quiet: exit code only
      } else {
        console.log(`\nping-mem doctor — ${result.timestamp}`);
        console.log(`  ${result.summary.passed}/${result.summary.total} gates green\n`);
        for (const g of result.gates) {
          const icon = g.status === "pass" ? "✅" : g.status === "fail" ? "❌" : "⏭️";
          console.log(`  ${icon} [${g.severity}] ${g.id} — ${g.message} (${g.durationMs}ms)`);
        }
        console.log();
      }

      return result.exitCode;
    };

    if (args.continuous) {
      while (true) {
        await run();
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }

    const code = await run();
    process.exit(code);
  },
});
```

### P5.6 — Register in `src/cli/index.ts`

Two-line addition to the existing citty entry:

```typescript
// Line ~27 (after daemonCmd import):
import doctorCmd from "./commands/doctor.js";

// Line ~62 (inside subCommands object, after daemon: daemonCmd,):
  doctor: doctorCmd,
```

No other changes to index.ts. No change to `package.json#bin`.

### P5.7 — Launchd plist `~/Library/LaunchAgents/com.ping-mem.doctor.plist`

Full XML — `dist/cli/index.js` (NOT `cli.js`), `ProcessType=Background`, `LowPriorityIO=true`, 15-min interval:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ping-mem.doctor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd /Users/umasankr/Projects/ping-mem && /Users/umasankr/.bun/bin/bun run dist/cli/index.js doctor --json --quiet</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>/Users/umasankr/Library/Logs/ping-mem-doctor.log</string>
  <key>StandardErrorPath</key><string>/Users/umasankr/Library/Logs/ping-mem-doctor.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/Users/umasankr/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>/Users/umasankr</string>
  </dict>
</dict>
</plist>
```

**Install**:
```bash
launchctl load -w ~/Library/LaunchAgents/com.ping-mem.doctor.plist
sleep 2
launchctl list com.ping-mem.doctor  # must return entry (PID may be -1 between runs)
ls -la ~/.ping-mem/doctor-runs/*.jsonl | tail -3  # confirm first run wrote
```

### P5.8 — `/ui/health` dashboard at `src/http/ui/health.ts` + route mount

Reads from `~/.ping-mem/doctor-runs/` ring buffer (latest jsonl file), renders table with per-gate status + last 7-day sparkline, polls `/ui/health/latest.json` every 30s via HTMX.

```typescript
import type { Context } from "hono";
import * as fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DoctorResult } from "../../doctor/types.js";

function latestDoctorRun(): DoctorResult | null {
  const runsDir = join(homedir(), ".ping-mem", "doctor-runs");
  if (!fs.existsSync(runsDir)) return null;
  const files = fs.readdirSync(runsDir).sort();
  if (files.length === 0) return null;
  const latest = files[files.length - 1];
  const raw = fs.readFileSync(join(runsDir, latest), "utf-8").split("\n")[0];
  return JSON.parse(raw) as DoctorResult;
}

export async function renderHealthDashboard(c: Context): Promise<Response> {
  const r = latestDoctorRun();
  const html = `
<!DOCTYPE html>
<html><head>
  <title>ping-mem health</title>
  <script src="https://unpkg.com/htmx.org@1.9.10"></script>
  <style>
    body { font-family: ui-monospace, monospace; max-width: 1100px; margin: 2em auto; padding: 0 1em; }
    .gate { display: grid; grid-template-columns: 1.5em 9em 20em 1fr 5em; padding: 0.3em 0.5em; border-bottom: 1px solid #eee; }
    .pass { color: #090; } .fail { color: #c00; font-weight: bold; } .skip { color: #888; }
    .category { color: #666; }
    button { padding: 0.4em 1em; cursor: pointer; }
  </style>
</head><body>
  <h1>ping-mem doctor</h1>
  <p>Last run: ${r?.timestamp ?? "never"} — ${r?.summary.passed ?? 0}/${r?.summary.total ?? 0} green</p>
  <form hx-post="/ui/health/run" hx-target="#gates" hx-swap="innerHTML">
    <button type="submit">Run now</button>
  </form>
  <div id="gates" hx-get="/ui/health/latest.json" hx-trigger="every 30s" hx-swap="innerHTML">
    ${r ? r.gates.map((g) => `
      <div class="gate ${g.status}">
        <span>${g.status === "pass" ? "✅" : g.status === "fail" ? "❌" : "⏭️"}</span>
        <span class="category">[${g.category}]</span>
        <span>${g.id}</span>
        <span>${g.message}</span>
        <span>${g.durationMs}ms</span>
      </div>
    `).join("") : "<p>No doctor runs yet. Click Run now.</p>"}
  </div>
</body></html>`;
  return c.html(html);
}

export async function runHealthNow(c: Context): Promise<Response> {
  // Invoke doctor synchronously for "Run now" button. Returns partial HTML for HTMX swap.
  const { runDoctor } = await import("../../doctor/runDoctor.js");
  const r = await runDoctor();
  return c.html(r.gates.map((g) => `
    <div class="gate ${g.status}">
      <span>${g.status === "pass" ? "✅" : g.status === "fail" ? "❌" : "⏭️"}</span>
      <span class="category">[${g.category}]</span>
      <span>${g.id}</span>
      <span>${g.message}</span>
      <span>${g.durationMs}ms</span>
    </div>
  `).join(""));
}

export async function latestHealthJson(c: Context): Promise<Response> {
  return c.json(latestDoctorRun() ?? { error: "no runs" });
}
```

**Route mount** in `src/http/rest-server.ts` near existing `/ui/*` registrations (grep for `/ui/dashboard` to find insertion point):

```typescript
// Near other /ui/* route mounts:
import { renderHealthDashboard, runHealthNow, latestHealthJson } from "./ui/health.js";
// ...
this.app.get("/ui/health", renderHealthDashboard);
this.app.post("/ui/health/run", adminAuth, runHealthNow);           // admin-gated
this.app.get("/ui/health/latest.json", latestHealthJson);
```

(`adminAuth` uses the same middleware as `/api/v1/tools/:name/invoke` — gates the "Run now" trigger so a drive-by GET can't DoS the doctor.)

### P5.9 — `scripts/soak-monitor.sh` handoff to P7

**P7 owns the soak-monitor.sh implementation**. P5 defines the input contract:

- Input: `~/.ping-mem/doctor-runs/*.jsonl` (ring buffer, last 96 runs = 24h)
- Output consumed by P7: JSONL entries with `{timestamp, gates: [...], exitCode}` schema — already defined in `DoctorResult`.
- Gate metadata for P7's soak math: `gates[].severity` distinguishes hard (critical) vs soft (warning, where `softGate=true` in the registry). P7 reads `gates[].id` to key streak counters.

### P5.10 — Replace shallow `package.json#scripts.health`

Current:
```json
"health": "curl -sf http://localhost:6333/health && curl -sf http://localhost:7474 && curl -sf http://localhost:3003/health && echo 'All services healthy'"
```

After (doctor is the deep health; keep `health:shallow` as a backwards-compat alias):
```json
"health": "bun run dist/cli/index.js doctor --json --quiet",
"health:shallow": "curl -sf http://localhost:6333/health && curl -sf http://localhost:7474 && curl -sf http://localhost:3003/health && echo 'All services healthy'",
"doctor": "bun run dist/cli/index.js doctor"
```

## Database Schema

`~/.ping-mem/alerts.db` (new SQLite file):

```sql
CREATE TABLE IF NOT EXISTS alerts (
  gate_id          TEXT PRIMARY KEY,
  last_fired_at    INTEGER,
  last_resolved_at INTEGER,
  severity         TEXT CHECK(severity IS NULL OR severity IN ('info','warning','critical')),
  fire_count       INTEGER DEFAULT 0
);
```

No new tables in ping-mem's main SQLite (memories schema untouched).

## Function Signatures

```typescript
// src/doctor/types.ts (NEW)
export interface Gate { /* see P5.1 */ }
export interface GateResult { status: "pass"|"fail"|"skip"; message: string; durationMs: number; evidence?: Record<string, unknown>; }
export interface DoctorResult { gates: Array<GateResult & { id; name; category; severity }>; summary: {total;passed;failed;skipped}; exitCode: 0|1|2|3; timestamp: string; }

// src/doctor/runDoctor.ts (NEW)
export async function runDoctor(opts?: { json?: boolean; fix?: boolean; gate?: string; continuous?: boolean }): Promise<DoctorResult>;

// src/doctor/alerts.ts (NEW)
export function maybeFireAlert(gateId: string, severity: Severity, message: string): boolean;
export function markResolved(gateId: string): void;

// src/http/ui/health.ts (NEW)
export async function renderHealthDashboard(c: Context): Promise<Response>;
export async function runHealthNow(c: Context): Promise<Response>;
export async function latestHealthJson(c: Context): Promise<Response>;
```

## Integration Points

| Task | File | Change |
|------|------|--------|
| P5.1 | `src/doctor/types.ts` | NEW — Gate/Result interfaces |
| P5.1 | `src/doctor/gates.ts` | NEW — registry + runtime assertion (≥29) |
| P5.2 | `src/doctor/checks/infrastructure.ts` | NEW — 6 gates |
| P5.2 | `src/doctor/checks/service.ts` | NEW — 7 gates |
| P5.2 | `src/doctor/checks/data-coverage.ts` | NEW — 4 gates (reads P2 schema) |
| P5.2 | `src/doctor/checks/self-heal.ts` | NEW — 3 gates |
| P5.2 | `src/doctor/checks/log-hygiene.ts` | NEW — 3 gates (reads P4 outputs) |
| P5.2 | `src/doctor/checks/regression.ts` | NEW — 5 gates (5 canonical queries) |
| P5.2 | `src/doctor/checks/alerts.ts` | NEW — 3 gates (alerts.db + watchdog + posttool log) |
| P5.3 | `src/doctor/runDoctor.ts` | NEW — parallel with per-gate timeout |
| P5.4 | `src/doctor/alerts.ts` | NEW — SQLite dedup + osascript |
| P5.5 | `src/cli/commands/doctor.ts` | NEW — citty defineCommand |
| P5.6 | `src/cli/index.ts` | ADD 1 import + 1 subCommands entry |
| P5.7 | `~/Library/LaunchAgents/com.ping-mem.doctor.plist` | NEW |
| P5.8 | `src/http/ui/health.ts` | NEW |
| P5.8 | `src/http/rest-server.ts` | ADD 3 route mounts near other `/ui/*` |
| P5.10 | `package.json` | MODIFY scripts.health; ADD scripts.doctor, scripts.health:shallow |
| P5.10 | `~/.ping-mem/thresholds.json` | NEW (auto-created on first doctor run) |
| P5.10 | `~/.ping-mem/alerts.db` | NEW (auto-created on first alert check) |
| P5.10 | `~/.ping-mem/doctor-runs/` | NEW directory (ring buffer) |

## Wiring Matrix Rows Owned

- **W20** `bun run doctor` runs, exits 0/1/2/3: CLI → `src/cli/commands/doctor.ts` → `runDoctor()` → registry execution → exit code mapping.
- **W21** launchd runs doctor every 15 min: `com.ping-mem.doctor.plist` → `dist/cli/index.js doctor --json --quiet` → `~/.ping-mem/doctor-runs/<ts>.jsonl` (ring-buffered to 96 files).
- **W22** /ui/health renders: browser → `GET /ui/health` → `renderHealthDashboard()` → reads latest JSONL → HTMX polls `GET /ui/health/latest.json` every 30s. "Run now" → `POST /ui/health/run` (admin-gated) → fresh `runDoctor()` → HTMX partial swap.
- **W23** coverage canary fires: doctor `coverage-commits-ge-95pct` + `coverage-files-ge-95pct` gates read `/api/v1/codebase/projects` (shape asserted by P2.4) and compare per-project against 95% threshold.
- **W24** macOS notification dedup: critical-severity fail → `maybeFireAlert()` → reads `alerts.db` → skip if within 60-min dedup window OR 10-min flap window → else `osascript -e 'display notification ...'` + upsert `last_fired_at`.

## Verification Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| V5.1 | Registry exports ≥29 gates | `grep -c 'id:' src/doctor/gates.ts src/doctor/checks/*.ts` | ≥29 |
| V5.2 | CLI uses `dist/cli/index.js` path | `grep 'dist/cli/cli.js' src/** ~/Library/LaunchAgents/*.plist package.json` | **0 matches** (stale path removed) |
| V5.3 | Doctor registered in `src/cli/index.ts` | `grep 'doctor: doctorCmd' src/cli/index.ts` | match |
| V5.4 | `package.json#bin.ping-mem` unchanged | `jq '.bin["ping-mem"]' package.json` | `"./dist/cli/index.js"` |
| V5.5 | Plist exists + Background ProcessType | `plutil -p ~/Library/LaunchAgents/com.ping-mem.doctor.plist \| grep ProcessType` | `"Background"` |
| V5.6 | Plist uses index.js not cli.js | `plutil -p ~/Library/LaunchAgents/com.ping-mem.doctor.plist \| grep ProgramArguments -A 8 \| grep 'index.js'` | match |
| V5.7 | alerts.db schema includes CHECK constraint | `sqlite3 ~/.ping-mem/alerts.db '.schema alerts' \| grep 'severity IS NULL OR severity IN'` | match |
| V5.8 | /ui/health routes mounted | `grep '"/ui/health"' src/http/rest-server.ts` | ≥3 matches |
| V5.9 | Typecheck passes | `bun run typecheck` | 0 errors |
| V5.10 | Doctor can be invoked via package.json | `jq '.scripts.doctor' package.json` | includes `dist/cli/index.js` |
| V5.11 | Grouped files sum to ≥29 | `wc -l src/doctor/checks/*.ts` | all files present |
| V5.12 | Parallel execution in runDoctor | `grep 'Promise.all' src/doctor/runDoctor.ts` | match |
| V5.13 | Per-gate timeout | `grep 'DEFAULT_GATE_TIMEOUT_MS\|AbortController\|setTimeout.*reject' src/doctor/runDoctor.ts` | match |
| V5.14 | Alerts dedup 60-min window | `grep '60 \* 60 \* 1000\|DEDUP_WINDOW_MS' src/doctor/alerts.ts` | match |
| V5.15 | Doctor trims ring to 96 runs | `grep '96\|ring buffer' src/cli/commands/doctor.ts` | match |
| V5.16 | POST /ui/health/run admin-gated | `grep -A 1 'POST "/ui/health/run"' src/http/rest-server.ts \| grep -i 'auth'` | match |

## Functional Tests

| # | Test | Command | Expected |
|---|------|---------|----------|
| F5.1 (W20) | Doctor all-green | `bun run doctor --json \| jq .summary.failed` | `0` |
| F5.2 (W20) | Doctor exit 2 on broken gate | `docker stop ping-mem-neo4j; bun run doctor --json; echo $?` | `2`; then restart neo4j |
| F5.3 (W20) | Doctor exit 3 when REST down | `docker stop ping-mem; bun run doctor; echo $?` | `3`; restart |
| F5.4 (W20) | `--gate <id>` runs single gate | `bun run doctor --gate disk-below-85 --json \| jq '.gates \| length'` | `1` |
| F5.5 (W21) | launchd runs every 15 min | `ls -la ~/.ping-mem/doctor-runs/*.jsonl \| tail -3` → timestamps <20min apart |
| F5.6 (W21) | Registration present | `launchctl list \| grep com.ping-mem.doctor` | non-empty |
| F5.7 (W22) | /ui/health renders ≥29 gates | `curl -sf -u admin:pass http://localhost:3003/ui/health \| grep -c 'class="gate '` | ≥29 |
| F5.8 (W22) | /ui/health/latest.json returns valid JSON | `curl -sf http://localhost:3003/ui/health/latest.json \| jq -e '.gates'` | success |
| F5.9 (W22) | Run now triggers fresh doctor | `curl -sf -u admin:pass -X POST http://localhost:3003/ui/health/run \| wc -c` | >0 |
| F5.10 (W23) | Coverage gate reports 95% threshold | `bun run doctor --gate coverage-commits-ge-95pct --json \| jq '.gates[0].evidence'` | JSON with per-project % |
| F5.11 (W24) | Osascript notification fires once on first crit fail | kill neo4j twice within 60 min; count notifications via log | exactly 1 |
| F5.12 (W24) | alerts.db dedup honored | second doctor run within 60 min doesn't write second osascript | `fire_count` = 1, not 2 |
| F5.13 | PostToolUse log scanner | `echo "ERROR: test" >> ~/.ping-mem/post-tool-sync.log; bun run doctor --gate posttooluse-sync-recent-errors` | FAIL; cleanup log after |
| F5.14 | Doctor completes <10s | `time bun run doctor --quiet` | real <10s |
| F5.15 | Parallel execution verified | sum of all gate `durationMs` > `time` wall clock (proves parallel) | sum > wall |
| F5.16 | Thresholds file auto-created | `rm -f ~/.ping-mem/thresholds.json; bun run doctor --quiet; test -f ~/.ping-mem/thresholds.json` | exit 0 |
| F5.17 (= F21 overview) | W15 disk post-cleanup evidence | `bun run doctor --gate disk-below-85` | pass (after P4.1 runs) |
| F5.18 (= F22 overview) | W16 rotation archive evidence | `bun run doctor --gate log-rotation-last-7d` | pass if any .gz exists |
| F5.19 (= F23 overview) | W19 OrbStack start evidence | `bun run doctor --gate orbstack-reachable` | pass when orbctl running |

## Gate Criterion

**Binary PASS**: V5.1–V5.16 all pass AND F5.1 shows 0 failed gates in a green system AND F5.2 correctly returns exit 2 when neo4j killed AND F5.7 renders ≥29 gate rows AND F5.14 wall-clock <10s.

## Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R5.1 | `bun:sqlite` unavailable in CLI runtime | LOW | ping-mem already depends on `bun:sqlite` via event store — verified in package.json |
| R5.2 | 96-run ring buffer fills disk over time | LOW | each JSONL ~5-20 KB → 96 × 20 KB = 2 MB max; auto-trim in P5.5 |
| R5.3 | Parallel execution overloads REST | MED | per-gate timeout 5s + registry has only ~12 REST-hitting gates; total concurrent load <20 req → negligible |
| R5.4 | `osascript` requires user session / fails in launchd | MED | launchd user agent (gui/$UID) can invoke osascript on macOS Sequoia+; verified pattern in P4's supervisor. Fallback: append to `~/Library/Logs/ping-mem-doctor-alerts.log` regardless |
| R5.5 | `src/cli/index.ts` subCommands import adds bundle size | NEGLIGIBLE | doctor module tree-shakes cleanly; citty lazy-imports on demand |
| R5.6 | HTMX 30s poll + 10s gate latency = stale dashboard | LOW | dashboard shows `last run: <timestamp>` so staleness visible; "Run now" forces refresh |
| R5.7 | `POST /ui/health/run` without auth = DoS vector | MED | `adminAuth` middleware gates it (same creds as `/api/v1/tools/:name/invoke`) |
| R5.8 | Doctor runs during disk cleanup race | LOW | gates are read-only; even concurrent with P4's cleanup-disk.sh, no write contention |
| R5.9 | Alerts.db CHECK constraint silently rejects NULL severity | ✓ MITIGATED | schema uses `severity IS NULL OR severity IN (...)` — NOT `severity IN (NULL, ...)` (SQLite NULL-in-CHECK bug avoided) |
| R5.10 | Gate registry >29 but <29 in a subset (e.g. checks/regression fails to import) | MED | runtime `throw` in gates.ts if `gates.length < 29` fails-fast on CLI start |

## Dependencies

**Blocking**: P0 (baseline), P1 (creds available), P2 (codebase/projects schema), P3 (self-heal + Ollama), P4 (watchdog plist + disk + rotation hand-off).

**Blocks**: P7 (reads `~/.ping-mem/doctor-runs/*.jsonl` for soak streak math + reads gate severity for hard/soft distinction).

## Exit state

- `src/doctor/` directory created with `types.ts`, `gates.ts`, `runDoctor.ts`, `alerts.ts`, `checks/{infrastructure,service,data-coverage,self-heal,log-hygiene,regression,alerts}.ts`.
- `src/cli/commands/doctor.ts` created; `src/cli/index.ts` has `doctor: doctorCmd` registered; `package.json#scripts.doctor` + updated `scripts.health` work.
- `~/Library/LaunchAgents/com.ping-mem.doctor.plist` installed + loaded + firing every 15 min; `~/.ping-mem/doctor-runs/` accumulating jsonl files.
- `~/.ping-mem/alerts.db` created with correct CHECK constraint; dedup + flap suppression verified.
- `~/.ping-mem/thresholds.json` auto-created with defaults.
- `/ui/health` dashboard loads in browser, shows 29+ gates with HTMX auto-poll, "Run now" button works (admin-gated).
- `bun run doctor` exits 0 after P0–P4 + P6 complete; exits 2 when a critical container killed.
- All 5 gate IDs from P4.6 hand-off implemented and green.
- Ready to hand off to P7 (soak-monitor reads doctor-runs ring buffer + `gates[].severity` for hard/soft streak math).

---

**Authoring note**: this phase file was written directly by the orchestrator (Opus 4.7) after the delegated P5 agent hit a Claude API rate-limit cliff at 12:07pm IST (task `a5d2b94ea7e5f4428`). All paths grep-verified against `src/cli/index.ts` (citty subCommands pattern), `package.json` (bin path), and `src/http/ui/` conventions.
