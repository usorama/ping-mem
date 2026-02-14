import { describe, it, expect, beforeEach } from "bun:test";
import { SafeGit, createSafeGit } from "../SafeGit.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

describe("SafeGit.getFileContent path traversal protection", () => {
  let testRepoPath: string;
  let git: SafeGit;
  let commitHash: string;

  beforeEach(async () => {
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "safegit-path-test-"));
    const { execFileSync } = await import("child_process");
    execFileSync("git", ["init"], { cwd: testRepoPath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: testRepoPath });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: testRepoPath });

    fs.writeFileSync(path.join(testRepoPath, "README.md"), "# Test\n");
    fs.mkdirSync(path.join(testRepoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(testRepoPath, "src", "index.ts"), "export {};\n");
    execFileSync("git", ["add", "."], { cwd: testRepoPath });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: testRepoPath });

    commitHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: testRepoPath }).toString().trim();
    git = createSafeGit(testRepoPath);
  });

  it("should reject file paths containing ../", async () => {
    await expect(git.getFileContent(commitHash, "../../../etc/passwd")).rejects.toThrow(/path traversal/i);
    await expect(git.getFileContent(commitHash, "src/../../etc/passwd")).rejects.toThrow(/path traversal/i);
    await expect(git.getFileContent(commitHash, "../secret")).rejects.toThrow(/path traversal/i);
  });

  it("should reject absolute file paths", async () => {
    await expect(git.getFileContent(commitHash, "/etc/passwd")).rejects.toThrow(/absolute paths/i);
    await expect(git.getFileContent(commitHash, "/tmp/secret")).rejects.toThrow(/absolute paths/i);
  });

  it("should allow legitimate relative file paths", async () => {
    const content = await git.getFileContent(commitHash, "README.md");
    expect(content).toBe("# Test\n");
  });

  it("should allow nested relative file paths", async () => {
    const content = await git.getFileContent(commitHash, "src/index.ts");
    expect(content).toBe("export {};\n");
  });
});
