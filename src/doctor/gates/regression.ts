/**
 * Regression gates (5): one per canonical query. Each asserts ≥1 hit from
 * GET /api/v1/search. Uses a long-lived shared session (created once per
 * doctor run) to avoid rate-limit churn on /api/v1/session/start.
 */

import type { DoctorGate, GateContext } from "../gates.js";
import { CANONICAL_QUERIES, fetchWithTimeout } from "../util.js";

function adminAuthHeader(user: string | undefined, pass: string | undefined): HeadersInit {
  if (!user || !pass) return {};
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

/**
 * Lazily acquire (or reuse) a doctor-owned session. Cached in module scope
 * for the life of a single CLI invocation — same strategy as the A-DOM-4
 * dedicated test session. Across runs it's re-created.
 */
let cachedSessionId: string | null = null;
let sessionPromise: Promise<string | null> | null = null;

async function getSharedSessionId(ctx: GateContext): Promise<string | null> {
  if (cachedSessionId) return cachedSessionId;
  if (!ctx.adminUser || !ctx.adminPass) return null;
  // Lock: when 5 regression gates fire in parallel, without this we'd POST
  // /api/v1/session/start five times concurrently and waste the shared cache.
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async (): Promise<string | null> => {
    try {
      const { status, body } = await fetchWithTimeout(
        `${ctx.restUrl}/api/v1/session/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...adminAuthHeader(ctx.adminUser, ctx.adminPass) },
          body: JSON.stringify({ name: "ping-mem-doctor", agentId: "ping-mem-doctor" }),
        },
        3000,
      );
      if (status !== 200) return null;
      const parsed = JSON.parse(body) as { data?: { sessionId?: string } };
      cachedSessionId = parsed.data?.sessionId ?? null;
      return cachedSessionId;
    } catch {
      return null;
    }
  })();
  return sessionPromise;
}

async function runRegressionQuery(ctx: GateContext, query: string) {
  const session = await getSharedSessionId(ctx);
  if (!session) {
    return { status: "skip" as const, detail: "could not acquire session" };
  }
  try {
    const url = `${ctx.restUrl}/api/v1/search?query=${encodeURIComponent(query)}&limit=5`;
    const { status, body } = await fetchWithTimeout(
      url,
      {
        headers: {
          "X-Session-ID": session,
          ...adminAuthHeader(ctx.adminUser, ctx.adminPass),
        },
      },
      9500,
    );
    if (status !== 200) {
      return { status: "fail" as const, detail: `HTTP ${status}: ${body.slice(0, 120)}` };
    }
    const parsed = JSON.parse(body) as { data?: unknown[] } | { data?: { results?: unknown[] } } | unknown;
    let count = 0;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { data?: unknown };
      if (Array.isArray(obj.data)) count = obj.data.length;
      else if (obj.data && typeof obj.data === "object") {
        const inner = (obj.data as { results?: unknown[] }).results;
        if (Array.isArray(inner)) count = inner.length;
      }
    }
    const pass = count >= 1;
    return {
      status: (pass ? "pass" : "fail") as "pass" | "fail",
      detail: `${count} hit(s)`,
      metrics: { hits: count },
    };
  } catch (err) {
    return { status: "fail" as const, detail: (err as Error).message };
  }
}

// Serialize regression queries: they share a session and all hit the same
// embedding pipeline. Running them in parallel (default Promise.all in the
// doctor runner) overloads Ollama and causes all-but-the-first to time out.
// A mutex chain here keeps the framework's parallel-gate invariant intact
// while the group itself runs sequentially.
let regressionChain: Promise<unknown> = Promise.resolve();

async function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const prev = regressionChain;
  let resolveNext!: () => void;
  regressionChain = new Promise<void>((r) => (resolveNext = r));
  try {
    await prev;
    return await fn();
  } finally {
    resolveNext();
  }
}

export const regressionGates: DoctorGate[] = CANONICAL_QUERIES.map((query, idx): DoctorGate => {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return {
    id: `regression.q${idx + 1}-${slug}`,
    group: "regression",
    description: `Canonical query "${query}" returns ≥1 hit`,
    async run(ctx) {
      return runSerialized(() => runRegressionQuery(ctx, query));
    },
  };
});
