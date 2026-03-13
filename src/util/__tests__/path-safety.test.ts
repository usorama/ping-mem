/**
 * Tests for path-safety.ts — isProjectDirSafe
 *
 * @module util/__tests__/path-safety.test
 */

import { describe, test, expect, afterEach } from "bun:test";
import { isProjectDirSafe } from "../path-safety.js";

// These tests use paths that don't exist on the test machine (e.g., /custom-home),
// so fs.realpathSync falls back to path.resolve — which is the intended code path.
describe("isProjectDirSafe", () => {
  const originalHome = process.env["HOME"];

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env["HOME"] = originalHome;
    } else {
      delete process.env["HOME"];
    }
  });

  describe("allowed roots", () => {
    test("allows paths under /Users", () => {
      expect(isProjectDirSafe("/Users/someone/myrepo")).toBe(true);
    });

    test("allows paths under /home", () => {
      expect(isProjectDirSafe("/home/ubuntu/myrepo")).toBe(true);
    });

    test("allows paths under /projects", () => {
      expect(isProjectDirSafe("/projects/myrepo")).toBe(true);
    });

    test("allows paths under HOME when HOME is valid", () => {
      process.env["HOME"] = "/custom-home";
      expect(isProjectDirSafe("/custom-home/myrepo")).toBe(true);
    });
  });

  describe("denied paths", () => {
    test("rejects /etc, /var, /root, /tmp", () => {
      expect(isProjectDirSafe("/etc/passwd")).toBe(false);
      expect(isProjectDirSafe("/var/log/syslog")).toBe(false);
      expect(isProjectDirSafe("/root/.ssh")).toBe(false);
      expect(isProjectDirSafe("/tmp/sandbox")).toBe(false);
    });

    test("rejects path traversal", () => {
      expect(isProjectDirSafe("/Users/someone/../../../etc/passwd")).toBe(false);
      expect(isProjectDirSafe("/projects/../etc/passwd")).toBe(false);
    });

    test("rejects bare roots without subdirectory", () => {
      expect(isProjectDirSafe("/Users")).toBe(false);
      expect(isProjectDirSafe("/home")).toBe(false);
      expect(isProjectDirSafe("/projects")).toBe(false);
      expect(isProjectDirSafe("/tmp")).toBe(false);
    });
  });

  describe("HOME validation", () => {
    test("rejects short HOME (< 5 chars) like /usr", () => {
      process.env["HOME"] = "/usr";
      // /usr is only 4 chars, so it should not be added as an allowed root
      expect(isProjectDirSafe("/usr/local/something")).toBe(false);
    });

    test("rejects HOME = /root (deny-listed)", () => {
      process.env["HOME"] = "/root";
      expect(isProjectDirSafe("/root/myrepo")).toBe(false);
    });

    test("does not use relative HOME as allowed root", () => {
      process.env["HOME"] = "relative/path";
      // relative path is not absolute, so HOME should not be used as an allowed root.
      // Paths under /etc should still be rejected regardless.
      expect(isProjectDirSafe("/etc/passwd")).toBe(false);
    });

    test("handles undefined HOME gracefully", () => {
      delete process.env["HOME"];
      // Should still allow /Users, /home, /projects
      expect(isProjectDirSafe("/Users/someone/repo")).toBe(true);
      expect(isProjectDirSafe("/etc/passwd")).toBe(false);
    });

    test("rejects bare HOME without subdirectory", () => {
      process.env["HOME"] = "/custom-home";
      expect(isProjectDirSafe("/custom-home")).toBe(false);
    });

    test("rejects traversal from valid HOME", () => {
      process.env["HOME"] = "/custom-home";
      expect(isProjectDirSafe("/custom-home/../etc/passwd")).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("rejects empty string", () => {
      expect(isProjectDirSafe("")).toBe(false);
    });

    test("rejects whitespace-only input", () => {
      expect(isProjectDirSafe("   ")).toBe(false);
    });
  });

  describe("DENIED_ROOTS coverage", () => {
    test("rejects all DENIED_ROOTS entries as HOME", () => {
      const deniedRoots = [
        "/root", "/tmp", "/proc", "/sys", "/dev", "/boot", "/sbin", "/bin",
        "/snap", "/run", "/srv", "/mnt", "/media", "/lost+found",
        "/var/tmp", "/private/tmp",
      ];
      for (const root of deniedRoots) {
        process.env["HOME"] = root;
        expect(isProjectDirSafe(`${root}/subdir`)).toBe(false);
      }
    });

    test("rejects /var/tmp and /private/tmp regardless of HOME", () => {
      delete process.env["HOME"];
      expect(isProjectDirSafe("/var/tmp/sandbox")).toBe(false);
      expect(isProjectDirSafe("/private/tmp/sandbox")).toBe(false);
    });
  });
});
