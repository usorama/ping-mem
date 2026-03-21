/**
 * Tests for daemon lifecycle management.
 */

import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  getDefaultDaemonConfig,
  getDefaultSocketPath,
  isDaemonRunning,
} from "../daemon.js";

describe("daemon config", () => {
  test("getDefaultSocketPath returns path with UID", () => {
    const socketPath = getDefaultSocketPath();
    expect(socketPath).toContain("ping-mem-");
    expect(socketPath).toContain(".sock");
  });

  test("getDefaultDaemonConfig returns valid config", () => {
    const cfg = getDefaultDaemonConfig();
    expect(cfg.socketPath).toContain("ping-mem-");
    expect(cfg.pidFile).toContain(path.join(".ping-mem", "daemon.pid"));
    expect(cfg.serverUrl).toBe("http://localhost:3003");
  });

  test("isDaemonRunning returns false when no PID file exists", () => {
    const running = isDaemonRunning({
      pidFile: path.join(os.tmpdir(), `ping-mem-test-nonexistent-${Date.now()}.pid`),
      socketPath: "/tmp/nonexistent.sock",
      serverUrl: "http://localhost:3000",
    });
    expect(running).toBe(false);
  });

  test("isDaemonRunning returns false for stale PID", () => {
    const tmpPid = path.join(os.tmpdir(), `ping-mem-test-stale-${Date.now()}.pid`);
    // Write a PID that definitely doesn't exist (very high number)
    fs.writeFileSync(tmpPid, "999999999");
    try {
      const running = isDaemonRunning({
        pidFile: tmpPid,
        socketPath: "/tmp/nonexistent.sock",
        serverUrl: "http://localhost:3000",
      });
      expect(running).toBe(false);
    } finally {
      try { fs.unlinkSync(tmpPid); } catch { /* ignore */ }
    }
  });

  test("isDaemonRunning returns true for current process PID", () => {
    const tmpPid = path.join(os.tmpdir(), `ping-mem-test-live-${Date.now()}.pid`);
    fs.writeFileSync(tmpPid, String(process.pid));
    try {
      const running = isDaemonRunning({
        pidFile: tmpPid,
        socketPath: "/tmp/nonexistent.sock",
        serverUrl: "http://localhost:3000",
      });
      expect(running).toBe(true);
    } finally {
      try { fs.unlinkSync(tmpPid); } catch { /* ignore */ }
    }
  });
});
