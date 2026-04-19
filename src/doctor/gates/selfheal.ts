/**
 * Self-heal gates (3):
 *   pattern-library-confidence, aos-reconcile-absent, ollama-chain-reachable.
 *
 * Verifies the self-healing chain wiring: ping-guard pattern library quality,
 * auto-os _reconcile_scheduled absence (should have been removed in P4),
 * and Ollama chain reachability for the deep-reasoning fallback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { DoctorGate } from "../gates.js";
import { fetchWithTimeout, runCmd } from "../util.js";

const PATTERN_CONFIDENCE_MIN = 0.3;
const PATTERN_HIGH_CONF_MIN = 5;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

export const selfhealGates: DoctorGate[] = [
  {
    id: "selfheal.pattern-library-confidence",
    group: "selfheal",
    description: `ping-guard pattern library: avg confidence ≥${PATTERN_CONFIDENCE_MIN} and ≥${PATTERN_HIGH_CONF_MIN} patterns ≥0.5`,
    async run() {
      const dbPath = path.join(os.homedir(), ".ping-guard/guard.db");
      if (!fs.existsSync(dbPath)) {
        return { status: "fail", detail: `${dbPath} missing` };
      }
      const query =
        "SELECT IFNULL(AVG(confidence),0), IFNULL(SUM(CASE WHEN confidence>=0.5 THEN 1 ELSE 0 END),0), COUNT(*) FROM patterns;";
      // argv form avoids /bin/sh -c so dbPath is never interpreted as shell.
      const { stdout, stderr, code } = await runCmd("sqlite3", [dbPath, query]);
      if (code !== 0) {
        // Surface stderr so "database is locked" / "unable to open" reaches the operator
        // instead of being hidden behind a bare exit code.
        const trimmed = stderr ? stderr.trim().slice(0, 120) : "";
        return { status: "fail", detail: `sqlite3 exit ${code}${trimmed ? `: ${trimmed}` : ""}` };
      }
      const parts = stdout.trim().split("|");
      const avg = Number.parseFloat(parts[0] ?? "0");
      const highConf = Number.parseInt(parts[1] ?? "0", 10);
      const total = Number.parseInt(parts[2] ?? "0", 10);
      const pass = avg >= PATTERN_CONFIDENCE_MIN && highConf >= PATTERN_HIGH_CONF_MIN;
      return {
        status: pass ? "pass" : "fail",
        detail: `avg=${avg.toFixed(3)} highConf=${highConf} total=${total}`,
        metrics: {
          avg: Number(avg.toFixed(4)),
          highConf,
          total,
          avgFloor: PATTERN_CONFIDENCE_MIN,
          highConfFloor: PATTERN_HIGH_CONF_MIN,
        },
      };
    },
  },

  {
    id: "selfheal.aos-reconcile-absent",
    group: "selfheal",
    description: "auto-os _reconcile_scheduled function has been removed from self_heal.py",
    async run() {
      const target = path.join(os.homedir(), "Projects/auto-os/auto_os/self_heal.py");
      if (!fs.existsSync(target)) {
        return { status: "skip", detail: `${target} missing` };
      }
      const text = fs.readFileSync(target, "utf8");
      const hasReconcile = /def\s+_reconcile_scheduled\s*\(/.test(text);
      return {
        status: hasReconcile ? "fail" : "pass",
        detail: hasReconcile ? "_reconcile_scheduled still present" : "removed as expected",
        metrics: { present: hasReconcile },
      };
    },
  },

  {
    id: "selfheal.ollama-chain-reachable",
    group: "selfheal",
    description: "Ollama chain (tags + qwen3 + llama3.1 fallback) reachable",
    async run() {
      try {
        const { status, body } = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, {}, 2500);
        if (status !== 200) return { status: "fail", detail: `HTTP ${status}` };
        const parsed = JSON.parse(body) as { models?: Array<{ name?: string }> };
        const names = new Set((parsed.models ?? []).map((m) => m.name ?? ""));
        const requiredTier1 = "qwen3:8b";
        const tier2Candidates = ["llama3.1:8b-instruct-q4_0", "llama3.2:latest"];
        const hasTier1 = names.has(requiredTier1);
        const hasTier2 = tier2Candidates.some((m) => names.has(m));
        const pass = hasTier1 && hasTier2;
        return {
          status: pass ? "pass" : "fail",
          detail: `tier1=${hasTier1 ? requiredTier1 : "MISSING"} tier2=${hasTier2 ? "present" : "missing"}`,
          metrics: { hasTier1, hasTier2, modelCount: names.size },
        };
      } catch (err) {
        return { status: "fail", detail: (err as Error).message };
      }
    },
  },
];
