/**
 * Infrastructure gates (6): disk-free, log-dir-size, ping-mem-container,
 * neo4j-container, qdrant-container, orbstack-reachable.
 *
 * These assert the host-level primitives ping-mem depends on.
 */

import type { DoctorGate } from "../gates.js";
import { runShell } from "../util.js";

const DISK_MIN_FREE_GB = 5;
const LOG_DIR_MAX_MB = 500;

export const infrastructureGates: DoctorGate[] = [
  {
    id: "infra.disk-free",
    group: "infrastructure",
    description: `At least ${DISK_MIN_FREE_GB} GiB free on /System/Volumes/Data`,
    async run() {
      // df -g prints GiB on macOS; column 4 = avail
      const { stdout, code } = await runShell(
        "df -g /System/Volumes/Data 2>/dev/null | tail -n 1",
      );
      if (code !== 0) return { status: "skip", detail: "df failed" };
      const cols = stdout.trim().split(/\s+/);
      const availGi = cols[3] ? Number.parseInt(cols[3], 10) : NaN;
      if (Number.isNaN(availGi)) {
        return { status: "skip", detail: "could not parse df output" };
      }
      const pass = availGi >= DISK_MIN_FREE_GB;
      return {
        status: pass ? "pass" : "fail",
        detail: `${availGi} GiB free (threshold ${DISK_MIN_FREE_GB})`,
        metrics: { availGi, thresholdGi: DISK_MIN_FREE_GB },
      };
    },
  },

  {
    id: "infra.log-dir-size",
    group: "infrastructure",
    description: `Log directories under ${LOG_DIR_MAX_MB} MiB combined`,
    async run() {
      const { stdout, code } = await runShell(
        "du -sm ~/Library/Logs/ping-guard ~/Library/Logs 2>/dev/null | head -n 1 || true",
      );
      if (code !== 0 || !stdout.trim()) {
        return { status: "skip", detail: "log dirs missing" };
      }
      const first = stdout.trim().split(/\s+/)[0];
      const sizeMb = first ? Number.parseInt(first, 10) : NaN;
      if (Number.isNaN(sizeMb)) return { status: "skip", detail: "parse failed" };
      const pass = sizeMb <= LOG_DIR_MAX_MB;
      return {
        status: pass ? "pass" : "fail",
        detail: `${sizeMb} MiB (cap ${LOG_DIR_MAX_MB})`,
        metrics: { sizeMb, capMb: LOG_DIR_MAX_MB },
      };
    },
  },

  {
    id: "infra.ping-mem-container",
    group: "infrastructure",
    description: "Docker container 'ping-mem' is running",
    async run() {
      const { stdout } = await runShell(
        "docker ps --filter name=^ping-mem$ --format '{{.Status}}'",
      );
      const isUp = stdout.trim().startsWith("Up");
      return {
        status: isUp ? "pass" : "fail",
        detail: stdout.trim() || "not running",
      };
    },
  },

  {
    id: "infra.neo4j-container",
    group: "infrastructure",
    description: "Docker container 'ping-mem-neo4j' is running",
    async run() {
      const { stdout } = await runShell(
        "docker ps --filter name=^ping-mem-neo4j$ --format '{{.Status}}'",
      );
      const isUp = stdout.trim().startsWith("Up");
      return {
        status: isUp ? "pass" : "fail",
        detail: stdout.trim() || "not running",
      };
    },
  },

  {
    id: "infra.qdrant-container",
    group: "infrastructure",
    description: "Docker container 'ping-mem-qdrant' is running",
    async run() {
      const { stdout } = await runShell(
        "docker ps --filter name=^ping-mem-qdrant$ --format '{{.Status}}'",
      );
      const isUp = stdout.trim().startsWith("Up");
      return {
        status: isUp ? "pass" : "fail",
        detail: stdout.trim() || "not running",
      };
    },
  },

  {
    id: "infra.orbstack-reachable",
    group: "infrastructure",
    description: "OrbStack docker socket is reachable",
    async run() {
      const { stdout, code } = await runShell(
        "docker info --format '{{.ServerVersion}}' 2>&1",
      );
      if (code !== 0) {
        return { status: "fail", detail: `docker info exit ${code}: ${stdout.slice(0, 120)}` };
      }
      return { status: "pass", detail: `docker ${stdout.trim()}` };
    },
  },
];
