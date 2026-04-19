/**
 * Doctor utilities — timeout wrapper, command helpers, shared constants.
 *
 * `runCmd` uses execFile (argv vector, no shell) — safe for untrusted args.
 * `runShell` runs a literal command line via `/bin/sh -c` for cases where
 * pipes / redirects are needed. Only callable with internally-sourced
 * literal strings — not user input.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a promise with an AbortController-driven timeout.
 * Rejects with `Error("timeout")` when the budget is exceeded.
 */
export async function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface ShellResult { stdout: string; stderr: string; code: number; }

/**
 * Run an executable with its argv vector (no shell). Preferred form.
 */
export async function runCmd(
  bin: string,
  args: readonly string[],
  timeoutMs = 3000,
): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args as string[], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

/**
 * Shell out with a timeout. Uses `/bin/sh -c` for pipes/globs. Caller must
 * pass internally-sourced literal strings only — no user input.
 */
export async function runShell(cmd: string, timeoutMs = 3000): Promise<ShellResult> {
  return runCmd("/bin/sh", ["-c", cmd], timeoutMs);
}

/** Fetch with AbortSignal + timeout, returning body text or throwing. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 3000,
): Promise<{ status: number; body: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Canonical project roots checked by data-coverage gates. */
export const CANONICAL_PROJECTS = [
  "/Users/umasankr/Projects/ping-mem",
  "/Users/umasankr/Projects/ping-learn",
  "/Users/umasankr/Projects/auto-os",
  "/Users/umasankr/Projects/ping-guard",
  "/Users/umasankr/Projects/thrivetree",
] as const;

/** Canonical regression queries — each must return ≥1 hit from /api/v1/search */
export const CANONICAL_QUERIES: readonly string[] = [
  "ping-learn pricing research",
  "Firebase FCM pinglearn-c63a2",
  "classroom redesign worktree",
  "PR 236 JWT secret isolation",
  "DPDP consent age 18",
  "PingLearn voice tutor LiveKit",
  "Supabase migration consent tokens",
  "Ollama qwen3:8b recovery brain",
  "ping-mem-doctor gates 29",
  "native-sync hook truncation fix",
];
