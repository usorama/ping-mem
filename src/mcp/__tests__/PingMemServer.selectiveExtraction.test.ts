/**
 * Tests for selective extraction routing in PingMemServer.handleSave.
 *
 * Imports the actual production function from extractionRouting.ts
 * rather than testing a local copy.
 */
import { describe, it, expect } from "bun:test";
import { shouldUseLlmExtraction } from "../extractionRouting.js";

describe("Selective Extraction Routing Logic", () => {
  it("should route decision category to LLM", () => {
    expect(shouldUseLlmExtraction("decision", 50, false)).toBe(true);
  });

  it("should route error category to LLM", () => {
    expect(shouldUseLlmExtraction("error", 50, false)).toBe(true);
  });

  it("should route task category to LLM", () => {
    expect(shouldUseLlmExtraction("task", 50, false)).toBe(true);
  });

  it("should route note category < 500 chars to regex", () => {
    expect(shouldUseLlmExtraction("note", 50, false)).toBe(false);
  });

  it("should route medium content (250 chars) to regex when no special category", () => {
    expect(shouldUseLlmExtraction("note", 250, false)).toBe(false);
  });

  it("should route long content (> 500 chars) to LLM regardless of category", () => {
    expect(shouldUseLlmExtraction("note", 550, false)).toBe(true);
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
