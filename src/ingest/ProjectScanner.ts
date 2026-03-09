import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { createSafeGit } from "./SafeGit.js";
import { createLogger } from "../util/logger.js";
import type { FileHashEntry, ProjectManifest, ProjectScanResult } from "./types.js";

const log = createLogger("ProjectScanner");

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".ping-mem",
  ".worktrees",
  ".claude",
  ".vscode",
  ".idea",
]);

const DEFAULT_EXCLUDE_EXTENSIONS = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".webp", ".ico", ".svg",
  // Media
  ".mp4", ".webm", ".mp3", ".wav", ".ogg",
  // Documents (can't be chunked into code)
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  // Archives
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  // Fonts
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  // Compiled
  ".exe", ".dll", ".so", ".dylib", ".pyc", ".pyo", ".class",
  // Database
  ".db", ".sqlite", ".sqlite3",
  // Lock files (large, not meaningful to chunk)
  ".lock",
]);

const MANIFEST_SCHEMA_VERSION = 1;

export interface ProjectScanOptions {
  ignoreDirs?: Set<string>;
  includeExtensions?: Set<string>;
  excludeExtensions?: Set<string>;
  useGitLsFiles?: boolean;
}

export class ProjectScanner {
  private readonly ignoreDirs: Set<string>;
  private readonly includeExtensions: Set<string> | null;
  private readonly excludeExtensions: Set<string>;
  private readonly useGitLsFiles: boolean;

  constructor(options: ProjectScanOptions = {}) {
    this.ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
    this.includeExtensions = options.includeExtensions ?? null;
    this.excludeExtensions = options.excludeExtensions ?? DEFAULT_EXCLUDE_EXTENSIONS;
    this.useGitLsFiles = options.useGitLsFiles ?? true;
  }

  async scanProject(projectDir: string, previousManifest?: ProjectManifest): Promise<ProjectScanResult> {
    // Resolve symlinks so path.relative works correctly with git rev-parse
    // (which always resolves symlinks). macOS: /var → /private/var.
    const rootPath = fs.realpathSync(path.resolve(projectDir));
    const files = await this.collectFiles(rootPath);
    const fileEntries = files.map((filePath) =>
      this.hashFile(rootPath, filePath)
    );

    const treeHash = this.computeTreeHash(fileEntries);
    const projectId = await this.computeProjectId(rootPath);

    const manifest: ProjectManifest = {
      projectId,
      rootPath,
      treeHash,
      files: fileEntries,
      generatedAt: new Date().toISOString(),
      schemaVersion: MANIFEST_SCHEMA_VERSION,
    };

    const hasChanges =
      !previousManifest || previousManifest.treeHash !== manifest.treeHash;

    return { manifest, hasChanges };
  }

  private async collectFiles(rootPath: string): Promise<string[]> {
    if (this.useGitLsFiles) {
      const gitFiles = await this.tryGitLsFiles(rootPath);
      if (gitFiles !== null) {
        log.info(`Using git ls-files: ${gitFiles.length} tracked files`);
        return gitFiles
          .filter(f => {
            const ext = path.extname(f).toLowerCase();
            if (this.excludeExtensions.has(ext)) return false;
            if (this.includeExtensions && !this.includeExtensions.has(ext)) return false;
            return true;
          })
          .map(f => path.join(rootPath, f))
          .sort();
      }
    }

    log.info("Not a git repo or git ls-files disabled, falling back to directory walk");
    return this.walkDirectory(rootPath);
  }

  private async tryGitLsFiles(rootPath: string): Promise<string[] | null> {
    try {
      const git = createSafeGit(rootPath);
      return await git.lsFiles();
    } catch {
      return null;
    }
  }

  private walkDirectory(rootPath: string): string[] {
    const results: string[] = [];
    const walk = (current: string) => {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sorted) {
        if (entry.name.startsWith(".")) {
          if (this.ignoreDirs.has(entry.name)) {
            continue;
          }
        }
        // Exclude .env files to prevent secrets from being ingested
        if (entry.name === ".env" || (entry.name.startsWith(".env.") && entry.isFile())) {
          continue;
        }
        // Exclude OS-generated metadata files
        if (entry.name === ".DS_Store" || entry.name === "Thumbs.db") {
          continue;
        }
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (this.ignoreDirs.has(entry.name)) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (this.excludeExtensions.has(ext)) {
            continue;
          }
          if (this.includeExtensions) {
            if (!this.includeExtensions.has(ext)) {
              continue;
            }
          }
          results.push(fullPath);
        }
      }
    };
    walk(rootPath);
    return results.sort();
  }

  private hashFile(rootPath: string, filePath: string): FileHashEntry {
    const content = fs.readFileSync(filePath);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const relPath = this.normalizePath(path.relative(rootPath, filePath));
    return {
      path: relPath,
      sha256,
      bytes: content.length,
    };
  }

  private computeTreeHash(entries: FileHashEntry[]): string {
    const hash = crypto.createHash("sha256");
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of sorted) {
      hash.update(entry.path);
      hash.update("\n");
      hash.update(entry.sha256);
      hash.update("\n");
    }
    return hash.digest("hex");
  }

  private async computeProjectId(rootPath: string): Promise<string> {
    const gitKey = await this.getGitIdentity(rootPath);
    const input = gitKey ?? this.normalizePath(rootPath);
    return crypto.createHash("sha256").update(input).digest("hex");
  }

  private async getGitIdentity(rootPath: string): Promise<string | null> {
    try {
      const safeGit = createSafeGit(rootPath);
      const gitRoot = await safeGit.getRoot();

      // Query remote URL from the git root directory (not rootPath, which may be a subdir)
      const safeGitFromRoot = createSafeGit(gitRoot);
      const remoteUrl = await safeGitFromRoot.getRemoteUrl();

      if (!remoteUrl) {
        const repoName = path.basename(gitRoot);
        const relativeToGitRoot = path.relative(gitRoot, rootPath) || ".";
        return `${repoName}::${this.normalizePath(relativeToGitRoot)}`;
      }

      const relativeToGitRoot = path.relative(gitRoot, rootPath) || ".";
      return `${remoteUrl}::${this.normalizePath(relativeToGitRoot)}`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // "not a git repository" is expected for non-git dirs — fallback is appropriate
      if (message.includes("not a git repository") || message.includes("fatal: not a git repository")) {
        log.info(`No git repo at "${rootPath}", using path-based projectId`);
        return null;
      }
      // Unexpected git errors should propagate, not silently degrade to a different identity
      throw new Error(`ProjectScanner.getGitIdentity failed for "${rootPath}": ${message}`);
    }
  }

  private normalizePath(filePath: string): string {
    return filePath.split(path.sep).join(path.posix.sep);
  }
}
