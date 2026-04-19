/**
 * Log-hygiene gates (3):
 *   log-file-size, rotation-recent, supervisor-no-rollback.
 *
 * Log files kept under size cap, rotation emits archives regularly,
 * supervisor is not silently rolling back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { DoctorGate } from "../gates.js";

const LOG_DIR = path.join(os.homedir(), "Library/Logs/ping-guard");
const LOG_FILE_MAX_MB = 10;
const ROTATION_MAX_AGE_H = 48;
const SUPERVISOR_LOG = path.join(LOG_DIR, "supervisor.log");

function fileMb(p: string): number {
  try {
    return fs.statSync(p).size / 1_048_576;
  } catch {
    return 0;
  }
}

export const logHygieneGates: DoctorGate[] = [
  {
    id: "loghyg.log-file-size",
    group: "loghygiene",
    description: `No single .log or .err file over ${LOG_FILE_MAX_MB} MiB in ping-guard/`,
    async run() {
      if (!fs.existsSync(LOG_DIR)) return { status: "skip", detail: "log dir missing" };
      const rows = fs
        .readdirSync(LOG_DIR)
        .filter((f) => /\.(log|err)$/.test(f))
        .map((f) => ({ name: f, mb: fileMb(path.join(LOG_DIR, f)) }));
      if (rows.length === 0) return { status: "skip", detail: "no .log or .err files" };
      const worst = rows.reduce((a, b) => (a.mb > b.mb ? a : b));
      const pass = worst.mb <= LOG_FILE_MAX_MB;
      return {
        status: pass ? "pass" : "fail",
        detail: `largest=${worst.name} ${worst.mb.toFixed(2)} MiB`,
        metrics: { worstMb: Number(worst.mb.toFixed(2)), capMb: LOG_FILE_MAX_MB },
      };
    },
  },

  {
    id: "loghyg.rotation-recent",
    group: "loghygiene",
    description: `At least one archive (*.gz) written within ${ROTATION_MAX_AGE_H}h`,
    async run() {
      if (!fs.existsSync(LOG_DIR)) return { status: "skip", detail: "log dir missing" };
      const archives = fs
        .readdirSync(LOG_DIR)
        .filter((f) => f.endsWith(".gz"))
        .map((f) => {
          const p = path.join(LOG_DIR, f);
          return { name: f, mtimeMs: fs.statSync(p).mtimeMs };
        });
      if (archives.length === 0) {
        return { status: "fail", detail: "no rotated archives found" };
      }
      const newest = archives.reduce((a, b) => (a.mtimeMs > b.mtimeMs ? a : b));
      const ageH = (Date.now() - newest.mtimeMs) / 3_600_000;
      const pass = ageH <= ROTATION_MAX_AGE_H;
      return {
        status: pass ? "pass" : "fail",
        detail: `newest archive ${newest.name} ${ageH.toFixed(1)}h old`,
        metrics: { ageH: Number(ageH.toFixed(2)), maxH: ROTATION_MAX_AGE_H, archives: archives.length },
      };
    },
  },

  {
    id: "loghyg.supervisor-no-rollback",
    group: "loghygiene",
    description: "supervisor.log shows no ROLLBACK/REVERT in last 24h",
    async run() {
      if (!fs.existsSync(SUPERVISOR_LOG)) {
        return { status: "skip", detail: "supervisor.log absent" };
      }
      const cutoffMs = Date.now() - 24 * 3_600_000;
      // Read tail of file (last ~256KB)
      const stat = fs.statSync(SUPERVISOR_LOG);
      const start = Math.max(0, stat.size - 256 * 1024);
      const fd = fs.openSync(SUPERVISOR_LOG, "r");
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      let hits = 0;
      for (const line of lines) {
        if (!/ROLLBACK|REVERT/i.test(line)) continue;
        // Parse a leading timestamp. ping-guard/supervisor emits both styles:
        //   "2026-04-16 15:30:17 SUPERVISOR: …"  (space separator)
        //   "2026-04-16T15:30:17Z SUPERVISOR: …" (ISO form)
        const match = line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
        if (match && match[1]) {
          // Date.parse needs ISO form — swap a space separator for 'T'.
          const iso = match[1].replace(" ", "T");
          const ts = Date.parse(iso);
          if (Number.isFinite(ts) && ts >= cutoffMs) hits++;
        } else {
          // No timestamp on line — conservatively count it
          hits++;
        }
      }
      const pass = hits === 0;
      return {
        status: pass ? "pass" : "fail",
        detail: `${hits} rollback/revert lines in last 24h`,
        metrics: { hits },
      };
    },
  },
];
