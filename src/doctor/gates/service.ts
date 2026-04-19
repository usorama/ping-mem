/**
 * Service gates (7):
 *   rest-health, rest-admin-auth, mcp-proxy-stdio,
 *   ollama-reachable, ollama-model-qwen3, ollama-warm-latency,
 *   session-cap-utilization.
 *
 * These check the ping-mem service layer + Ollama chain responsiveness.
 */

import type { DoctorGate } from "../gates.js";
import { fetchWithTimeout, runShell } from "../util.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_WARM_MODEL = process.env.OLLAMA_WARM_MODEL ?? "qwen3:8b";
const OLLAMA_WARM_LATENCY_MS = 8_000;
const SESSION_CAP = 100;
const SESSION_UTILIZATION_WARN = 0.9;

function adminAuthHeader(user: string | undefined, pass: string | undefined): HeadersInit {
  if (!user || !pass) return {};
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

export const serviceGates: DoctorGate[] = [
  {
    id: "service.rest-health",
    group: "service",
    description: "GET /health returns status=ok",
    async run(ctx) {
      try {
        const { status, body } = await fetchWithTimeout(`${ctx.restUrl}/health`, {}, 3000);
        if (status !== 200) {
          return { status: "fail", detail: `HTTP ${status}` };
        }
        const parsed = JSON.parse(body) as { status: string; components?: Record<string, string> };
        const isOk = parsed.status === "ok";
        return {
          status: isOk ? "pass" : "fail",
          detail: parsed.status,
          metrics: { responseStatus: parsed.status },
        };
      } catch (err) {
        return { status: "fail", detail: (err as Error).message };
      }
    },
  },

  {
    id: "service.rest-admin-auth",
    group: "service",
    description: "Admin basic-auth credentials authenticate against /admin",
    async run(ctx) {
      if (!ctx.adminUser || !ctx.adminPass) {
        return { status: "skip", detail: "admin creds not configured" };
      }
      try {
        // /admin requires only Basic auth (browser-friendly); /api/admin/* additionally
        // requires X-API-Key. Basic-auth liveness is the correct scope for this gate.
        const { status } = await fetchWithTimeout(
          `${ctx.restUrl}/admin`,
          { headers: adminAuthHeader(ctx.adminUser, ctx.adminPass) },
          3000,
        );
        const pass = status === 200;
        return {
          status: pass ? "pass" : "fail",
          detail: `HTTP ${status}`,
          metrics: { status },
        };
      } catch (err) {
        return { status: "fail", detail: (err as Error).message };
      }
    },
  },

  {
    id: "service.mcp-proxy-stdio",
    group: "service",
    description: "ping-mem-mcp binary is on PATH (proxy stdio entry)",
    async run() {
      const { stdout, code } = await runShell("command -v ping-mem-mcp 2>/dev/null || true");
      if (code === 0 && stdout.trim().length > 0) {
        return { status: "pass", detail: stdout.trim() };
      }
      // Fallback: check the built dist entry
      const { code: distCode } = await runShell(
        "test -f /Users/umasankr/Projects/ping-mem/dist/mcp/cli.js && echo ok",
      );
      if (distCode === 0) {
        return { status: "pass", detail: "dist/mcp/cli.js present" };
      }
      return { status: "fail", detail: "neither ping-mem-mcp binary nor dist/mcp/cli.js present" };
    },
  },

  {
    id: "service.ollama-reachable",
    group: "service",
    description: "Ollama /api/tags reachable",
    async run() {
      try {
        const { status } = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, {}, 2500);
        return {
          status: status === 200 ? "pass" : "fail",
          detail: `HTTP ${status}`,
          metrics: { status },
        };
      } catch (err) {
        return { status: "fail", detail: (err as Error).message };
      }
    },
  },

  {
    id: "service.ollama-model-qwen3",
    group: "service",
    description: "Ollama has qwen3:8b installed",
    async run() {
      try {
        const { status, body } = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, {}, 2500);
        if (status !== 200) return { status: "fail", detail: `HTTP ${status}` };
        const parsed = JSON.parse(body) as { models?: Array<{ name?: string }> };
        const has = (parsed.models ?? []).some((m) => m.name === "qwen3:8b");
        return {
          status: has ? "pass" : "fail",
          detail: has ? "qwen3:8b installed" : "qwen3:8b missing",
          metrics: { models: (parsed.models ?? []).length },
        };
      } catch (err) {
        return { status: "fail", detail: (err as Error).message };
      }
    },
  },

  {
    id: "service.ollama-warm-latency",
    group: "service",
    description: `Ollama warm inference <${OLLAMA_WARM_LATENCY_MS}ms`,
    async run() {
      const startedAt = Date.now();
      try {
        const { status, body } = await fetchWithTimeout(
          `${OLLAMA_URL}/api/generate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: OLLAMA_WARM_MODEL,
              prompt: "ping",
              stream: false,
              options: { num_predict: 2, keep_alive: "15m" },
            }),
          },
          OLLAMA_WARM_LATENCY_MS + 1000,
        );
        const elapsedMs = Date.now() - startedAt;
        if (status !== 200) {
          return {
            status: "fail",
            detail: `HTTP ${status}: ${body.slice(0, 80)}`,
            metrics: { elapsedMs, status },
          };
        }
        const pass = elapsedMs < OLLAMA_WARM_LATENCY_MS;
        return {
          status: pass ? "pass" : "fail",
          detail: `${elapsedMs}ms (budget ${OLLAMA_WARM_LATENCY_MS}ms)`,
          metrics: { elapsedMs, budgetMs: OLLAMA_WARM_LATENCY_MS },
        };
      } catch (err) {
        return { status: "fail", detail: (err as Error).message };
      }
    },
  },

  {
    id: "service.session-cap-utilization",
    group: "service",
    description: `Session count under ${Math.floor(SESSION_CAP * SESSION_UTILIZATION_WARN)}/${SESSION_CAP}`,
    async run(ctx) {
      if (!ctx.adminUser || !ctx.adminPass) {
        return { status: "skip", detail: "admin creds not configured" };
      }
      try {
        const { status, body } = await fetchWithTimeout(
          `${ctx.restUrl}/api/v1/session/list?status=active&limit=200`,
          { headers: adminAuthHeader(ctx.adminUser, ctx.adminPass) },
          2500,
        );
        if (status !== 200) return { status: "fail", detail: `HTTP ${status}` };
        const parsed = JSON.parse(body) as { data?: { sessions?: unknown[]; count?: number } };
        const count = parsed.data?.sessions?.length ?? parsed.data?.count ?? 0;
        const pass = count <= Math.floor(SESSION_CAP * SESSION_UTILIZATION_WARN);
        return {
          status: pass ? "pass" : "fail",
          detail: `${count} active / cap ${SESSION_CAP}`,
          metrics: { count, cap: SESSION_CAP },
        };
      } catch (err) {
        return { status: "fail", detail: (err as Error).message };
      }
    },
  },
];
