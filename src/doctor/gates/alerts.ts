/**
 * Alert integrity gate (1): dedup-db-writable.
 *
 * Ensures ~/.ping-mem/alerts.db exists, has the required schema, and is writable.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { DoctorGate } from "../gates.js";
import { openAlertsDb, ALERTS_SCHEMA_SQL } from "../alerts.js";

export const alertGates: DoctorGate[] = [
  {
    id: "alerts.dedup-db-writable",
    group: "alerts",
    description: "~/.ping-mem/alerts.db exists and is writable with the dedup schema",
    async run(ctx) {
      const dbPath = path.join(ctx.pingMemDir, "alerts.db");
      try {
        fs.mkdirSync(ctx.pingMemDir, { recursive: true });
        const db = openAlertsDb(dbPath);
        db.exec(ALERTS_SCHEMA_SQL);
        const insertStmt = db.prepare(
          "INSERT OR REPLACE INTO alerts(gate_id,last_fired_at,last_resolved_at,severity,fire_count) VALUES(?,?,?,?,?)",
        );
        insertStmt.run("__probe__", Date.now(), null, "info", 0);
        const readStmt = db.prepare("SELECT gate_id FROM alerts WHERE gate_id=?");
        const row = readStmt.get("__probe__");
        if (!row) return { status: "fail", detail: "dedup round-trip read returned no row" };
        const deleteStmt = db.prepare("DELETE FROM alerts WHERE gate_id=?");
        deleteStmt.run("__probe__");
        return { status: "pass", detail: `${dbPath} writable` };
      } catch (err) {
        return { status: "fail", detail: (err as Error).message };
      }
    },
  },
];
