/**
 * Tests for SearchProfiles
 *
 * Verifies profile definitions, weight constraints, and query detection.
 *
 * @module search/__tests__/SearchProfiles.test
 */

import { describe, it, expect } from "bun:test";
import {
  SEARCH_PROFILES,
  detectProfile,
  type SearchProfile,
} from "../SearchProfiles.js";

// ============================================================================
// Tests
// ============================================================================

describe("SearchProfiles", () => {
  describe("SEARCH_PROFILES map", () => {
    it("should contain exactly 5 profiles", () => {
      expect(SEARCH_PROFILES.size).toBe(5);
    });

    it("should contain 'general' profile", () => {
      expect(SEARCH_PROFILES.has("general")).toBe(true);
    });

    it("should contain 'code_search' profile", () => {
      expect(SEARCH_PROFILES.has("code_search")).toBe(true);
    });

    it("should contain 'decision_recall' profile", () => {
      expect(SEARCH_PROFILES.has("decision_recall")).toBe(true);
    });

    it("should contain 'error_investigation' profile", () => {
      expect(SEARCH_PROFILES.has("error_investigation")).toBe(true);
    });

    it("should contain 'temporal' profile", () => {
      expect(SEARCH_PROFILES.has("temporal")).toBe(true);
    });

    it("should have all weights (including optional) sum to <= 1.0 for each profile", () => {
      for (const [name, profile] of SEARCH_PROFILES) {
        const w = profile.weights;
        const total =
          w.semantic +
          w.keyword +
          w.graph +
          (w.code ?? 0) +
          (w.causal ?? 0);
        expect(total).toBeLessThanOrEqual(1.0 + 1e-10); // floating point tolerance
      }
    });

    it("should have base weights (semantic + keyword + graph) sum to <= 1.0 for each profile", () => {
      for (const [name, profile] of SEARCH_PROFILES) {
        const w = profile.weights;
        const baseTotal = w.semantic + w.keyword + w.graph;
        expect(baseTotal).toBeLessThanOrEqual(1.0 + 1e-10);
      }
    });

    it("should have each profile name match its map key", () => {
      for (const [key, profile] of SEARCH_PROFILES) {
        expect(profile.name).toBe(key);
      }
    });

    it("should have non-empty descriptions for all profiles", () => {
      for (const [_key, profile] of SEARCH_PROFILES) {
        expect(profile.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("detectProfile", () => {
    describe("code_search detection", () => {
      it("should detect 'function' keyword", () => {
        expect(detectProfile("Where is the function for auth?")).toBe("code_search");
      });

      it("should detect 'class' keyword", () => {
        expect(detectProfile("Find the class that handles sessions")).toBe("code_search");
      });

      it("should detect 'import' keyword", () => {
        expect(detectProfile("Which files import EmbeddingService?")).toBe("code_search");
      });

      it("should detect 'variable' keyword", () => {
        expect(detectProfile("What variable stores the config?")).toBe("code_search");
      });

      it("should detect 'bug' keyword", () => {
        expect(detectProfile("Known bug in the tokenizer")).toBe("code_search");
      });
    });

    describe("decision_recall detection", () => {
      it("should detect 'decided' keyword", () => {
        expect(detectProfile("What was decided about the migration?")).toBe("decision_recall");
      });

      it("should detect 'decision' keyword", () => {
        expect(detectProfile("Show me the decision log")).toBe("decision_recall");
      });

      it("should detect 'chose' keyword", () => {
        expect(detectProfile("We chose Qdrant over Pinecone")).toBe("decision_recall");
      });

      it("should detect 'choice' keyword", () => {
        expect(detectProfile("Explain the choice of SQLite")).toBe("decision_recall");
      });

      it("should detect 'why' keyword", () => {
        expect(detectProfile("Why did we use BM25?")).toBe("decision_recall");
      });
    });

    describe("error_investigation detection", () => {
      it("should detect 'exception' keyword", () => {
        expect(detectProfile("What caused the exception in production?")).toBe("error_investigation");
      });

      it("should detect 'crash' keyword", () => {
        expect(detectProfile("The service crash on Tuesday")).toBe("error_investigation");
      });

      it("should detect 'fail' keyword", () => {
        expect(detectProfile("Tests fail intermittently")).toBe("error_investigation");
      });

      it("should detect 'broken' keyword", () => {
        expect(detectProfile("The auth flow is broken")).toBe("error_investigation");
      });

      it("should detect 'issue' keyword", () => {
        expect(detectProfile("Known issue with memory leaks")).toBe("error_investigation");
      });
    });

    describe("temporal detection", () => {
      it("should detect 'recent' keyword", () => {
        expect(detectProfile("Show recent changes")).toBe("temporal");
      });

      it("should detect 'latest' keyword", () => {
        expect(detectProfile("What are the latest updates?")).toBe("temporal");
      });

      it("should detect 'today' keyword", () => {
        expect(detectProfile("What happened today?")).toBe("temporal");
      });

      it("should detect 'yesterday' keyword", () => {
        expect(detectProfile("Changes from yesterday")).toBe("temporal");
      });

      it("should detect 'last week' keyword", () => {
        expect(detectProfile("Work done last week")).toBe("temporal");
      });
    });

    describe("general (default) detection", () => {
      it("should return 'general' for generic queries", () => {
        expect(detectProfile("Tell me about the architecture")).toBe("general");
      });

      it("should return 'general' for empty-ish queries", () => {
        expect(detectProfile("hello")).toBe("general");
      });

      it("should return 'general' for unrelated queries", () => {
        expect(detectProfile("How does the memory layer work?")).toBe("general");
      });
    });

    describe("priority order", () => {
      it("should prefer code_search over error_investigation for 'error' (appears in both)", () => {
        // 'error' is in both CODE_KEYWORDS and ERROR_KEYWORDS
        // CODE_KEYWORDS is checked first, so code_search wins
        expect(detectProfile("error handling")).toBe("code_search");
      });

      it("should prefer code_search over error for 'fix' (appears in CODE)", () => {
        expect(detectProfile("fix the deployment")).toBe("code_search");
      });
    });

    describe("case insensitivity", () => {
      it("should detect keywords regardless of case", () => {
        expect(detectProfile("Find the FUNCTION")).toBe("code_search");
        expect(detectProfile("DECIDED on approach")).toBe("decision_recall");
        expect(detectProfile("CRASH report")).toBe("error_investigation");
        expect(detectProfile("RECENT deployments")).toBe("temporal");
      });
    });
  });
});
