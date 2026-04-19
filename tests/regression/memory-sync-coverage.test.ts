/**
 * Phase 7 — Regression CI (E2E Gate)
 *
 * Asserts that all 10 canonical memory-sync regression queries return ≥1 hit
 * against the running ping-mem REST API. This is the end-to-end proof that
 * the memory persistence pipeline (SQLite + Qdrant + Neo4j + BM25/FTS5) is
 * actually wired and serving results — not just that the containers are up.
 *
 * Contract:
 *  - ONE shared session per suite (A-DOM-4): created in beforeAll, ended in
 *    afterAll. Avoids rate-limit churn on /api/v1/session/start when multiple
 *    queries run in quick succession.
 *  - Targets PING_MEM_URL (default http://localhost:3003).
 *  - Uses PING_MEM_ADMIN_USER / PING_MEM_ADMIN_PASS with fallback to the
 *    documented dev creds (admin/ping-mem-dev-local).
 *  - Per-test timeout 10s (Neo4j cold start, embedding warmup).
 *
 * Runs against whatever ping-mem is at $PING_MEM_URL. This suite is THE gate
 * that proves memory-sync works end-to-end. Do not lower the bar.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const REGRESSION_QUERIES = [
  "ping-learn pricing research",
  "Firebase FCM pinglearn-c63a2",
  "classroom redesign worktree",
  "PR 236 JWT secret isolation",
  "DPDP consent age 18",
  "PingLearn voice tutor LiveKit",
  "Supabase migration consent tokens",
  "Ollama qwen3:8b recovery brain",
  "ping-mem-doctor gates 29",
  "native-sync hook truncation fix",
] as const;

const PING_MEM_URL = process.env.PING_MEM_URL ?? "http://localhost:3003";
const ADMIN_USER = process.env.PING_MEM_ADMIN_USER ?? "admin";
const ADMIN_PASS = process.env.PING_MEM_ADMIN_PASS ?? "ping-mem-dev-local";

const AUTH_HEADER = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64")}`;

interface SessionStartEnvelope {
  data?: { id?: string; sessionId?: string };
}

interface SearchEnvelope {
  data?: unknown[];
}

let sharedSessionId: string | null = null;

async function startSession(): Promise<string> {
  const res = await fetch(`${PING_MEM_URL}/api/v1/session/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HEADER,
    },
    body: JSON.stringify({ name: "phase7-regression", agentId: "phase7-regression" }),
  });
  if (!res.ok) {
    throw new Error(`session/start failed: HTTP ${res.status} ${await res.text()}`);
  }
  const parsed = (await res.json()) as SessionStartEnvelope;
  const id = parsed.data?.id ?? parsed.data?.sessionId;
  if (!id) {
    throw new Error(`session/start returned no id: ${JSON.stringify(parsed)}`);
  }
  return id;
}

async function endSession(sessionId: string): Promise<void> {
  const res = await fetch(`${PING_MEM_URL}/api/v1/session/end`, {
    method: "POST",
    headers: {
      "X-Session-ID": sessionId,
      Authorization: AUTH_HEADER,
    },
  });
  if (!res.ok) {
    // Non-fatal: test has already completed; just warn.
    // eslint-disable-next-line no-console
    console.warn(`session/end returned HTTP ${res.status} — continuing`);
  }
}

async function runRegressionQuery(query: string): Promise<number> {
  if (!sharedSessionId) {
    throw new Error("sharedSessionId not initialised — beforeAll did not run");
  }
  const url = `${PING_MEM_URL}/api/v1/search?query=${encodeURIComponent(query)}&limit=5`;
  const res = await fetch(url, {
    headers: {
      "X-Session-ID": sharedSessionId,
      Authorization: AUTH_HEADER,
    },
  });
  if (!res.ok) {
    throw new Error(`search failed for "${query}": HTTP ${res.status} ${await res.text()}`);
  }
  const parsed = (await res.json()) as SearchEnvelope;
  return Array.isArray(parsed.data) ? parsed.data.length : 0;
}

describe("memory-sync regression coverage (10 canonical queries)", () => {
  beforeAll(async () => {
    sharedSessionId = await startSession();
  }, 30_000);

  afterAll(async () => {
    if (sharedSessionId) {
      await endSession(sharedSessionId);
      sharedSessionId = null;
    }
  }, 15_000);

  test.each(REGRESSION_QUERIES)(
    "canonical query returns ≥1 hit: %s",
    async (query) => {
      const hits = await runRegressionQuery(query);
      expect(
        hits,
        `query "${query}" returned ${hits} hit(s); expected ≥1 — memory-sync regression`,
      ).toBeGreaterThanOrEqual(1);
    },
    10_000,
  );
});
