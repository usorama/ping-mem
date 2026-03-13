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
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(inputPath));
  } catch {
    resolved = path.resolve(inputPath);
  }
  // Validate HOME: require absolute path of meaningful length (>= 5 chars)
  // to exclude system paths like /usr, /var, /opt, /tmp, /etc.
  const home = process.env["HOME"];
  const validHome = home && home.length >= 5 && path.isAbsolute(home) ? home : null;
  const allowedRoots = [...(validHome ? [validHome] : []), "/projects", "/Users", "/home"];
  return allowedRoots.some((root) => root && resolved.startsWith(root + path.sep));
}
