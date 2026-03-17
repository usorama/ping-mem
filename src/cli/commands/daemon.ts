/**
 * Daemon management commands: start, stop, status
 */

import { defineCommand } from "citty";
import { startDaemon, stopDaemon, isDaemonRunning, getDefaultDaemonConfig } from "../daemon.js";
import { outputArgs, serverArgs } from "../shared.js";
import { printOutput, resolveFormat } from "../output.js";

const start = defineCommand({
  meta: { name: "start", description: "Start the background daemon" },
  args: {
    ...outputArgs,
    ...serverArgs,
    foreground: {
      type: "boolean",
      description: "Run in foreground (don't detach)",
      default: false,
    },
  },
  async run({ args }) {
    const format = resolveFormat(args);

    if (isDaemonRunning()) {
      printOutput({ status: "already-running", message: "Daemon is already running" }, format);
      return;
    }

    const cfg = getDefaultDaemonConfig();
    if (args.server) {
      cfg.serverUrl = args.server;
    }

    if (args.foreground) {
      printOutput({ status: "starting", message: "Starting daemon in foreground...", socketPath: cfg.socketPath }, format);
      await startDaemon(cfg);
      // startDaemon resolves when socket is listening; in foreground mode we keep the process alive
      // The process stays alive because the net.Server keeps the event loop running
      return;
    }

    // Background mode: spawn a detached child process
    const { spawn } = await import("node:child_process");
    const binPath = process.argv[1];
    if (!binPath) {
      console.error("Cannot determine executable path for background spawn");
      process.exit(1);
    }
    const child = spawn(
      process.argv[0] ?? "bun",
      [binPath, "daemon", "start", "--foreground", ...(args.server ? ["--server", args.server] : [])],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();

    // Wait briefly for the daemon to write its PID file
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (isDaemonRunning()) {
      printOutput({ status: "started", message: "Daemon started", pid: child.pid, socketPath: cfg.socketPath }, format);
    } else {
      printOutput({ status: "error", message: "Daemon failed to start" }, format);
      process.exit(1);
    }
  },
});

const stop = defineCommand({
  meta: { name: "stop", description: "Stop the background daemon" },
  args: {
    ...outputArgs,
  },
  async run({ args }) {
    const format = resolveFormat(args);
    const stopped = await stopDaemon();
    if (stopped) {
      printOutput({ status: "stopped", message: "Daemon stopped" }, format);
    } else {
      printOutput({ status: "not-running", message: "Daemon is not running" }, format);
    }
  },
});

const status = defineCommand({
  meta: { name: "status", description: "Check daemon status" },
  args: {
    ...outputArgs,
  },
  run({ args }) {
    const format = resolveFormat(args);
    const running = isDaemonRunning();
    const cfg = getDefaultDaemonConfig();
    printOutput({
      status: running ? "running" : "stopped",
      socketPath: cfg.socketPath,
      pidFile: cfg.pidFile,
    }, format);
  },
});

export default defineCommand({
  meta: { name: "daemon", description: "Background daemon management" },
  subCommands: { start, stop, status },
});
