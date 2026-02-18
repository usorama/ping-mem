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
import { registerDashboardRoutes } from "./dashboard.js";
import { registerMemoryRoutes } from "./memories.js";
import { registerMemoryPartialRoutes } from "./partials/memories.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerDiagnosticsPartialRoutes } from "./partials/diagnostics.js";
import { registerIngestionRoutes } from "./ingestion.js";
import { registerIngestionPartialRoutes } from "./partials/ingestion.js";

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

  // Diagnostics
  app.get("/ui/diagnostics", registerDiagnosticsRoutes(deps));

  // Diagnostics HTMX partials
  const diagPartials = registerDiagnosticsPartialRoutes(deps);
  app.get("/ui/partials/diagnostics/findings/:analysisId", diagPartials.findings);
  app.get("/ui/partials/diagnostics/diff", diagPartials.diff);

  // Ingestion Monitor
  app.get("/ui/ingestion", registerIngestionRoutes(deps));

  // Ingestion HTMX partials
  const ingestionPartials = registerIngestionPartialRoutes(deps);
  app.post("/ui/partials/ingestion/reingest", ingestionPartials.reingest);
}
