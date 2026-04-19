/**
 * GitHistoryReader: Deterministic git commit DAG + diffs ingestion
 *
 * Extracts git commit history, parent-child relationships, and diff hunks.
 * All data is deterministic: same repo state → same output.
 */

import * as path from "path";
import { SafeGit, createSafeGit } from "./SafeGit.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("GitHistoryReader");

/**
 * Phase 2 default: 10000 commits covers full history for the vast majority
 * of projects (ping-learn ~657 commits, ping-mem ~180, auto-os ~152, etc.).
 * Can be overridden per-call via options or globally via env var
 * PING_MEM_MAX_COMMITS. Raised from 200 in Phase 2 of remediation plan so that
 * re-ingest achieves ≥95% commit coverage without callers having to specify.
 */
const DEFAULT_MAX_COMMITS = 10000;

/**
 * Phase 2 default: 365 days (was 30). Cut-off based only on author date; does
 * not limit the commit COUNT (that's maxCommits). Override per-call or via env
 * PING_MEM_MAX_COMMIT_AGE_DAYS.
 */
const DEFAULT_MAX_COMMIT_AGE_DAYS = 365;

/**
 * Parse a non-negative integer env var; fall back to default on missing / NaN /
 * negative. Exported for testing.
 */
export function parseNonNegativeIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  // Reject "100abc", "1.5", "-1", " 42", etc. Only pure non-negative integers pass.
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return parsed;
}

export function resolveDefaultMaxCommits(): number {
  return parseNonNegativeIntEnv(process.env.PING_MEM_MAX_COMMITS, DEFAULT_MAX_COMMITS);
}

export function resolveDefaultMaxCommitAgeDays(): number {
  return parseNonNegativeIntEnv(
    process.env.PING_MEM_MAX_COMMIT_AGE_DAYS,
    DEFAULT_MAX_COMMIT_AGE_DAYS,
  );
}

export interface GitCommit {
  hash: string; // Full SHA-1
  shortHash: string; // Abbreviated SHA-1
  authorName: string;
  authorEmail: string;
  authorDate: string; // ISO 8601
  committerName: string;
  committerEmail: string;
  committerDate: string; // ISO 8601
  message: string;
  parentHashes: string[];
}

export interface GitDiffHunk {
  commitHash: string;
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string; // The unified diff content for this hunk
}

export interface GitFileChange {
  commitHash: string;
  filePath: string;
  changeType: "A" | "M" | "D" | "R" | "C"; // Add/Modify/Delete/Rename/Copy
  oldPath?: string; // For renames
}

export interface GitHistoryResult {
  commits: GitCommit[];
  fileChanges: GitFileChange[];
  hunks: GitDiffHunk[];
}

export class GitHistoryReader {
  /**
   * Read full git history from a repository.
   * Returns commits in topological order (parents before children when possible).
   */
  async readHistory(projectDir: string, options?: { maxCommits?: number; maxCommitAgeDays?: number }): Promise<GitHistoryResult> {
    const gitRoot = await this.getGitRoot(projectDir);
    if (!gitRoot) {
      return { commits: [], fileChanges: [], hunks: [] };
    }

    const maxCommits = options?.maxCommits ?? resolveDefaultMaxCommits();
    // Phase 2: if no explicit age limit, fall back to env-overridable default (365d) —
    // value of 0 is treated as "no age filter" to allow full-history re-ingest.
    const effectiveAgeDays =
      options?.maxCommitAgeDays ?? resolveDefaultMaxCommitAgeDays();
    const since = effectiveAgeDays > 0 ? `${effectiveAgeDays} days ago` : undefined;
    const commits = await this.readCommits(gitRoot, maxCommits, since);
    log.info(`Found ${commits.length} commits, processing diffs...`);
    const fileChanges: GitFileChange[] = [];
    const hunks: GitDiffHunk[] = [];

    let processed = 0;
    for (const commit of commits) {
      processed++;
      if (processed % 10 === 0 || processed === commits.length) {
        log.info(`Progress: ${processed}/${commits.length} commits`);
      }

      try {
        const changes = await this.readFileChanges(gitRoot, commit.hash);
        fileChanges.push(...changes);

        const commitHunks = await this.readDiffHunks(gitRoot, commit.hash);
        hunks.push(...commitHunks);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn("Failed to process commit diffs, skipping", { hash: commit.hash, error: message });
      }
    }

    return { commits, fileChanges, hunks };
  }

  private async getGitRoot(projectDir: string): Promise<string | null> {
    try {
      const git = createSafeGit(projectDir);
      const root = await git.getRoot();
      return root;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // "not a git repository" is expected for non-git dirs — return null to skip git history
      if (message.includes("not a git repository") || message.includes("fatal: not a git repository")) {
        log.info(`No git repo at "${projectDir}", skipping git history`);
        return null;
      }
      // Unexpected git errors should propagate, not silently return empty history
      throw new Error(`GitHistoryReader.getGitRoot failed for "${projectDir}": ${message}`);
    }
  }

  private async readCommits(gitRoot: string, maxCommits: number, since?: string): Promise<GitCommit[]> {
    // Use a delimiter that won't appear in commit messages
    const delimiter = "---COMMIT-SEPARATOR---";
    const format = [
      "%H", // Full hash
      "%h", // Short hash
      "%an", // Author name
      "%ae", // Author email
      "%aI", // Author date ISO 8601
      "%cn", // Committer name
      "%ce", // Committer email
      "%cI", // Committer date ISO 8601
      "%P", // Parent hashes
      "%B", // Body (message)
    ].join("%n") + delimiter;

    const git = createSafeGit(gitRoot, { maxBuffer: 100 * 1024 * 1024 });
    const output = await git.getLog(maxCommits, format, since);

    const commits: GitCommit[] = [];
    const commitBlocks = output
      .split(delimiter)
      .map((b) => b.trim()) // Trim leading/trailing whitespace from each block
      .filter((b) => b.length > 0); // Filter empty blocks

    for (const block of commitBlocks) {
      const lines = block.split("\n");
      if (lines.length < 9) continue;

      const hash = lines[0]!.trim();
      const shortHash = lines[1]!.trim();
      const authorName = lines[2]!.trim();
      const authorEmail = lines[3]!.trim();
      const authorDate = lines[4]!.trim();
      const committerName = lines[5]!.trim();
      const committerEmail = lines[6]!.trim();
      const committerDate = lines[7]!.trim();
      const parentHashesLine = lines[8]!.trim();
      const parentHashes = parentHashesLine ? parentHashesLine.split(" ").filter(h => h.length > 0) : [];

      // Everything from line 9 onwards is the message
      const message = lines.slice(9).join("\n").trim();

      commits.push({
        hash,
        shortHash,
        authorName,
        authorEmail,
        authorDate,
        committerName,
        committerEmail,
        committerDate,
        message,
        parentHashes,
      });
    }

    return commits;
  }

  private async readFileChanges(gitRoot: string, commitHash: string): Promise<GitFileChange[]> {
    // Use --name-status to get change type + file paths
    const git = createSafeGit(gitRoot, { maxBuffer: 10 * 1024 * 1024 });
    const output = await git.getFileChanges(commitHash);

    const changes: GitFileChange[] = [];
    const lines = output.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const statusPart = parts[0]!.trim();
      const changeType = statusPart[0] as "A" | "M" | "D" | "R" | "C";

      // For R (rename) and C (copy), git --name-status outputs:
      //   <status>\t<old-path>\t<new-path>
      // filePath must be the NEW (current) path; oldPath is the source.
      const isRenameOrCopy = changeType === "R" || changeType === "C";
      const filePath = isRenameOrCopy
        ? this.normalizePath(parts[2]!)
        : this.normalizePath(parts[1]!);

      const change: GitFileChange = {
        commitHash,
        filePath,
        changeType,
      };

      if (isRenameOrCopy && parts.length > 2) {
        change.oldPath = this.normalizePath(parts[1]!);
      }

      changes.push(change);
    }

    return changes;
  }

  private async readDiffHunks(gitRoot: string, commitHash: string): Promise<GitDiffHunk[]> {
    // Get unified diff
    const git = createSafeGit(gitRoot, { maxBuffer: 50 * 1024 * 1024 });
    const output = await git.getDiff(commitHash);

    const hunks: GitDiffHunk[] = [];
    const lines = output.split("\n");
    let currentFile: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Detect file header (e.g., "diff --git a/file b/file")
      if (line.startsWith("diff --git ")) {
        currentFile = null;
      }

      // Detect new file path (e.g., "+++ b/file")
      if (line.startsWith("+++ b/")) {
        currentFile = this.normalizePath(line.slice(6));
      }

      // Detect hunk header (e.g., "@@ -1,3 +1,4 @@")
      if (line.startsWith("@@") && currentFile) {
        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match) {
          const oldStart = parseInt(match[1]!, 10);
          const oldLines = match[2] ? parseInt(match[2], 10) : 1;
          const newStart = parseInt(match[3]!, 10);
          const newLines = match[4] ? parseInt(match[4], 10) : 1;

          // Collect hunk content
          const hunkLines: string[] = [line];
          let j = i + 1;
          while (
            j < lines.length &&
            !lines[j]!.startsWith("@@") &&
            !lines[j]!.startsWith("diff --git")
          ) {
            hunkLines.push(lines[j]!);
            j++;
          }

          hunks.push({
            commitHash,
            filePath: currentFile,
            oldStart,
            oldLines,
            newStart,
            newLines,
            content: hunkLines.join("\n"),
          });
        }
      }
    }

    return hunks;
  }

  private normalizePath(filePath: string): string {
    return filePath.split(path.sep).join(path.posix.sep);
  }
}
