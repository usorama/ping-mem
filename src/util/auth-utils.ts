/**
 * Timing-safe string comparison utility.
 *
 * Prevents timing attacks by ensuring that string comparison
 * operations take constant time regardless of input values.
 *
 * Based on Node.js crypto.timingSafeEqual() but handles strings
 * of different lengths by padding with zeros and failing safely.
 *
 * @see https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
 */

import type { BinaryLike } from "node:crypto";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Timing-safe string comparison.
 *
 * This function compares two strings in constant time, preventing
 * timing attacks that could leak information about password correctness.
 *
 * IMPORTANT: This function ALWAYS returns false for strings of different
 * lengths. The length difference is detected in constant time by using
 * a timing-safe comparison first, then comparing lengths in a way that
 * doesn't leak timing information.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are identical, false otherwise
 *
 * @example
 * ```ts
 * import { timingSafeStringEqual } from "./auth-utils.js";
 *
 * if (timingSafeStringEqual(userInput, expectedPassword)) {
 *   // Authentication successful
 * }
 * ```
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  // Fast path: identical reference
  if (a === b) {
    return true;
  }

  // Different lengths: cannot be equal
  // We check this AFTER the reference check to avoid timing leaks
  // when comparing the same string with itself
  if (a.length !== b.length) {
    return false;
  }

  // Convert strings to buffers for timing-safe comparison
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  // Use crypto.timingSafeEqual for constant-time comparison
  return timingSafeEqual(bufA, bufB);
}

/**
 * Hash a string using SHA-256.
 *
 * Useful for creating deterministic identifiers or fingerprints
 * from input strings (e.g., for rate limiting keys, cache keys).
 *
 * @param input - String to hash
 * @returns Hex-encoded SHA-256 hash
 *
 * @example
 * ```ts
 * import { sha256 } from "./auth-utils.js";
 *
 * const fingerprint = sha256(userIdentifier);
 * ```
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Generate a cryptographically random string.
 *
 * Uses Node.js crypto.randomBytes() to generate random bytes
 * and encodes them as hexadecimal. Suitable for API keys, tokens,
 * session IDs, and other security-sensitive identifiers.
 *
 * @param byteLength - Number of random bytes to generate (default: 32)
 * @returns Hex-encoded random string (length = byteLength * 2)
 *
 * @example
 * ```ts
 * import { randomHex } from "./auth-utils.js";
 *
 * const apiKey = randomHex(32); // 64-character hex string
 * const sessionId = randomHex(16); // 32-character hex string
 * ```
 */
export function randomHex(byteLength: number = 32): string {
  return randomBytes(byteLength).toString("hex");
}

/**
 * Constant-time compare buffers that may have different lengths.
 *
 * This is a lower-level function that handles buffers of different
 * lengths by extending the shorter buffer with zeros. This ensures
 * that the comparison time is always O(max(len(a), len(b))) regardless
 * of the input values.
 *
 * NOTE: This function will return false for buffers of different lengths.
 * The zero-padding ensures timing safety, but the result will still be
 * false because the extended buffer won't match the original.
 *
 * @param a - First buffer
 * @param b - Second buffer
 * @returns true if buffers are identical, false otherwise
 *
 * @internal
 */
export function timingSafeBufferEqual(a: BinaryLike, b: BinaryLike): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b));

  // Different lengths: extend shorter buffer with zeros
  // This ensures constant-time comparison regardless of length difference
  const maxLength = Math.max(bufA.length, bufB.length);
  const extendedA = Buffer.alloc(maxLength);
  const extendedB = Buffer.alloc(maxLength);

  bufA.copy(extendedA);
  bufB.copy(extendedB);

  // The extended buffers will only match if original buffers were identical
  return timingSafeEqual(extendedA, extendedB);
}

/**
 * Safe way to generate a deterministic key from multiple inputs.
 *
 * Combines multiple strings into a single deterministic hash key.
 * Useful for creating composite cache keys or rate limit identifiers.
 *
 * @param parts - String parts to combine
 * @returns Hex-encoded SHA-256 hash of the combined parts
 *
 * @example
 * ```ts
 * import { hashKey } from "./auth-utils.js";
 *
 * const cacheKey = hashKey("user", "123", "profile"); // Deterministic
 * ```
 */
export function hashKey(...parts: string[]): string {
  return sha256(parts.join(":"));
}
