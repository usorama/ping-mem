export { registerGraphRoutes, type GraphRoutesDeps } from "./graph.js";
export { registerCausalRoutes, type CausalRoutesDeps } from "./causal.js";
export { registerWorklogRoutes, type WorklogRoutesDeps } from "./worklog.js";
// Route sub-modules for diagnostics-extra, codebase-extra, memory-extra,
// tool-discovery, and openapi are not yet implemented — routes are inline
// in rest-server.ts. Will be extracted in a future refactor.
