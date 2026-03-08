/**
 * HTMX partial for health dot indicator
 *
 * Returns a <span> with color class based on service health.
 */

import type { Context } from "hono";
import type { UIDependencies } from "../routes.js";
import { escapeHtml } from "../layout.js";
import { createLogger } from "../../../util/logger.js";
import { getUiHealthColor, probeSystemHealth } from "../../../observability/health-probes.js";

const log = createLogger("UI:Health");

export function registerHealthPartialRoute(deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const snapshot = await probeSystemHealth({
        eventStore: deps.eventStore,
        diagnosticsStore: deps.diagnosticsStore,
        ...(deps.graphManager ? { graphManager: deps.graphManager } : {}),
        ...(deps.qdrantClient ? { qdrantClient: deps.qdrantClient } : {}),
      });

      const status = getUiHealthColor(snapshot);
      const title =
        snapshot.status === "ok"
          ? "All services healthy"
          : snapshot.status === "degraded"
            ? "One or more services degraded"
            : "One or more services unhealthy";

      return c.html(
        `<span id="health-dot" class="health-dot ${escapeHtml(status)}" title="${escapeHtml(title)}"
          hx-get="/ui/partials/health" hx-trigger="every 30s" hx-swap="outerHTML"></span>`,
      );
    } catch (err) {
      log.error("Partial render error", { error: err instanceof Error ? err.message : String(err) });
      return c.html(`<span id="health-dot" class="health-dot red" title="Health check error"
        hx-get="/ui/partials/health" hx-trigger="every 30s" hx-swap="outerHTML"></span>`);
    }
  };
}
