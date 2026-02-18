import { describe, test, expect, beforeEach } from "bun:test";
import { DiagnosticsStore } from "../../../diagnostics/DiagnosticsStore.js";
import type {
  DiagnosticRun,
  NormalizedFinding,
} from "../../../diagnostics/types.js";
import * as crypto from "crypto";

/**
 * Helper to create a test diagnostic run + findings and save to store.
 */
function createTestRun(
  store: DiagnosticsStore,
  overrides: Partial<DiagnosticRun> = {},
  findings: Array<Partial<NormalizedFinding>> = [],
): { run: DiagnosticRun; findings: NormalizedFinding[] } {
  const analysisId =
    overrides.analysisId ?? crypto.randomBytes(16).toString("hex");
  const run: DiagnosticRun = {
    runId: store.createRunId(),
    analysisId,
    projectId: overrides.projectId ?? "test-project",
    treeHash: overrides.treeHash ?? "abc123",
    tool: overrides.tool ?? { name: "tsc", version: "5.3.3" },
    configHash: overrides.configHash ?? "config-hash",
    status: overrides.status ?? "passed",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    findingsDigest: overrides.findingsDigest ?? "digest-" + analysisId,
    metadata: overrides.metadata ?? {},
    ...overrides,
  };

  const normalizedFindings: NormalizedFinding[] = findings.map((f, i) => ({
    findingId: f.findingId ?? `finding-${analysisId}-${i}`,
    analysisId,
    ruleId: f.ruleId ?? "TS2322",
    severity: f.severity ?? "error",
    message: f.message ?? `Test finding ${i}`,
    filePath: f.filePath ?? "src/test.ts",
    properties: f.properties ?? {},
    ...f,
  }));

  store.saveRun(run, normalizedFindings);
  return { run, findings: normalizedFindings };
}

describe("Diagnostics UI", () => {
  let store: DiagnosticsStore;

  beforeEach(() => {
    store = new DiagnosticsStore({ dbPath: ":memory:" });
  });

  describe("DiagnosticsStore.listRuns", () => {
    test("returns empty array when no runs", () => {
      const runs = store.listRuns();
      expect(runs).toEqual([]);
    });

    test("returns runs ordered by created_at DESC", () => {
      createTestRun(store, {
        analysisId: "older",
        createdAt: "2026-01-01T00:00:00Z",
      });
      createTestRun(store, {
        analysisId: "newer",
        createdAt: "2026-02-01T00:00:00Z",
      });

      const runs = store.listRuns();
      expect(runs.length).toBe(2);
      expect(runs[0].analysisId).toBe("newer");
      expect(runs[1].analysisId).toBe("older");
    });

    test("filters by projectId", () => {
      createTestRun(store, { projectId: "project-a" });
      createTestRun(store, { projectId: "project-b" });

      const runs = store.listRuns({ projectId: "project-a" });
      expect(runs.length).toBe(1);
      expect(runs[0].projectId).toBe("project-a");
    });

    test("filters by toolName", () => {
      createTestRun(store, { tool: { name: "tsc", version: "5.3" } });
      createTestRun(store, { tool: { name: "eslint", version: "8.0" } });

      const runs = store.listRuns({ toolName: "eslint" });
      expect(runs.length).toBe(1);
      expect(runs[0].tool.name).toBe("eslint");
    });

    test("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        createTestRun(store, {
          analysisId: `run-${i}`,
          createdAt: `2026-01-0${i + 1}T00:00:00Z`,
        });
      }

      const runs = store.listRuns({ limit: 2 });
      expect(runs.length).toBe(2);
    });
  });

  describe("DiagnosticsStore.listFindings", () => {
    test("returns findings for analysis", () => {
      const { run } = createTestRun(store, {}, [
        { ruleId: "TS2322", severity: "error", message: "Type mismatch" },
        { ruleId: "TS2345", severity: "warning", message: "Arg type" },
      ]);

      const findings = store.listFindings(run.analysisId);
      expect(findings.length).toBe(2);
    });

    test("returns empty for unknown analysis", () => {
      const findings = store.listFindings("nonexistent");
      expect(findings).toEqual([]);
    });
  });

  describe("DiagnosticsStore.diffAnalyses", () => {
    test("identifies introduced and resolved findings", () => {
      // finding_id is a global PK — unique IDs per analysis
      createTestRun(
        store,
        { analysisId: "run-a" },
        [
          { findingId: "a-finding-1", message: "Only in A" },
          { findingId: "a-finding-2", message: "Also only in A" },
        ],
      );

      createTestRun(
        store,
        { analysisId: "run-b" },
        [
          { findingId: "b-finding-1", message: "Only in B" },
        ],
      );

      const diff = store.diffAnalyses("run-a", "run-b");
      // All of B's findings are "introduced" (not in A)
      expect(diff.introduced).toEqual(["b-finding-1"]);
      // All of A's findings are "resolved" (not in B)
      expect(diff.resolved).toEqual(["a-finding-1", "a-finding-2"]);
      expect(diff.unchanged).toEqual([]);
    });

    test("handles empty analyses", () => {
      createTestRun(store, { analysisId: "empty-a" }, []);
      createTestRun(store, { analysisId: "empty-b" }, []);

      const diff = store.diffAnalyses("empty-a", "empty-b");
      expect(diff.introduced).toEqual([]);
      expect(diff.resolved).toEqual([]);
      expect(diff.unchanged).toEqual([]);
    });
  });

  describe("Diagnostics view rendering", () => {
    test("diagnostics page uses severity chart", async () => {
      // Import the route handler
      const { registerDiagnosticsRoutes } = await import("../diagnostics.js");
      const { createInMemoryEventStore } = await import(
        "../../../storage/EventStore.js"
      );
      const { SessionManager } = await import(
        "../../../session/SessionManager.js"
      );

      const eventStore = createInMemoryEventStore();
      const sessionManager = new SessionManager({ eventStore });

      const handler = registerDiagnosticsRoutes({
        eventStore,
        sessionManager,
        diagnosticsStore: store,
      });

      // Create a mock Hono context
      const htmlFn = (html: string) => new Response(html, { headers: { "content-type": "text/html" } });
      const mockContext = { html: htmlFn } as any;

      const response = await handler(mockContext);
      const html = await response.text();

      expect(html).toContain("severity-chart");
      expect(html).toContain("TOTAL RUNS");
      expect(html).toContain("ERRORS");
      expect(html).toContain("WARNINGS");
      expect(html).toContain("chart.js");
    });

    test("diagnostics page shows runs table when data exists", async () => {
      createTestRun(
        store,
        { tool: { name: "tsc", version: "5.3.3" } },
        [{ severity: "error", message: "Test error" }],
      );

      const { registerDiagnosticsRoutes } = await import("../diagnostics.js");
      const { createInMemoryEventStore } = await import(
        "../../../storage/EventStore.js"
      );
      const { SessionManager } = await import(
        "../../../session/SessionManager.js"
      );

      const eventStore = createInMemoryEventStore();
      const sessionManager = new SessionManager({ eventStore });

      const handler = registerDiagnosticsRoutes({
        eventStore,
        sessionManager,
        diagnosticsStore: store,
      });

      const htmlFn = (html: string) => new Response(html, { headers: { "content-type": "text/html" } });
      const mockContext = { html: htmlFn } as any;

      const response = await handler(mockContext);
      const html = await response.text();

      expect(html).toContain("tsc");
      expect(html).toContain("5.3.3");
      expect(html).toContain("hx-get");
      expect(html).toContain("/ui/partials/diagnostics/findings/");
    });
  });

  describe("Findings partial rendering", () => {
    test("renders findings table for analysis", async () => {
      const { run } = createTestRun(
        store,
        {},
        [
          { ruleId: "TS2322", severity: "error", message: "Type mismatch", filePath: "src/foo.ts", startLine: 42 },
          { ruleId: "TS2345", severity: "warning", message: "Arg type", filePath: "src/bar.ts" },
        ],
      );

      const { registerDiagnosticsPartialRoutes } = await import(
        "../partials/diagnostics.js"
      );
      const { createInMemoryEventStore } = await import(
        "../../../storage/EventStore.js"
      );
      const { SessionManager } = await import(
        "../../../session/SessionManager.js"
      );

      const eventStore = createInMemoryEventStore();
      const sessionManager = new SessionManager({ eventStore });

      const partials = registerDiagnosticsPartialRoutes({
        eventStore,
        sessionManager,
        diagnosticsStore: store,
      });

      const htmlFn = (html: string) => new Response(html, { headers: { "content-type": "text/html" } });
      const mockContext = {
        html: htmlFn,
        req: { param: () => run.analysisId },
      } as any;

      const response = await partials.findings(mockContext);
      const html = await response.text();

      expect(html).toContain("TS2322");
      expect(html).toContain("TS2345");
      expect(html).toContain("src/foo.ts:42");
      expect(html).toContain("src/bar.ts");
      expect(html).toContain("2 findings");
    });

    test("shows empty state for analysis with no findings", async () => {
      createTestRun(store, { analysisId: "no-findings" }, []);

      const { registerDiagnosticsPartialRoutes } = await import(
        "../partials/diagnostics.js"
      );
      const { createInMemoryEventStore } = await import(
        "../../../storage/EventStore.js"
      );
      const { SessionManager } = await import(
        "../../../session/SessionManager.js"
      );

      const eventStore = createInMemoryEventStore();
      const sessionManager = new SessionManager({ eventStore });

      const partials = registerDiagnosticsPartialRoutes({
        eventStore,
        sessionManager,
        diagnosticsStore: store,
      });

      const htmlFn = (html: string) => new Response(html, { headers: { "content-type": "text/html" } });
      const mockContext = {
        html: htmlFn,
        req: { param: () => "no-findings" },
      } as any;

      const response = await partials.findings(mockContext);
      const html = await response.text();

      expect(html).toContain("No findings");
    });
  });
});
