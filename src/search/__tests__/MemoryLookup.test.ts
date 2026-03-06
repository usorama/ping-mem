import { describe, it, expect } from "bun:test";
import type { MemoryLookup } from "../MemoryLookup.js";
import type { VectorSearchResult } from "../VectorIndex.js";

describe("MemoryLookup", () => {
  it("should define lookupByEntityNames interface", () => {
    const mockLookup: MemoryLookup = {
      lookupByEntityNames: async (names: string[]) => {
        return names.map((name) => ({
          memoryId: `mem-${name}`,
          sessionId: "session-1",
          content: `Content about ${name}`,
          similarity: 0.9,
          distance: 0.1,
          indexedAt: new Date(),
        }));
      },
    };
    expect(mockLookup.lookupByEntityNames).toBeDefined();
  });

  it("should return VectorSearchResult[]", async () => {
    const mockLookup: MemoryLookup = {
      lookupByEntityNames: async (_names) => [],
    };
    const results = await mockLookup.lookupByEntityNames(["AuthService"]);
    expect(Array.isArray(results)).toBe(true);
  });
});
