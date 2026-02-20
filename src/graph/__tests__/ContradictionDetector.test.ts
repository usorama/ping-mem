import { describe, it, expect, mock } from "bun:test";
import { ContradictionDetector } from "../ContradictionDetector.js";

describe("ContradictionDetector", () => {
  const mockOpenAI = (isContradiction: boolean, confidence: number = 0.9) => ({
    chat: {
      completions: {
        create: mock(async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                isContradiction,
                conflict: isContradiction ? "Version changed from A to B" : "",
                confidence,
              }),
            },
          }],
        })),
      },
    },
  });

  it("should detect contradictions between old and new context", async () => {
    const detector = new ContradictionDetector({ openai: mockOpenAI(true, 0.9) as any });

    const result = await detector.detect(
      "AuthService",
      "Uses JWT for authentication",
      "Uses session cookies for authentication"
    );

    expect(result.isContradiction).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.conflict.length).toBeGreaterThan(0);
  });

  it("should not flag non-contradictions", async () => {
    const detector = new ContradictionDetector({ openai: mockOpenAI(false, 0.2) as any });

    const result = await detector.detect(
      "AuthService",
      "Uses JWT for authentication",
      "Uses JWT v2 for authentication"
    );

    expect(result.isContradiction).toBe(false);
  });

  it("should ignore low-confidence contradictions", async () => {
    const detector = new ContradictionDetector({ openai: mockOpenAI(true, 0.5) as any });

    const result = await detector.detect(
      "AuthService",
      "Old context",
      "New context"
    );

    // Confidence below 0.7 threshold — should not be flagged as contradiction
    expect(result.isContradiction).toBe(false);
  });

  it("should return no contradiction on API failure", async () => {
    const failingOpenAI = {
      chat: { completions: { create: mock(async () => { throw new Error("API down"); }) } },
    };
    const detector = new ContradictionDetector({ openai: failingOpenAI as any });

    const result = await detector.detect("Entity", "old", "new");
    expect(result.isContradiction).toBe(false);
    expect(result.confidence).toBe(0);
  });
});
