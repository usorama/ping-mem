import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { FileHashEntry, ProjectManifest, ProjectScanResult } from "./types.js";

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
]);

const MANIFEST_SCHEMA_VERSION = 1;

export interface ProjectScanOptions {
  ignoreDirs?: Set<string>;
  includeExtensions?: Set<string>;
}

export class ProjectScanner {
  private readonly ignoreDirs: Set<string>;
  private readonly includeExtensions: Set<string> | null;

  constructor(options: ProjectScanOptions = {}) {
    this.ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
    this.includeExtensions = options.includeExtensions ?? null;
  }

  scanProject(projectDir: string, previousManifest?: ProjectManifest): ProjectScanResult {
    const rootPath = path.resolve(projectDir);
    const files = this.collectFiles(rootPath);
    const fileEntries = files.map((filePath) =>
      this.hashFile(rootPath, filePath)
    );

    const treeHash = this.computeTreeHash(fileEntries);
    const projectId = this.computeProjectId(rootPath);

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

  private collectFiles(rootPath: string): string[] {
    const results: string[] = [];
    const walk = (current: string) => {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sorted) {
        if (entry.name.startsWith(".") && entry.name !== ".env") {
          // Keep deterministic handling of dotfiles, except .env
          if (this.ignoreDirs.has(entry.name)) {
            continue;
          }
        }
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (this.ignoreDirs.has(entry.name)) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile()) {
          if (this.includeExtensions) {
            const ext = path.extname(entry.name).toLowerCase();
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

  private computeProjectId(rootPath: string): string {
    const gitKey = this.getGitIdentity(rootPath);
    const input = gitKey ?? this.normalizePath(rootPath);
    return crypto.createHash("sha256").update(input).digest("hex");
  }

  private getGitIdentity(rootPath: string): string | null {
    try {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: rootPath,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      const remoteUrl = execSync("git config --get remote.origin.url", {
        cwd: gitRoot,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (remoteUrl) {
        return `${this.normalizePath(gitRoot)}::${remoteUrl}`;
      }
      return this.normalizePath(gitRoot);
    } catch {
      return null;
    }
  }

  private normalizePath(filePath: string): string {
    return filePath.split(path.sep).join(path.posix.sep);
  }
}
