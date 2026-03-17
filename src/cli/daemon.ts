/**
 * Background daemon for ping-mem shell integration.
 *
 * Listens on a Unix domain socket, receives lightweight text messages
 * from shell hooks, batches events, and forwards them to the REST API.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createClient, type ClientOptions } from "./client.js";

export interface DaemonConfig {
  socketPath: string;
  pidFile: string;
  serverUrl: string;
}

export function getDefaultSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "/tmp";
  return path.join(runtimeDir, `ping-mem-${process.getuid?.() ?? 0}.sock`);
}

export function getDefaultDaemonConfig(): DaemonConfig {
  const configDir = path.join(os.homedir(), ".ping-mem");
  return {
    socketPath: getDefaultSocketPath(),
    pidFile: path.join(configDir, "daemon.pid"),
    serverUrl: "http://localhost:3000",
  };
}

/**
 * Detect the git project root for a given directory.
 * Returns null if not inside a git repo.
 */
function detectGitRoot(dir: string): string | null {
  let current = dir;
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

/**
 * Detect the current git branch for a directory.
 * Returns null if not in a git repo or branch cannot be determined.
 */
function detectGitBranch(gitRoot: string): string | null {
  try {
    const headPath = path.join(gitRoot, ".git", "HEAD");
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (head.startsWith("ref: refs/heads/")) {
      return head.slice("ref: refs/heads/".length);
    }
    // Detached HEAD — return short hash
    return head.slice(0, 8);
  } catch {
    return null;
  }
}

/** Batch buffer for shell events before flushing to the REST API. */
interface ShellEvent {
  type: "precmd" | "chdir";
  directory: string;
  timestamp: string;
  gitRoot: string | null;
  gitBranch: string | null;
}

export async function startDaemon(config?: Partial<DaemonConfig>): Promise<void> {
  const cfg: DaemonConfig = { ...getDefaultDaemonConfig(), ...config };

  // Ensure config directory exists for PID file
  const pidDir = path.dirname(cfg.pidFile);
  fs.mkdirSync(pidDir, { recursive: true });

  // Remove stale socket if it exists
  if (fs.existsSync(cfg.socketPath)) {
    try {
      fs.unlinkSync(cfg.socketPath);
    } catch {
      // Ignore — may be cleaned up by OS
    }
  }

  // Write PID file
  fs.writeFileSync(cfg.pidFile, String(process.pid));

  const client = createClient({ serverUrl: cfg.serverUrl });

  // Event batching: accumulate events, flush every 2 seconds
  let eventBatch: ShellEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleBatchFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushBatch();
    }, 2000);
  }

  async function flushBatch(): Promise<void> {
    if (eventBatch.length === 0) return;
    const batch = eventBatch;
    eventBatch = [];

    // Only send the latest event per directory (dedup)
    const latest = new Map<string, ShellEvent>();
    for (const evt of batch) {
      latest.set(evt.directory, evt);
    }

    for (const evt of latest.values()) {
      try {
        await client.post("/api/v1/shell/event", evt as unknown as Record<string, unknown>);
      } catch {
        // Fire-and-forget — daemon must not crash on API errors
      }
    }
  }

  function handleMessage(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) return;

    const type = trimmed.slice(0, colonIdx);
    const directory = trimmed.slice(colonIdx + 1);

    if (type !== "precmd" && type !== "chdir") return;
    if (!directory || !path.isAbsolute(directory)) return;

    const gitRoot = detectGitRoot(directory);
    const gitBranch = gitRoot ? detectGitBranch(gitRoot) : null;

    eventBatch.push({
      type: type as "precmd" | "chdir",
      directory,
      timestamp: new Date().toISOString(),
      gitRoot,
      gitBranch,
    });
    scheduleBatchFlush();
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        handleMessage(line);
      }
    });
    socket.on("end", () => {
      if (buffer.trim()) {
        handleMessage(buffer);
      }
    });
    socket.on("error", () => {
      // Ignore client errors — shell hooks disconnect immediately
    });
  });

  function cleanup(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try { fs.unlinkSync(cfg.socketPath); } catch { /* ignore */ }
    try { fs.unlinkSync(cfg.pidFile); } catch { /* ignore */ }
    server.close();
  }

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  return new Promise<void>((resolve, reject) => {
    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
    server.listen(cfg.socketPath, () => {
      // Make socket writable by the user only
      try { fs.chmodSync(cfg.socketPath, 0o600); } catch { /* ignore */ }
      resolve();
    });
  });
}

export async function stopDaemon(config?: Partial<DaemonConfig>): Promise<boolean> {
  const cfg: DaemonConfig = { ...getDefaultDaemonConfig(), ...config };

  try {
    const pidStr = fs.readFileSync(cfg.pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      return false;
    }
    process.kill(pid, "SIGTERM");
    // Clean up PID file and socket
    try { fs.unlinkSync(cfg.pidFile); } catch { /* ignore */ }
    try { fs.unlinkSync(cfg.socketPath); } catch { /* ignore */ }
    return true;
  } catch {
    // PID file doesn't exist or process already gone
    return false;
  }
}

export function isDaemonRunning(config?: Partial<DaemonConfig>): boolean {
  const cfg: DaemonConfig = { ...getDefaultDaemonConfig(), ...config };

  try {
    const pidStr = fs.readFileSync(cfg.pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) return false;
    // signal 0 checks if process exists without sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
