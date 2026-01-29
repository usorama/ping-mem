/**
 * GitHistoryReader: Deterministic git commit DAG + diffs ingestion
 *
 * Extracts git commit history, parent-child relationships, and diff hunks.
 * All data is deterministic: same repo state → same output.
 */

import { execSync } from "child_process";
import * as path from "path";

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
  readHistory(projectDir: string): GitHistoryResult {
    const gitRoot = this.getGitRoot(projectDir);
    if (!gitRoot) {
      return { commits: [], fileChanges: [], hunks: [] };
    }

    const commits = this.readCommits(gitRoot);
    const fileChanges: GitFileChange[] = [];
    const hunks: GitDiffHunk[] = [];

    for (const commit of commits) {
      const changes = this.readFileChanges(gitRoot, commit.hash);
      fileChanges.push(...changes);

      const commitHunks = this.readDiffHunks(gitRoot, commit.hash);
      hunks.push(...commitHunks);
    }

    return { commits, fileChanges, hunks };
  }

  private getGitRoot(projectDir: string): string | null {
    try {
      const root = execSync("git rev-parse --show-toplevel", {
        cwd: projectDir,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      return root;
    } catch {
      return null;
    }
  }

  private readCommits(gitRoot: string): GitCommit[] {
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

    const output = execSync(`git log --all --topo-order --format="${format}"`, {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 100 * 1024 * 1024, // 100MB
    }).toString();

    const commits: GitCommit[] = [];
    const commitBlocks = output.split(delimiter).filter((b) => b.trim());

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
      const parentHashes = parentHashesLine ? parentHashesLine.split(" ") : [];

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

  private readFileChanges(gitRoot: string, commitHash: string): GitFileChange[] {
    // Use --name-status to get change type + file paths
    const output = execSync(
      `git show --name-status --format="" ${commitHash}`,
      {
        cwd: gitRoot,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      }
    ).toString();

    const changes: GitFileChange[] = [];
    const lines = output.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const statusPart = parts[0]!.trim();
      const changeType = statusPart[0] as "A" | "M" | "D" | "R" | "C";
      const filePath = this.normalizePath(parts[1]!);

      const change: GitFileChange = {
        commitHash,
        filePath,
        changeType,
      };

      if (parts.length > 2) {
        change.oldPath = this.normalizePath(parts[2]!);
      }

      changes.push(change);
    }

    return changes;
  }

  private readDiffHunks(gitRoot: string, commitHash: string): GitDiffHunk[] {
    // Get unified diff
    const output = execSync(`git show --unified=3 ${commitHash}`, {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 50 * 1024 * 1024,
    }).toString();

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
