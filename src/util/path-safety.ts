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
 */
export function isProjectDirSafe(inputPath: string): boolean {
  // Canonicalize with realpathSync to resolve symlinks before the containment check.
  // Fall back to path.resolve for non-existent paths (symlink escapes only apply to existing paths).
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(inputPath));
  } catch {
    resolved = path.resolve(inputPath);
  }
  // Validate HOME before including: HOME='/' or an unusually short value
  // would expand the allowed set to the entire filesystem, enabling path traversal.
  // Require HOME to be an absolute path of meaningful length (> 3 chars).
  const home = process.env["HOME"];
  const validHome = home && home.length > 3 && path.isAbsolute(home) ? home : null;
  const allowedRoots = [...(validHome ? [validHome] : []), "/projects", "/Users", "/home"];
  return allowedRoots.some((root) => root && resolved.startsWith(root + path.sep));
}
