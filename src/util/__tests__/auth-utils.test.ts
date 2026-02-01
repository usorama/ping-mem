/**
 * Tests for auth-utils module
 *
 * @module util/__tests__/auth-utils.test
 */

import { describe, it, expect } from "@jest/globals";
import {
  timingSafeStringEqual,
  sha256,
  randomHex,
  timingSafeBufferEqual,
  hashKey,
} from "../auth-utils.js";

describe("auth-utils", () => {
  // ========================================================================
  // timingSafeStringEqual
  // ========================================================================

  describe("timingSafeStringEqual", () => {
    it("should return true for identical strings", () => {
      const a = "correct-password";
      const b = "correct-password";
      expect(timingSafeStringEqual(a, b)).toBe(true);
    });

    it("should return false for different strings of same length", () => {
      const a = "correct-password";
      const b = "corregt-password"; // One character different
      expect(timingSafeStringEqual(a, b)).toBe(false);
    });

    it("should return false for strings of different lengths", () => {
      const a = "password";
      const b = "password123";
      expect(timingSafeStringEqual(a, b)).toBe(false);
    });

    it("should return true for empty strings", () => {
      expect(timingSafeStringEqual("", "")).toBe(true);
    });

    it("should return false when one string is empty", () => {
      expect(timingSafeStringEqual("password", "")).toBe(false);
      expect(timingSafeStringEqual("", "password")).toBe(false);
    });

    it("should handle special characters", () => {
      const a = "p@ssw0rd!#$%^&*()";
      const b = "p@ssw0rd!#$%^&*()";
      expect(timingSafeStringEqual(a, b)).toBe(true);
    });

    it("should handle unicode characters", () => {
      const a = "パスワード123";
      const b = "パスワード123";
      expect(timingSafeStringEqual(a, b)).toBe(true);
    });

    it("should return false for unicode strings that differ", () => {
      const a = "パスワード123";
      const b = "パスワード456";
      expect(timingSafeStringEqual(a, b)).toBe(false);
    });

    it("should handle strings with only whitespace", () => {
      const a = "   ";
      const b = "   ";
      expect(timingSafeStringEqual(a, b)).toBe(true);
    });

    it("should be symmetric (a,b equals b,a)", () => {
      const a = "test-string";
      const b = "test-string";
      expect(timingSafeStringEqual(a, b)).toBe(timingSafeStringEqual(b, a));
    });

    it("should return false when only case differs", () => {
      expect(timingSafeStringEqual("Password", "password")).toBe(false);
      expect(timingSafeStringEqual("PASSWORD", "password")).toBe(false);
    });

    it("should handle very long strings", () => {
      const a = "a".repeat(10000);
      const b = "a".repeat(10000);
      expect(timingSafeStringEqual(a, b)).toBe(true);
    });

    it("should handle very long strings that differ at the end", () => {
      const a = "a".repeat(9999) + "b";
      const b = "a".repeat(9999) + "c";
      expect(timingSafeStringEqual(a, b)).toBe(false);
    });
  });

  // ========================================================================
  // sha256
  // ========================================================================

  describe("sha256", () => {
    it("should produce consistent hashes for same input", () => {
      const input = "test-input";
      const hash1 = sha256(input);
      const hash2 = sha256(input);
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different inputs", () => {
      const hash1 = sha256("input1");
      const hash2 = sha256("input2");
      expect(hash1).not.toBe(hash2);
    });

    it("should produce 64-character hex string", () => {
      const hash = sha256("test");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should handle empty string", () => {
      const hash = sha256("");
      expect(hash).toHaveLength(64);
      // Known SHA-256 of empty string
      expect(hash).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("should handle special characters", () => {
      const hash = sha256("p@ss!#$%^&*()");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should handle unicode", () => {
      const hash = sha256("パスワード");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce known hash for known input", () => {
      // SHA-256 of "abc" is a known test vector
      const hash = sha256("abc");
      expect(hash).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
      );
    });
  });

  // ========================================================================
  // randomHex
  // ========================================================================

  describe("randomHex", () => {
    it("should produce strings of correct length with default 32 bytes", () => {
      const hex = randomHex();
      expect(hex).toHaveLength(64); // 32 bytes * 2
      expect(hex).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce strings of correct length with custom byte length", () => {
      const hex = randomHex(16);
      expect(hex).toHaveLength(32); // 16 bytes * 2
      expect(hex).toMatch(/^[a-f0-9]{32}$/);
    });

    it("should produce different values on each call", () => {
      const values = new Set<string>();
      for (let i = 0; i < 100; i++) {
        values.add(randomHex(8));
      }
      // With 100 calls of 8 bytes (16 hex chars), we should get very few if any collisions
      expect(values.size).toBeGreaterThan(95);
    });

    it("should handle byte length of 1", () => {
      const hex = randomHex(1);
      expect(hex).toHaveLength(2); // 1 byte * 2
      expect(hex).toMatch(/^[a-f0-9]{2}$/);
    });

    it("should handle large byte lengths", () => {
      const hex = randomHex(128);
      expect(hex).toHaveLength(256); // 128 bytes * 2
      expect(hex).toMatch(/^[a-f0-9]{256}$/);
    });
  });

  // ========================================================================
  // timingSafeBufferEqual
  // ========================================================================

  describe("timingSafeBufferEqual", () => {
    it("should return true for identical buffers", () => {
      const a = Buffer.from("test-data");
      const b = Buffer.from("test-data");
      expect(timingSafeBufferEqual(a, b)).toBe(true);
    });

    it("should return false for different buffers of same length", () => {
      const a = Buffer.from("test-data");
      const b = Buffer.from("test-date");
      expect(timingSafeBufferEqual(a, b)).toBe(false);
    });

    it("should return false for buffers of different lengths", () => {
      const a = Buffer.from("test");
      const b = Buffer.from("test123");
      expect(timingSafeBufferEqual(a, b)).toBe(false);
    });

    it("should handle BinaryLike inputs (strings)", () => {
      const a = "test-data";
      const b = "test-data";
      expect(timingSafeBufferEqual(a, b)).toBe(true);
    });

    it("should handle empty buffers", () => {
      const a = Buffer.alloc(0);
      const b = Buffer.alloc(0);
      expect(timingSafeBufferEqual(a, b)).toBe(true);
    });

    it("should return false when one buffer is empty", () => {
      const a = Buffer.from("data");
      const b = Buffer.alloc(0);
      expect(timingSafeBufferEqual(a, b)).toBe(false);
    });

    it("should handle Uint8Array", () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(timingSafeBufferEqual(a, b)).toBe(true);
    });
  });

  // ========================================================================
  // hashKey
  // ========================================================================

  describe("hashKey", () => {
    it("should produce consistent hash for same parts in same order", () => {
      const key1 = hashKey("user", "123", "profile");
      const key2 = hashKey("user", "123", "profile");
      expect(key1).toBe(key2);
    });

    it("should produce different hash for different parts", () => {
      const key1 = hashKey("user", "123", "profile");
      const key2 = hashKey("user", "456", "profile");
      expect(key1).not.toBe(key2);
    });

    it("should produce different hash for different order", () => {
      const key1 = hashKey("a", "b", "c");
      const key2 = hashKey("c", "b", "a");
      expect(key1).not.toBe(key2);
    });

    it("should produce 64-character hex string", () => {
      const key = hashKey("test");
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should handle single part", () => {
      const key = hashKey("single");
      expect(key).toHaveLength(64);
    });

    it("should handle empty parts", () => {
      const key = hashKey("a", "", "c");
      expect(key).toHaveLength(64);
    });

    it("should handle no parts (empty string)", () => {
      const key = hashKey();
      expect(key).toHaveLength(64);
      // Should match SHA-256 of empty string
      expect(key).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("should handle special characters in parts", () => {
      const key = hashKey("user@domain", "path:/api/v1", "key:value");
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ========================================================================
  // Security Edge Cases
  // ========================================================================

  describe("Security Edge Cases", () => {
    it("should handle null bytes in strings", () => {
      const a = "test\x00password";
      const b = "test\x00password";
      expect(timingSafeStringEqual(a, b)).toBe(true);
    });

    it("should not match strings with null bytes in different positions", () => {
      const a = "test\x00password";
      const b = "testp\x00assword";
      expect(timingSafeStringEqual(a, b)).toBe(false);
    });

    it("should handle strings that look similar but aren't", () => {
      // Similar-looking but different characters (same byte length)
      expect(timingSafeStringEqual("password", "passw0rd")).toBe(false); // Zero vs O
      expect(timingSafeStringEqual("test", "Test")).toBe(false); // Case difference
      expect(timingSafeStringEqual("admin1", "adminI")).toBe(false); // 1 vs I
      expect(timingSafeStringEqual("admin0", "adminO")).toBe(false); // 0 vs O
    });

    it("should handle very long same prefixes that differ at end", () => {
      const prefix = "a".repeat(9999);
      expect(timingSafeStringEqual(prefix + "b", prefix + "c")).toBe(false);
    });
  });
});
