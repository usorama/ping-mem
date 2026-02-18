/**
 * UI route registration for ping-mem
 *
 * Registers all /ui/* routes on the Hono app. Called from rest-server.ts setupRoutes().
 */

import type { Hono } from "hono";
import type { EventStore } from "../../storage/EventStore.js";
import type { SessionManager } from "../../session/SessionManager.js";
import type { DiagnosticsStore } from "../../diagnostics/DiagnosticsStore.js";
import type { IngestionService } from "../../ingest/IngestionService.js";
import { renderLayout } from "./layout.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerMemoryRoutes } from "./memories.js";
import { registerMemoryPartialRoutes } from "./partials/memories.js";

export interface UIDependencies {
  eventStore: EventStore;
  sessionManager: SessionManager;
  diagnosticsStore: DiagnosticsStore;
  ingestionService?: IngestionService | undefined;
}

export function registerUIRoutes(app: Hono, deps: UIDependencies): void {
  // Dashboard
  app.get("/ui", registerDashboardRoutes(deps));

  // Memory Explorer
  app.get("/ui/memories", registerMemoryRoutes(deps));

  // Memory HTMX partials
  const memoryPartials = registerMemoryPartialRoutes(deps);
  app.get("/ui/partials/memories", memoryPartials.search);
  app.get("/ui/partials/memory/:key", memoryPartials.detail);

  // Placeholder routes for Phase 2 views
  app.get("/ui/diagnostics", (c) => {
    return c.html(renderLayout({
      title: "Diagnostics",
      content: `<div class="empty-state"><p>Coming in Phase 2</p></div>`,
      activeRoute: "diagnostics",
    }));
  });

  app.get("/ui/ingestion", (c) => {
    return c.html(renderLayout({
      title: "Ingestion Monitor",
      content: `<div class="empty-state"><p>Coming in Phase 2</p></div>`,
      activeRoute: "ingestion",
    }));
  });
}
