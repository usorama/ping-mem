/**
 * Doctor alert deduplication.
 *
 * Emits `osascript -e 'display notification …'` via execFile (argv vector,
 * no shell) when a gate transitions pass→fail. Suppresses repeats within
 * 60 minutes of last fire for that gate. Backed by ~/.ping-mem/alerts.db.
 */

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GateResult } from "./gates.js";

// Safe: execFile spawns directly with argv vector (no shell interpolation).
const execFileAsync = promisify(execFile);

export const ALERTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS alerts (
  gate_id TEXT PRIMARY KEY,
  last_fired_at INTEGER,
  last_resolved_at INTEGER,
  severity TEXT,
  fire_count INTEGER DEFAULT 0
);
`;

const DEDUP_WINDOW_MS = 60 * 60 * 1000;

export function openAlertsDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(ALERTS_SCHEMA_SQL);
  return db;
}

export interface AlertDispatchResult {
  fired: string[];
  suppressed: string[];
  resolved: string[];
}

/**
 * Inspect doctor results, emit osascript notifications for newly failing
 * gates (with dedup), update the alerts table for transitions.
 */
export async function dispatchAlerts(
  db: Database,
  results: GateResult[],
  opts: { quiet?: boolean } = {},
): Promise<AlertDispatchResult> {
  const now = Date.now();
  const fired: string[] = [];
  const suppressed: string[] = [];
  const resolved: string[] = [];

  const getStmt = db.prepare("SELECT last_fired_at, fire_count FROM alerts WHERE gate_id=?");
  const upsertFire = db.prepare(
    "INSERT INTO alerts(gate_id,last_fired_at,last_resolved_at,severity,fire_count) VALUES(?,?,NULL,?,1)" +
      " ON CONFLICT(gate_id) DO UPDATE SET last_fired_at=excluded.last_fired_at, severity=excluded.severity, fire_count=fire_count+1",
  );
  const markResolved = db.prepare(
    "UPDATE alerts SET last_resolved_at=?, fire_count=0 WHERE gate_id=? AND last_resolved_at IS NULL AND last_fired_at IS NOT NULL",
  );

  for (const r of results) {
    if (r.status === "fail") {
      const row = getStmt.get(r.id) as { last_fired_at?: number } | undefined;
      const lastFiredAt = row?.last_fired_at ?? 0;
      const age = now - lastFiredAt;
      if (age < DEDUP_WINDOW_MS && lastFiredAt > 0) {
        suppressed.push(r.id);
        upsertFire.run([r.id, now, "warn"]);
        continue;
      }
      upsertFire.run([r.id, now, "warn"]);
      if (!opts.quiet) {
        const title = `ping-mem: ${r.id}`.slice(0, 120);
        const body = (r.detail ?? "gate failed").slice(0, 200);
        // AppleScript string escape: backslash + double-quote
        const safeBody = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        try {
          await execFileAsync("osascript", [
            "-e",
            `display notification "${safeBody}" with title "${safeTitle}"`,
          ]);
        } catch {
          /* osascript failure is non-fatal; alert row already persisted */
        }
      }
      fired.push(r.id);
    } else if (r.status === "pass") {
      const changes = markResolved.run([now, r.id]).changes;
      if (changes > 0) resolved.push(r.id);
    }
  }

  return { fired, suppressed, resolved };
}
