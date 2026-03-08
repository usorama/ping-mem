/**
 * SafeGit: Secure git command runner
 *
 * Prevents command injection via:
 * 1. Hash validation (SHA-1 format only)
 * 2. execFile API (no shell spawning)
 * 3. Argument arrays (not concatenation)
 *
 * @module ingest/SafeGit
 */

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { createLogger } from "../util/logger.js";

const log = createLogger("SafeGit");

const runCommand = promisify(execFile);
const GIT_HASH_REGEX = /^[a-f0-9]{7,40}$/i;
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

export interface GitExecOptions {
  cwd: string;
  maxBuffer?: number;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

export class SafeGit {
  private gitRoot: string;
  private maxBuffer: number;

  constructor(gitRoot: string, options?: { maxBuffer?: number }) {
    this.gitRoot = gitRoot;
    this.maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  private validateHash(hash: string): string {
    if (!GIT_HASH_REGEX.test(hash)) {
      throw new Error(
        `Invalid git hash: "${hash}". Expected 7-40 hex chars.`
      );
    }
    return hash;
  }

  private async run(args: string[]): Promise<GitExecResult> {
    const { stdout, stderr } = await runCommand("git", args, {
      cwd: this.gitRoot,
      maxBuffer: this.maxBuffer,
      shell: false,
    });
    return { stdout, stderr };
  }

  async getDiff(commitHash: string): Promise<string> {
    const safeHash = this.validateHash(commitHash);
    const { stdout } = await this.run(["show", "--unified=3", safeHash]);
    return stdout;
  }

  async getFileChanges(commitHash: string): Promise<string> {
    const safeHash = this.validateHash(commitHash);
    const { stdout } = await this.run(["show", "--name-status", "--format=", safeHash]);
    return stdout;
  }

  async getLog(limit: number = 100, format: string = "%H|%P|%an|%ae|%at|%s"): Promise<string> {
    // Validate format: only printable ASCII (prevents control char injection)
    if (/[^\x20-\x7E]/.test(format)) {
      throw new Error("SafeGit.getLog: format must contain only printable ASCII characters");
    }
    // Clamp limit to prevent excessive memory usage via maxBuffer
    const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 10000));
    const { stdout } = await this.run(["log", "--all", "--topo-order", `--format=${format}`, `-n${clampedLimit}`]);
    return stdout;
  }

  async getRoot(): Promise<string> {
    const { stdout } = await this.run(["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  }

  async getHead(): Promise<string> {
    const { stdout } = await this.run(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async getRemoteUrl(): Promise<string | null> {
    try {
      const result = await this.run(["config", "--get", "remote.origin.url"]);
      return result.stdout.trim() || null;
    } catch (error: unknown) {
      // git config --get exits with code 1 when the key is not found (no remote configured).
      // Check exit code property first; fall back to string matching for compatibility.
      const errObj = error as { code?: number | string };
      if (typeof errObj.code === "number" && errObj.code === 1) {
        return null; // No remote configured — expected
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("exit code 1")) {
        return null; // No remote configured — expected (string fallback)
      }
      // Unexpected error — propagate instead of silently returning null
      log.error("getRemoteUrl unexpected error", { error: message });
      throw new Error(`SafeGit.getRemoteUrl failed: ${message}`);
    }
  }

  async listFiles(commitHash: string): Promise<string[]> {
    const safeHash = this.validateHash(commitHash);
    const { stdout } = await this.run(["diff-tree", "--no-commit-id", "--name-only", "-r", safeHash]);
    return stdout.trim().split("\n").filter(Boolean);
  }

  private validateFilePath(filePath: string): string {
    // Reject absolute paths
    if (path.isAbsolute(filePath)) {
      throw new Error(`Invalid file path: absolute paths are not allowed: ${filePath}`);
    }
    // Normalize and check for traversal
    const normalized = path.normalize(filePath);
    if (normalized.startsWith("..") || normalized.includes(`${path.sep}..`)) {
      throw new Error(`Invalid file path: path traversal detected: ${filePath}`);
    }
    return normalized;
  }

  async getFileContent(commitHash: string, filePath: string): Promise<string> {
    const safeHash = this.validateHash(commitHash);
    const safePath = this.validateFilePath(filePath);
    const { stdout } = await this.run(["show", `${safeHash}:${safePath}`]);
    return stdout;
  }
}

export function createSafeGit(gitRoot: string, options?: { maxBuffer?: number }): SafeGit {
  return new SafeGit(gitRoot, options);
}
