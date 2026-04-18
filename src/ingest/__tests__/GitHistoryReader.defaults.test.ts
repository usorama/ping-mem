/**
 * GitHistoryReader defaults + env-var override tests (Phase 2 remediation).
 *
 * Regression coverage:
 *   - DEFAULT_MAX_COMMITS raised 200 → 10000 (plan P2.1)
 *   - DEFAULT_MAX_COMMIT_AGE_DAYS raised 30 → 365 (plan P2.1)
 *   - env override accepts only non-negative integers; NaN/negative falls back
 *   - value 0 for age means "no age filter"
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  parseNonNegativeIntEnv,
  resolveDefaultMaxCommits,
  resolveDefaultMaxCommitAgeDays,
} from "../GitHistoryReader.js";

describe("GitHistoryReader defaults", () => {
  const originalMax = process.env.PING_MEM_MAX_COMMITS;
  const originalAge = process.env.PING_MEM_MAX_COMMIT_AGE_DAYS;

  afterEach(() => {
    // Restore env state between tests
    if (originalMax === undefined) delete process.env.PING_MEM_MAX_COMMITS;
    else process.env.PING_MEM_MAX_COMMITS = originalMax;
    if (originalAge === undefined) delete process.env.PING_MEM_MAX_COMMIT_AGE_DAYS;
    else process.env.PING_MEM_MAX_COMMIT_AGE_DAYS = originalAge;
  });

  describe("parseNonNegativeIntEnv", () => {
    test("returns fallback when raw is undefined", () => {
      expect(parseNonNegativeIntEnv(undefined, 42)).toBe(42);
    });
    test("returns fallback when raw is empty", () => {
      expect(parseNonNegativeIntEnv("", 42)).toBe(42);
    });
    test("parses a positive integer", () => {
      expect(parseNonNegativeIntEnv("500", 42)).toBe(500);
    });
    test("accepts zero", () => {
      expect(parseNonNegativeIntEnv("0", 42)).toBe(0);
    });
    test("returns fallback for negative", () => {
      expect(parseNonNegativeIntEnv("-5", 42)).toBe(42);
    });
    test("returns fallback for NaN / garbage", () => {
      expect(parseNonNegativeIntEnv("abc", 42)).toBe(42);
      expect(parseNonNegativeIntEnv("NaN", 42)).toBe(42);
    });
  });

  describe("resolveDefaultMaxCommits", () => {
    test("defaults to 10000 when env not set", () => {
      delete process.env.PING_MEM_MAX_COMMITS;
      expect(resolveDefaultMaxCommits()).toBe(10000);
    });
    test("reads PING_MEM_MAX_COMMITS when set to valid int", () => {
      process.env.PING_MEM_MAX_COMMITS = "50";
      expect(resolveDefaultMaxCommits()).toBe(50);
    });
    test("falls back to default on invalid PING_MEM_MAX_COMMITS", () => {
      process.env.PING_MEM_MAX_COMMITS = "not-a-number";
      expect(resolveDefaultMaxCommits()).toBe(10000);
    });
  });

  describe("resolveDefaultMaxCommitAgeDays", () => {
    test("defaults to 365 when env not set", () => {
      delete process.env.PING_MEM_MAX_COMMIT_AGE_DAYS;
      expect(resolveDefaultMaxCommitAgeDays()).toBe(365);
    });
    test("reads PING_MEM_MAX_COMMIT_AGE_DAYS when set to valid int", () => {
      process.env.PING_MEM_MAX_COMMIT_AGE_DAYS = "730";
      expect(resolveDefaultMaxCommitAgeDays()).toBe(730);
    });
    test("value 0 is honored (disables age filter)", () => {
      process.env.PING_MEM_MAX_COMMIT_AGE_DAYS = "0";
      expect(resolveDefaultMaxCommitAgeDays()).toBe(0);
    });
    test("falls back to default on invalid value", () => {
      process.env.PING_MEM_MAX_COMMIT_AGE_DAYS = "abc";
      expect(resolveDefaultMaxCommitAgeDays()).toBe(365);
    });
  });
});
