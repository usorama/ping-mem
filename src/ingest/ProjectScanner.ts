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
  // Phase 1.2: Extended ignore dirs
  ".overstory",
  "coverage",
  "tmp",
  "temp",
  "out",
  ".turbo",
  ".parcel-cache",
  ".swc",
  "vendor",
  ".terraform",
  ".serverless",
  "e2e-tests",
  // Phase 2: Audit-driven additions (GH#114)
  ".autoresearch",
  ".beads",
  ".mulch",
  ".playwright-mcp",
  ".deployments",
  "snapshots",
  // Phase 2 remediation (2026-04-18): RESTORED `.ai` and `docs` — they contain
  // planning/research/decision artifacts that define project context. Excluding
  // them capped ping-learn coverage at ~44% (docs=183 files, .ai=203 files).
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
  // Phase 1.3: Extended exclude extensions
  ".d.ts", ".map", ".min.js", ".min.css", ".snap",
  ".log", ".wasm",
  // Phase 2: Audit-driven additions (GH#114) — binary-only Xcode/build artifacts
  ".pbxproj", ".xcworkspacedata", ".xcscheme", ".tsbuildinfo",
  // Phase 2 remediation (2026-04-18): RESTORED .md, .sh, .jsonl, .csv, .bat, .plist —
  // these are text files that contribute meaningfully to project context
  // (ping-learn has 343 .md files = 20% of repo; excluding them capped
  // coverage at ~56%, below the 95% gate).
]);

const MANIFEST_SCHEMA_VERSION = 1;

const DEFAULT_MAX_FILE_SIZE_BYTES = 1_048_576; // 1MB

export interface ProjectScanOptions {
  ignoreDirs?: Set<string>;
  includeExtensions?: Set<string>;
  excludeExtensions?: Set<string>;
  useGitLsFiles?: boolean;
  maxFileSizeBytes?: number; // Phase 1.6: default 1MB
}

export class ProjectScanner {
  private readonly ignoreDirs: Set<string>;
  private readonly includeExtensions: Set<string> | null;
  private readonly excludeExtensions: Set<string>;
  private readonly useGitLsFiles: boolean;
  private readonly maxFileSizeBytes: number;

  constructor(options: ProjectScanOptions = {}) {
    this.ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
    this.includeExtensions = options.includeExtensions ?? null;
    this.excludeExtensions = options.excludeExtensions ?? DEFAULT_EXCLUDE_EXTENSIONS;
    this.useGitLsFiles = options.useGitLsFiles ?? true;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  }

  async scanProject(projectDir: string, previousManifest?: ProjectManifest): Promise<ProjectScanResult> {
    // Resolve symlinks so path.relative works correctly with git rev-parse
    // (which always resolves symlinks). macOS: /var → /private/var.
    const rootPath = fs.realpathSync(path.resolve(projectDir));
    const files = await this.collectFiles(rootPath);

    // Phase 1.1: Combined validation + hashing (EVAL PERF-1 fix)
    // Single read per file instead of separate stat+validate+hash
    const fileEntries: FileHashEntry[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const f of files) {
      const result = this.hashAndValidateFile(rootPath, f);
      if (result.valid) {
        fileEntries.push(result.entry);
      } else {
        skipped.push({ path: path.relative(rootPath, f), reason: result.reason });
      }
    }
    if (skipped.length > 0) {
      log.info(`Skipped ${skipped.length} files`, { reasons: this.summarizeSkipReasons(skipped) });
    }

    // Phase 1.7: Warn about previously-indexed .env files
    this.warnAboutEnvFiles(fileEntries);

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

  /**
   * Phase 1.1: Combined validation + hashing — single read per file (EVAL PERF-1 fix).
   * Replaces the separate filter + hashFile pattern.
   */
  private hashAndValidateFile(
    rootPath: string, filePath: string
  ): { entry: FileHashEntry; valid: true } | { valid: false; reason: string } {
    // 1. stat check — size limit + isFile guard
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { valid: false, reason: "missing or inaccessible" };
    }
    if (!stat.isFile()) {
      return { valid: false, reason: "not a regular file (directory/gitlink)" };
    }
    if (stat.size > this.maxFileSizeBytes) {
      return { valid: false, reason: `size ${stat.size} > ${this.maxFileSizeBytes}` };
    }

    // 2. .env check (covers git-ls-files path which lacks walkDirectory's .env filter)
    const basename = path.basename(filePath);
    if (basename === ".env" || basename.startsWith(".env.")) {
      return { valid: false, reason: ".env file" };
    }

    // 3. Read file ONCE — use for both binary detection and SHA-256 hash
    const content = fs.readFileSync(filePath);

    // 4. Binary detection — check first 8KB for null bytes
    const checkLength = Math.min(content.length, 8192);
    for (let i = 0; i < checkLength; i++) {
      if (content[i] === 0) {
        return { valid: false, reason: "binary file (null bytes detected)" };
      }
    }

    // 5. Hash from the already-read buffer
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const relPath = this.normalizePath(path.relative(rootPath, filePath));
    return {
      valid: true,
      entry: { path: relPath, sha256, bytes: content.length },
    };
  }

  /**
   * Phase 1.1: Summarize skip reasons for logging (EVAL G-08 fix).
   */
  private summarizeSkipReasons(skipped: { path: string; reason: string }[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of skipped) {
      counts[s.reason] = (counts[s.reason] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Phase 1.7: Warn if any .env files were previously indexed (EVAL H3 fix).
   */
  private warnAboutEnvFiles(entries: FileHashEntry[]): void {
    const envFiles = entries.filter(e => {
      const basename = path.basename(e.path);
      return basename === ".env" || basename.startsWith(".env.");
    });
    if (envFiles.length > 0) {
      log.warn(`Found ${envFiles.length} .env file(s) in scan results — these should have been filtered. ` +
        `If previously indexed, run cleanup to remove from vector store.`,
        { files: envFiles.map(e => e.path) });
    }
  }

  private async collectFiles(rootPath: string): Promise<string[]> {
    if (this.useGitLsFiles) {
      const gitFiles = await this.tryGitLsFiles(rootPath);
      if (gitFiles !== null) {
        // Build effective ignore set: defaults + .gitignore + .pingmemignore patterns
        const effectiveIgnoreDirs = new Set(this.ignoreDirs);
        const ignorePathPrefixes: string[] = [];

        // Parse .gitignore and .pingmemignore for directory patterns
        for (const ignoreFile of [".gitignore", ".pingmemignore"]) {
          try {
            const content = fs.readFileSync(path.join(rootPath, ignoreFile), "utf-8");
            for (const line of content.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
              const cleaned = trimmed.replace(/^\//, "").replace(/\/+$/, "");
              if (!cleaned) continue;
              if (cleaned.includes("*") || cleaned.includes("?")) continue; // skip globs for now
              // If it contains a slash, treat as path prefix (e.g., "docs/knowledge-base")
              if (cleaned.includes("/")) {
                ignorePathPrefixes.push(cleaned);
              } else {
                effectiveIgnoreDirs.add(cleaned);
              }
            }
          } catch {
            // File doesn't exist — skip
          }
        }

        const preFilter = gitFiles.length;
        const filtered = gitFiles
          .filter(f => {
            // Filter out files in ignored directories or matching path prefixes
            const parts = f.split(path.sep);
            if (parts.some(part => effectiveIgnoreDirs.has(part))) return false;
            if (ignorePathPrefixes.some(prefix => f.startsWith(prefix))) return false;
            const ext = path.extname(f).toLowerCase();
            // Phase 1.3: Check compound extensions like .d.ts, .min.js, .min.css
            const compoundExt = this.getCompoundExtension(f);
            if (compoundExt && this.excludeExtensions.has(compoundExt)) return false;
            if (this.excludeExtensions.has(ext)) return false;
            if (this.includeExtensions && !this.includeExtensions.has(ext)) return false;
            return true;
          })
          .map(f => path.join(rootPath, f))
          .sort();
        const skipped = preFilter - filtered.length;
        log.info(`Using git ls-files: ${preFilter} tracked, ${skipped} filtered by ignore rules, ${filtered.length} to ingest`);
        return filtered;
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

  // Phase 1.5: Circular symlink protection via visited inode tracking
  private walkDirectory(rootPath: string): string[] {
    const results: string[] = [];
    const visitedDirs = new Set<string>();
    const walk = (current: string) => {
      // Resolve to real path to detect circular symlinks
      let realPath: string;
      try {
        realPath = fs.realpathSync(current);
      } catch {
        return; // Broken symlink — skip
      }
      if (visitedDirs.has(realPath)) {
        log.warn(`Circular symlink detected, skipping: ${current}`);
        return;
      }
      visitedDirs.add(realPath);

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
          // Phase 1.4: Nested git repo detection — skip directories containing .git
          try {
            fs.accessSync(path.join(fullPath, ".git"));
            log.info(`Skipping nested git repo: ${entry.name}/`);
            continue;
          } catch { /* not a git repo, continue */ }
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          // Phase 1.3: Check compound extensions like .d.ts, .min.js, .min.css
          const compoundExt = this.getCompoundExtension(entry.name);
          if (compoundExt && this.excludeExtensions.has(compoundExt)) {
            continue;
          }
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

  /**
   * Extract compound extension for files like .d.ts, .min.js, .min.css
   */
  private getCompoundExtension(fileName: string): string | null {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".d.ts")) return ".d.ts";
    if (lower.endsWith(".min.js")) return ".min.js";
    if (lower.endsWith(".min.css")) return ".min.css";
    return null;
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
