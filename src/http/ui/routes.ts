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
import type { KnowledgeStore } from "../../knowledge/KnowledgeStore.js";
import type { GraphManager } from "../../graph/GraphManager.js";
import type { QdrantClientWrapper } from "../../search/QdrantClient.js";
import type { AppEnv } from "../rest-server.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerMemoryRoutes } from "./memories.js";
import { registerMemoryPartialRoutes } from "./partials/memories.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerDiagnosticsPartialRoutes } from "./partials/diagnostics.js";
import { registerIngestionRoutes } from "./ingestion.js";
import { registerIngestionPartialRoutes } from "./partials/ingestion.js";
import { registerAgentsRoutes } from "./agents.js";
import { registerAgentsPartialRoutes } from "./partials/agents.js";
import { registerKnowledgeRoutes } from "./knowledge.js";
import { registerKnowledgePartialRoutes } from "./partials/knowledge.js";
import { registerSessionsRoutes } from "./sessions.js";
import { registerSessionsPartialRoutes } from "./partials/sessions.js";
import { registerEventsRoutes } from "./events.js";
import { registerEventsPartialRoutes } from "./partials/events.js";
import { registerWorklogRoutes } from "./worklog.js";
import { registerWorklogPartialRoutes } from "./partials/worklog.js";
import { registerCodebaseRoutes } from "./codebase.js";
import { registerChatRoutes } from "./chat-api.js";
import { registerHealthPartialRoute } from "./partials/health.js";
import { registerEvalRoutes } from "./eval.js";

export interface UIDependencies {
  eventStore: EventStore;
  sessionManager: SessionManager;
  diagnosticsStore: DiagnosticsStore;
  ingestionService?: IngestionService | undefined;
  knowledgeStore?: KnowledgeStore | undefined;
  graphManager?: GraphManager | undefined;
  qdrantClient?: QdrantClientWrapper | undefined;
}

export function registerUIRoutes(app: Hono<AppEnv>, deps: UIDependencies): void {
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

  // Agents
  app.get("/ui/agents", registerAgentsRoutes(deps));

  // Agents HTMX partials
  const agentsPartials = registerAgentsPartialRoutes(deps);
  app.get("/ui/partials/agents", agentsPartials.search);

  // Knowledge
  app.get("/ui/knowledge", registerKnowledgeRoutes(deps));

  // Knowledge HTMX partials
  const knowledgePartials = registerKnowledgePartialRoutes(deps);
  app.get("/ui/partials/knowledge", knowledgePartials.search);
  app.get("/ui/partials/knowledge/:id", knowledgePartials.detail);

  // Sessions
  app.get("/ui/sessions", registerSessionsRoutes(deps));

  // Sessions HTMX partials
  const sessionsPartials = registerSessionsPartialRoutes(deps);
  app.get("/ui/partials/sessions", sessionsPartials.list);
  app.get("/ui/partials/sessions/:sessionId", sessionsPartials.detail);

  // Events
  app.get("/ui/events", registerEventsRoutes(deps));

  // Events HTMX partials
  const eventsPartials = registerEventsPartialRoutes(deps);
  app.get("/ui/partials/events", eventsPartials.list);

  // Worklog
  app.get("/ui/worklog", registerWorklogRoutes(deps));

  // Worklog HTMX partials
  const worklogPartials = registerWorklogPartialRoutes(deps);
  app.get("/ui/partials/worklog", worklogPartials.list);

  // Codebase Architecture Diagram
  app.get("/ui/codebase", registerCodebaseRoutes(deps));

  // Chat API
  const chatRoutes = registerChatRoutes(deps);
  app.post("/ui/api/chat", chatRoutes.chat);

  // Eval Dashboard
  app.get("/ui/eval", registerEvalRoutes());

  // Health dot partial
  app.get("/ui/partials/health", registerHealthPartialRoute(deps));
}
