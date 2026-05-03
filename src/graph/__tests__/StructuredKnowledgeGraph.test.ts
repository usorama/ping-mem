import { describe, expect, test } from "bun:test";
import {
  StructuredKnowledgeGraph,
  StructuredKnowledgeGraphError,
} from "../StructuredKnowledgeGraph.js";

const projectDir = "/Users/umasankr/Projects/ping-mem";

describe("StructuredKnowledgeGraph", () => {
  test("returns a complete graph answer with denominator evidence and disk-checked source anchors", () => {
    const graph = new StructuredKnowledgeGraph();
    const answer = graph.answer({
      agentId: "codex-local",
      projectDir,
      mode: "complete_graph",
      query: "what defines the structured graph contract",
      population: {
        kind: "project",
        root: projectDir,
        corpusId: "fixture:structured-knowledge-graph",
        include: [
          "CONTEXT.md",
          "docs/issues/2026-04-29-ground-up-local-trust-rebuild/S017-structured-knowledge-graph-module.md",
        ],
      },
    });

    expect(answer.ok).toBe(true);
    expect(answer.answerKind).toBe("complete_graph");
    expect(answer.denominator?.nodeCount).toBe(2);
    expect(answer.denominator?.edgeCount).toBe(1);
    expect(answer.denominator?.corpusHash.startsWith("sha256:")).toBe(true);
    expect(answer.sourceAnchors.every((anchor) => anchor.diskChecked)).toBe(true);
    expect(answer.blockedClaims.join(" ")).toContain("declared finite population");
  });

  test("returns a semantic neighborhood without denominator-backed completion language", () => {
    const graph = new StructuredKnowledgeGraph();
    const answer = graph.answer({
      agentId: "codex-local",
      projectDir,
      mode: "semantic_neighborhood",
      query: "graph answer provenance",
      limit: 2,
    });

    expect(answer.ok).toBe(true);
    expect(answer.answerKind).toBe("semantic_neighborhood");
    expect(answer.denominator).toBeUndefined();
    expect(answer.blockedClaims.join(" ")).toContain("intentionally incomplete");
  });

  test("blocks complete graph answers without a declared denominator", () => {
    const graph = new StructuredKnowledgeGraph();

    expect(() => graph.answer({
      agentId: "codex-local",
      projectDir,
      mode: "complete_graph",
    })).toThrow(StructuredKnowledgeGraphError);
  });

  test("blocks stale complete graph answers when freshness is required", () => {
    const graph = new StructuredKnowledgeGraph();

    expect(() => graph.answer({
      agentId: "codex-local",
      projectDir,
      mode: "complete_graph",
      requireFreshness: true,
      expectedCorpusHash: "sha256:not-current",
      population: {
        kind: "project",
        root: projectDir,
        include: ["CONTEXT.md"],
      },
    })).toThrow(StructuredKnowledgeGraphError);
  });
});
