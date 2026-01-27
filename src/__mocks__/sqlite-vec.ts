/**
 * Mock for sqlite-vec in test environment
 *
 * This mock provides a no-op load function since the actual sqlite-vec
 * extension cannot be loaded in Jest test environment (macOS SQLite
 * doesn't support dynamic extension loading).
 *
 * The bun:sqlite mock handles vec0 virtual table operations.
 */

/**
 * Mock load function - no-op in test environment
 * In real code, this loads the sqlite-vec extension into the database
 */
export function load(_db: unknown): void {
  // No-op in test environment
  // The bun:sqlite mock handles vec0 virtual table operations
}

export default {
  load,
};
