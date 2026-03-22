/**
 * Shared Claude CLI invocation utility.
 *
 * Spawns the `claude` CLI via stdin-piping (safer for large prompts, avoids
 * shell injection), with a 2-minute timeout and a `killed` flag so callers
 * get a specific "timed out" error rather than a generic exit-code error.
 *
 * Both TranscriptMiner and DreamingEngine import this instead of maintaining
 * their own private copies.
 *
 * @module llm/ClaudeCli
 */

import { createLogger } from "../util/logger.js";

const log = createLogger("ClaudeCli");

export interface ClaudeCliOptions {
  /** Model name, e.g. "claude-haiku-4-5" or "claude-sonnet-4-6" */
  model: string;
  /** Optional system prompt */
  system?: string;
  /** Timeout in milliseconds. Default: 120_000 (2 minutes) */
  timeoutMs?: number;
}

/**
 * Call the Claude CLI with the given prompt and options.
 *
 * Uses stdin-piping so the prompt is never exposed on the command line.
 * Throws with a descriptive message on timeout or non-zero exit.
 *
 * @param prompt - User prompt text (may be large; passed via stdin)
 * @param options - Model, system prompt, and timeout
 * @returns The `result` field from the Claude CLI JSON response
 */
export async function callClaude(
  prompt: string,
  options: ClaudeCliOptions
): Promise<string> {
  const { model, system, timeoutMs = 120_000 } = options;

  const cmd: string[] = [
    "claude",
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--no-session-persistence",
    "--max-turns",
    "1",
    "--dangerously-skip-permissions",
  ];

  if (system) {
    cmd.push("--system-prompt", system);
  }

  const proc = Bun.spawn(cmd, {
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
  });

  let killed = false;
  const timeoutHandle = setTimeout(() => {
    killed = true;
    log.warn("Claude CLI timed out, killing process", { model, timeoutMs });
    try {
      proc.kill();
    } catch {
      // Process may have already exited
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();

  try {
    // Collect stdout
    if (proc.stdout) {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdout += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    }

    // Collect stderr
    if (proc.stderr) {
      const reader = proc.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderr += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    }

    const exitCode = await proc.exited;
    clearTimeout(timeoutHandle);

    if (killed) {
      throw new Error("Claude CLI timed out after 2 minutes");
    }

    if (exitCode !== 0) {
      throw new Error(
        `Claude CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`
      );
    }

    const parsed = JSON.parse(stdout) as { result?: string; content?: string };
    const content = parsed.result ?? parsed.content ?? "";
    if (typeof content !== "string") {
      throw new Error(
        `Unexpected Claude CLI output format: ${stdout.slice(0, 200)}`
      );
    }
    return content;
  } catch (err) {
    clearTimeout(timeoutHandle);
    throw err;
  }
}
