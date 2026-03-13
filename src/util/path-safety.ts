/**
 * Path safety utilities for project directory validation.
 *
 * Shared between rest-server.ts and admin.ts to avoid logic duplication.
 *
 * @module util/path-safety
 */

import * as fs from "fs";
import * as path from "path";

/**
 * System paths that must never be used as allowed roots, even if they
 * pass the length check. Includes:
 * - /root: root user's home directory (5 chars, passes length check)
 * - /tmp: world-writable on POSIX (explicit deny, not just length-based)
 * - /proc, /sys, /dev: kernel pseudo-filesystems
 * - /boot, /sbin, /bin: system binaries
 * - /snap, /run, /srv, /mnt, /media: system mount points
 * - /lost+found: ext filesystem recovery directory
 * - /var/tmp, /private/tmp: alternative temp directories (macOS, Linux)
 */
const DENIED_ROOTS = new Set([
  "/root", "/tmp", "/proc", "/sys", "/dev", "/boot", "/sbin", "/bin",
  "/snap", "/run", "/srv", "/mnt", "/media", "/lost+found",
  "/var/tmp", "/private/tmp",
]);

/**
 * Checks whether a resolved projectDir is within an allowed root.
 * Excludes /tmp (world-writable) and validates HOME length to prevent
 * filesystem-wide traversal. Uses fs.realpathSync to canonicalize symlinks
 * before the containment check, preventing symlink escapes.
 *
 * When realpathSync fails (path does not exist), falls back to path.resolve.
 * This is safe because non-existent paths cannot host symlink targets, and
 * actual file operations (ingestion, deletion) will resolve symlinks at
 * access time. The check here is a first-pass gatekeeper.
 */
export function isProjectDirSafe(inputPath: string): boolean {
  if (!inputPath || inputPath.trim().length === 0) return false;
  // Reject null bytes — can truncate paths in C-based syscalls, bypassing containment checks
  if (inputPath.includes("\0")) return false;

  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(inputPath));
  } catch {
    resolved = path.resolve(inputPath);
  }
  // Validate HOME: require absolute path of meaningful length (>= 5 chars)
  // to exclude system paths like /usr, /var, /opt, /tmp, /etc.
  // Additionally deny-listed paths (/root) are excluded even if they pass
  // the length check.
  const home = process.env["HOME"];
  const validHome =
    home && home.length >= 5 && path.isAbsolute(home) && !DENIED_ROOTS.has(home) ? home : null;
  const allowedRoots = [...(validHome ? [validHome] : []), "/projects", "/Users", "/home"];
  // Normalize root to ensure trailing separator (handles HOME="/custom-home/" edge case)
  return allowedRoots.some((root) => {
    const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
    return resolved.startsWith(normalizedRoot);
  });
}
