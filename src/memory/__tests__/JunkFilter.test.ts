/**
 * Tests for JunkFilter quality gate
 * @module memory/__tests__/JunkFilter.test
 */

import { describe, it, expect } from "@jest/globals";
import { JunkFilter } from "../JunkFilter.js";

describe("JunkFilter", () => {
  const filter = new JunkFilter();

  describe("rejects junk content", () => {
    it("rejects empty string", () => {
      expect(filter.isJunk("").junk).toBe(true);
    });

    it("rejects all whitespace", () => {
      expect(filter.isJunk("   \n\t  ").junk).toBe(true);
      expect(filter.isJunk("   \n\t  ").reason).toBe("empty content");
    });

    it("rejects too short content", () => {
      expect(filter.isJunk("short").junk).toBe(true);
      expect(filter.isJunk("hi there").junk).toBe(true);
    });

    it("rejects generic filler", () => {
      expect(filter.isJunk("hello world").junk).toBe(true);
      expect(filter.isJunk("TODO").junk).toBe(true);
      expect(filter.isJunk("asdf").junk).toBe(true);
      expect(filter.isJunk("test").junk).toBe(true);
    });

    it("rejects bare URLs", () => {
      expect(filter.isJunk("https://example.com/some/path").junk).toBe(true);
      expect(filter.isJunk("http://localhost:3003/health").junk).toBe(true);
    });

    it("rejects repetitive single char", () => {
      expect(filter.isJunk("aaaaaaaaaaaaa").junk).toBe(true);
    });

    it("rejects repetitive words", () => {
      expect(filter.isJunk("test test test test test").junk).toBe(true);
    });
  });

  describe("accepts valid content", () => {
    it("accepts meaningful content", () => {
      expect(filter.isJunk("The database uses port 3003 for connections").junk).toBe(false);
    });

    it("accepts URLs with context", () => {
      expect(filter.isJunk("Check the docs at https://example.com/docs for more info").junk).toBe(false);
    });

    it("accepts short but varied content", () => {
      expect(filter.isJunk("Use port 3003 always").junk).toBe(false);
    });

    it("accepts decisions", () => {
      expect(filter.isJunk("We decided to use bun test instead of vitest for all testing").junk).toBe(false);
    });
  });
});
