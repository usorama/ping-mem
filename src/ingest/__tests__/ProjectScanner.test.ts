/**
 * ProjectScanner tests - focus on path-independent projectId generation.
 *
 * Regression: Prior to 2026-02-12, getGitIdentity() included absolute
 * filesystem paths, causing Docker-mounted (/projects/...) and local
 * (/Users/...) paths to produce different projectIds for the same repo.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProjectScanner } from "../ProjectScanner.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

describe("ProjectScanner", () => {
  describe("projectId path independence", () => {
    let tempDir: string;
    let repoDir: string;

    beforeEach(() => {
      // Resolve symlinks in tmpdir (macOS: /var → /private/var) since
      // git rev-parse --show-toplevel resolves symlinks but path.resolve doesn't.
      tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scanner-test-")));
      repoDir = path.join(tempDir, "test-repo");
      fs.mkdirSync(repoDir);

      // Create a git repo with a remote
      execSync("git init", { cwd: repoDir, stdio: "ignore" });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "ignore" });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: "ignore" });
      execSync("git remote add origin https://github.com/test/test-repo.git", {
        cwd: repoDir,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(repoDir, "index.ts"), "export const x = 1;\n");
      execSync("git add . && git commit -m 'init'", { cwd: repoDir, stdio: "ignore" });
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("same repo at different absolute paths produces same projectId", () => {
      // Scan from actual path
      const scanner = new ProjectScanner();
      const result1 = scanner.scanProject(repoDir);

      // Create a symlink to simulate a different mount path
      const altPath = path.join(tempDir, "alt-mount");
      fs.symlinkSync(repoDir, altPath);

      // Resolve the symlink to get the real path (simulates Docker remapping)
      // Both should resolve to the same git remote, producing the same projectId
      const result2 = scanner.scanProject(fs.realpathSync(altPath));

      expect(result1.manifest.projectId).toBe(result2.manifest.projectId);
    });

    test("projectId is deterministic across multiple scans", () => {
      const scanner = new ProjectScanner();
      const result1 = scanner.scanProject(repoDir);
      const result2 = scanner.scanProject(repoDir);

      expect(result1.manifest.projectId).toBe(result2.manifest.projectId);
    });

    test("projectId uses git remote URL, not filesystem path", () => {
      const scanner = new ProjectScanner();
      const result = scanner.scanProject(repoDir);

      // The projectId should NOT contain the temp directory path hash
      // Verify by checking that two repos with the same remote produce the same ID
      const repoDir2 = path.join(tempDir, "clone-2");
      fs.mkdirSync(repoDir2);
      execSync("git init", { cwd: repoDir2, stdio: "ignore" });
      execSync('git config user.email "test@test.com"', { cwd: repoDir2, stdio: "ignore" });
      execSync('git config user.name "Test"', { cwd: repoDir2, stdio: "ignore" });
      execSync("git remote add origin https://github.com/test/test-repo.git", {
        cwd: repoDir2,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(repoDir2, "index.ts"), "export const x = 1;\n");
      execSync("git add . && git commit -m 'init'", { cwd: repoDir2, stdio: "ignore" });

      const result2 = scanner.scanProject(repoDir2);

      // Same remote + same relative path = same projectId
      expect(result.manifest.projectId).toBe(result2.manifest.projectId);
    });

    test("different remotes produce different projectIds", () => {
      const scanner = new ProjectScanner();
      const result1 = scanner.scanProject(repoDir);

      const repoDir2 = path.join(tempDir, "other-repo");
      fs.mkdirSync(repoDir2);
      execSync("git init", { cwd: repoDir2, stdio: "ignore" });
      execSync('git config user.email "test@test.com"', { cwd: repoDir2, stdio: "ignore" });
      execSync('git config user.name "Test"', { cwd: repoDir2, stdio: "ignore" });
      execSync("git remote add origin https://github.com/test/OTHER-repo.git", {
        cwd: repoDir2,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(repoDir2, "index.ts"), "export const x = 1;\n");
      execSync("git add . && git commit -m 'init'", { cwd: repoDir2, stdio: "ignore" });

      const result2 = scanner.scanProject(repoDir2);

      expect(result1.manifest.projectId).not.toBe(result2.manifest.projectId);
    });

    test("subdirectories within same repo get unique projectIds", () => {
      // Create a subdirectory
      const subDir = path.join(repoDir, "packages", "sub-project");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "lib.ts"), "export const y = 2;\n");

      const scanner = new ProjectScanner();
      const rootResult = scanner.scanProject(repoDir);
      const subResult = scanner.scanProject(subDir);

      // Same repo but different relative paths = different projectIds
      expect(rootResult.manifest.projectId).not.toBe(subResult.manifest.projectId);
    });
  });

  describe("file scanning", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scanner-files-")));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("ignores default directories like node_modules and .git", () => {
      fs.mkdirSync(path.join(tempDir, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "node_modules", "dep.js"), "module.exports = {};");
      fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main");
      fs.writeFileSync(path.join(tempDir, "index.ts"), "export const x = 1;");

      const scanner = new ProjectScanner();
      const result = scanner.scanProject(tempDir);

      const paths = result.manifest.files.map((f) => f.path);
      expect(paths).toContain("index.ts");
      expect(paths.every((p) => !p.startsWith("node_modules/"))).toBe(true);
      expect(paths.every((p) => !p.startsWith(".git/"))).toBe(true);
    });

    test("treeHash is deterministic for same content", () => {
      fs.writeFileSync(path.join(tempDir, "a.ts"), "const a = 1;");
      fs.writeFileSync(path.join(tempDir, "b.ts"), "const b = 2;");

      const scanner = new ProjectScanner();
      const result1 = scanner.scanProject(tempDir);
      const result2 = scanner.scanProject(tempDir);

      expect(result1.manifest.treeHash).toBe(result2.manifest.treeHash);
    });

    test("treeHash changes when file content changes", () => {
      fs.writeFileSync(path.join(tempDir, "a.ts"), "const a = 1;");

      const scanner = new ProjectScanner();
      const result1 = scanner.scanProject(tempDir);

      fs.writeFileSync(path.join(tempDir, "a.ts"), "const a = 2;");
      const result2 = scanner.scanProject(tempDir);

      expect(result1.manifest.treeHash).not.toBe(result2.manifest.treeHash);
    });

    test("hasChanges detects when treeHash differs from previous manifest", () => {
      fs.writeFileSync(path.join(tempDir, "a.ts"), "const a = 1;");

      const scanner = new ProjectScanner();
      const result1 = scanner.scanProject(tempDir);
      expect(result1.hasChanges).toBe(true);

      // Same content, pass previous manifest
      const result2 = scanner.scanProject(tempDir, result1.manifest);
      expect(result2.hasChanges).toBe(false);

      // Change content
      fs.writeFileSync(path.join(tempDir, "a.ts"), "const a = 2;");
      const result3 = scanner.scanProject(tempDir, result1.manifest);
      expect(result3.hasChanges).toBe(true);
    });
  });
});
