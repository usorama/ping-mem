/**
 * Tests for selective extraction routing in PingMemServer.handleSave
 */
import { describe, it, expect } from "bun:test";

describe("Selective Extraction Routing Logic", () => {
  // Test the routing logic in isolation (without full PingMemServer instantiation)

  function shouldUseLlmExtraction(
    category: string | undefined,
    contentLength: number,
    explicitExtract: boolean
  ): boolean {
    return (
      (category !== undefined && ["decision", "error", "task"].includes(category)) ||
      contentLength > 200 ||
      explicitExtract
    );
  }

  it("should route decision category to LLM", () => {
    expect(shouldUseLlmExtraction("decision", 50, false)).toBe(true);
  });

  it("should route error category to LLM", () => {
    expect(shouldUseLlmExtraction("error", 50, false)).toBe(true);
  });

  it("should route task category to LLM", () => {
    expect(shouldUseLlmExtraction("task", 50, false)).toBe(true);
  });

  it("should route note category < 200 chars to regex", () => {
    expect(shouldUseLlmExtraction("note", 50, false)).toBe(false);
  });

  it("should route long content (> 200 chars) to LLM regardless of category", () => {
    expect(shouldUseLlmExtraction("note", 250, false)).toBe(true);
  });

  it("should route explicit extractEntities to LLM", () => {
    expect(shouldUseLlmExtraction(undefined, 50, true)).toBe(true);
  });

  it("should use regex for short content with no special category", () => {
    expect(shouldUseLlmExtraction("progress", 100, false)).toBe(false);
  });

  it("should use regex for undefined category with short content", () => {
    expect(shouldUseLlmExtraction(undefined, 100, false)).toBe(false);
  });
});
