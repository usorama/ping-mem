/**
 * Doctor gate registry — single source of truth for all 29 ping-mem gates.
 *
 * Each gate exposes `id`, `group`, `description`, and a `run(ctx)` function
 * returning a `GateResult`. Groups are wired as per A-DOM-1:
 *   infrastructure | service | data | selfheal | loghygiene | regression | alerts
 *
 * Gates are invoked in parallel (Promise.all) with per-gate AbortController (5s)
 * and an outer total budget of 10s. See src/cli/commands/doctor.ts for runner.
 */

export type GateStatus = "pass" | "fail" | "skip";

export type GateGroup =
  | "infrastructure"
  | "service"
  | "data"
  | "selfheal"
  | "loghygiene"
  | "regression"
  | "alerts";

export interface GateContext {
  /** Absolute path to ~/.ping-mem (override in tests) */
  pingMemDir: string;
  /** REST base URL, e.g. http://localhost:3003 */
  restUrl: string;
  /** Admin basic-auth credentials (optional) */
  adminUser: string | undefined;
  adminPass: string | undefined;
  /** Per-gate timeout in ms */
  perGateTimeoutMs: number;
}

export interface GateResult {
  id: string;
  group: GateGroup;
  status: GateStatus;
  durationMs: number;
  detail?: string;
  metrics?: Record<string, number | string | boolean>;
}

export interface DoctorGate {
  id: string;
  group: GateGroup;
  description: string;
  run(ctx: GateContext): Promise<Omit<GateResult, "id" | "group" | "durationMs"> & Partial<Pick<GateResult, "id" | "group">>>;
}

/**
 * Lazy loader to avoid cycle: imports grouped gate modules and concatenates.
 */
export async function loadAllGates(): Promise<DoctorGate[]> {
  const [infra, service, data, selfheal, loghyg, regression, alerts] = await Promise.all([
    import("./gates/infrastructure.js"),
    import("./gates/service.js"),
    import("./gates/data.js"),
    import("./gates/selfheal.js"),
    import("./gates/loghygiene.js"),
    import("./gates/regression.js"),
    import("./gates/alerts.js"),
  ]);
  return [
    ...infra.infrastructureGates,
    ...service.serviceGates,
    ...data.dataGates,
    ...selfheal.selfhealGates,
    ...loghyg.logHygieneGates,
    ...regression.regressionGates,
    ...alerts.alertGates,
  ];
}

// Re-export common helpers so gate modules can import from a single place.
export { runWithTimeout } from "./util.js";
