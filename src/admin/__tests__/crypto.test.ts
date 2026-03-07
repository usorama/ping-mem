/**
 * Tests for crypto module (AES-256-GCM encryption)
 *
 * @module admin/__tests__/crypto.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { encryptSecret, decryptSecret, getSecretKey } from "../crypto.js";
import type { EncryptedPayload } from "../crypto.js";

describe("crypto", () => {
  const TEST_SECRET = "test-secret-for-crypto-module";

  beforeEach(() => {
    process.env.PING_MEM_SECRET_KEY = TEST_SECRET;
  });

  afterEach(() => {
    delete process.env.PING_MEM_SECRET_KEY;
  });

  describe("getSecretKey", () => {
    test("should return a 32-byte buffer from env var", () => {
      const key = getSecretKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32); // SHA-256 always produces 32 bytes
    });

    test("should throw when PING_MEM_SECRET_KEY is not set", () => {
      delete process.env.PING_MEM_SECRET_KEY;
      expect(() => getSecretKey()).toThrow("Missing required environment variable: PING_MEM_SECRET_KEY");
    });
  });

  describe("encrypt / decrypt round-trip", () => {
    test("should encrypt and decrypt a plaintext string correctly", () => {
      const key = getSecretKey();
      const plaintext = "super-secret-api-key-12345";
      const encrypted = encryptSecret(plaintext, key);

      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.tag).toBeTruthy();

      const decrypted = decryptSecret(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    test("should handle empty string", () => {
      const key = getSecretKey();
      const encrypted = encryptSecret("", key);
      const decrypted = decryptSecret(encrypted, key);
      expect(decrypted).toBe("");
    });

    test("should handle unicode text", () => {
      const key = getSecretKey();
      const plaintext = "secret with unicode: \u00e9\u00e0\u00fc\u00f1 \u4e16\u754c";
      const encrypted = encryptSecret(plaintext, key);
      const decrypted = decryptSecret(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("uniqueness", () => {
    test("different plaintexts should produce different ciphertexts", () => {
      const key = getSecretKey();
      const enc1 = encryptSecret("plaintext-one", key);
      const enc2 = encryptSecret("plaintext-two", key);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });

    test("same plaintext encrypted twice should produce different ciphertexts (random IV)", () => {
      const key = getSecretKey();
      const enc1 = encryptSecret("same-text", key);
      const enc2 = encryptSecret("same-text", key);
      // Different IVs mean different ciphertexts
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });
  });

  describe("tamper detection", () => {
    test("tampered ciphertext should fail decryption", () => {
      const key = getSecretKey();
      const encrypted = encryptSecret("sensitive-data", key);

      // Tamper with the ciphertext by flipping a character
      const tampered: EncryptedPayload = {
        ...encrypted,
        ciphertext: encrypted.ciphertext.slice(0, -2) + "AA",
      };

      expect(() => decryptSecret(tampered, key)).toThrow();
    });

    test("tampered IV should fail decryption", () => {
      const key = getSecretKey();
      const encrypted = encryptSecret("sensitive-data", key);

      const tampered: EncryptedPayload = {
        ...encrypted,
        iv: encrypted.iv.slice(0, -2) + "AA",
      };

      expect(() => decryptSecret(tampered, key)).toThrow();
    });

    test("tampered auth tag should fail decryption", () => {
      const key = getSecretKey();
      const encrypted = encryptSecret("sensitive-data", key);

      const tampered: EncryptedPayload = {
        ...encrypted,
        tag: encrypted.tag.slice(0, -2) + "AA",
      };

      expect(() => decryptSecret(tampered, key)).toThrow();
    });
  });
});
