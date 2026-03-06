import { describe, test, expect } from "bun:test";
import { DiagnosticsStore } from "../../../diagnostics/DiagnosticsStore.js";
import { createInMemoryEventStore } from "../../../storage/EventStore.js";
import { SessionManager } from "../../../session/SessionManager.js";

describe("Ingestion Monitor UI", () => {
  describe("Ingestion view rendering", () => {
    test("shows service unavailable when no ingestionService", async () => {
      const { registerIngestionRoutes } = await import("../ingestion.js");
      const eventStore = createInMemoryEventStore();
      const sessionManager = new SessionManager({ eventStore });
      const diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });

      const handler = registerIngestionRoutes({
        eventStore,
        sessionManager,
        diagnosticsStore,
        ingestionService: undefined,
      });

      const htmlFn = (html: string) =>
        new Response(html, {
          headers: { "content-type": "text/html" },
        });
      const mockContext = { html: htmlFn } as any;

      const response = await handler(mockContext);
      const html = await response.text();

      expect(html).toContain("Unavailable");
      expect(html).toContain("INGESTION SERVICE");
      expect(html).toContain("REGISTERED PROJECTS");
      expect(html).toContain("Setup Required");
      expect(html).toContain("docker-compose");
    });

    test("renders layout with correct active route", async () => {
      const { registerIngestionRoutes } = await import("../ingestion.js");
      const eventStore = createInMemoryEventStore();
      const sessionManager = new SessionManager({ eventStore });
      const diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });

      const handler = registerIngestionRoutes({
        eventStore,
        sessionManager,
        diagnosticsStore,
      });

      const htmlFn = (html: string) =>
        new Response(html, {
          headers: { "content-type": "text/html" },
        });
      const mockContext = { html: htmlFn } as any;

      const response = await handler(mockContext);
      const html = await response.text();

      expect(html).toContain("Ingestion Monitor - ping-mem");
      expect(html).toContain('href="/ui/ingestion"');
    });

    test("shows stats grid with all cards", async () => {
      const { registerIngestionRoutes } = await import("../ingestion.js");
      const eventStore = createInMemoryEventStore();
      const sessionManager = new SessionManager({ eventStore });
      const diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });

      const handler = registerIngestionRoutes({
        eventStore,
        sessionManager,
        diagnosticsStore,
      });

      const htmlFn = (html: string) =>
        new Response(html, {
          headers: { "content-type": "text/html" },
        });
      const mockContext = { html: htmlFn } as any;

      const response = await handler(mockContext);
      const html = await response.text();

      expect(html).toContain("INGESTION SERVICE");
      expect(html).toContain("REGISTERED PROJECTS");
      expect(html).toContain("NEO4J");
      expect(html).toContain("QDRANT");
    });
  });

  describe("Ingestion partials", () => {
    test("reingest returns error when service unavailable", async () => {
      const { registerIngestionPartialRoutes } = await import(
        "../partials/ingestion.js"
      );
      const eventStore = createInMemoryEventStore();
      const sessionManager = new SessionManager({ eventStore });
      const diagnosticsStore = new DiagnosticsStore({ dbPath: ":memory:" });

      const partials = registerIngestionPartialRoutes({
        eventStore,
        sessionManager,
        diagnosticsStore,
        ingestionService: undefined,
      });

      const htmlFn = (html: string) =>
        new Response(html, {
          headers: { "content-type": "text/html" },
        });
      const mockContext = { html: htmlFn } as any;

      const response = await partials.reingest(mockContext);
      const html = await response.text();

      expect(html).toContain("not available");
      expect(html).toContain("Neo4j");
    });
  });
});
