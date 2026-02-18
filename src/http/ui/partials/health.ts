/**
 * HTMX partial for health dot indicator
 *
 * Returns a <span> with color class based on service health.
 */

import type { Context } from "hono";
import type { UIDependencies } from "../routes.js";

export function registerHealthPartialRoute(deps: UIDependencies) {
  return async (c: Context) => {
    const { ingestionService, diagnosticsStore } = deps;

    // Check services: ingestion (Neo4j+Qdrant) and diagnostics (SQLite)
    let status: "green" | "yellow" | "red" = "green";
    let title = "All services healthy";

    const hasIngestion = !!ingestionService;
    let hasDiagnostics = true;

    try {
      // Quick probe: list runs with limit 1
      diagnosticsStore.listRuns({ limit: 1 });
    } catch {
      hasDiagnostics = false;
    }

    if (!hasIngestion && !hasDiagnostics) {
      status = "red";
      title = "Ingestion and Diagnostics unavailable";
    } else if (!hasIngestion) {
      status = "yellow";
      title = "Ingestion unavailable (Neo4j/Qdrant not connected)";
    } else if (!hasDiagnostics) {
      status = "yellow";
      title = "Diagnostics unavailable";
    }

    return c.html(
      `<span id="health-dot" class="health-dot ${status}" title="${title}"
        hx-get="/ui/partials/health" hx-trigger="every 30s" hx-swap="outerHTML"></span>`,
    );
  };
}
