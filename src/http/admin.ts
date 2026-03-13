import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "node:crypto";

import { createLogger } from "../util/logger.js";

// ============================================================================
// Admin rate limiting + brute-force protection (not routed through Hono)
// ============================================================================

/** Sliding-window rate limiter for admin API: 20 requests per minute per IP.
 *  Count starts at 1 on the first request in a new window; the check fires when
 *  count >= MAX (i.e., the (MAX+1)th request is blocked, exactly MAX are served). */
const adminRateLimitMap = new Map<string, { count: number; resetAt: number }>();
/** Maximum requests served per window before the next one is blocked. */
const ADMIN_RATE_LIMIT_MAX = 20;
const ADMIN_RATE_LIMIT_WINDOW_MS = 60_000;

/** Brute-force lockout: lock after 5 failed Basic Auth attempts for 30 min.
 *  lastSeen tracks the timestamp of the most recent failure for stale-entry eviction. */
const authFailureMap = new Map<string, { count: number; lockedUntil: number; lastSeen: number }>();
const AUTH_LOCKOUT_THRESHOLD = 5;
const AUTH_LOCKOUT_MS = 30 * 60_000;
/** Partial-failure entries (count > 0, not yet locked) expire after this idle window */
const AUTH_FAILURE_STALE_MS = 10 * 60_000; // 10 minutes

/**
 * Return the client IP address.
 * When PING_MEM_BEHIND_PROXY=true (production: behind Nginx/Cloudflare), the
 * direct socket is always the proxy, so we trust the X-Forwarded-For header.
 */
function getRemoteIp(req: IncomingMessage): string {
  if (process.env.PING_MEM_BEHIND_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      // X-Forwarded-For can be a comma-separated list; first entry is the original client
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const firstIp = raw?.split(",")[0]?.trim();
      if (firstIp) return firstIp;
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** Check CSRF: compare the Origin (or Referer) header against the Host header
 *  using exact URL-hostname equality, not substring matching.
 *  Substring matching (`origin.includes(host)`) can be bypassed by a domain
 *  whose name contains the server hostname as a substring (e.g., evil-myhost.com). */
function isSameHostOrigin(header: string, host: string): boolean {
  try {
    return new URL(header).host === host;
  } catch {
    return false;
  }
}

export function checkAdminRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = getRemoteIp(req);
  const now = Date.now();

  // Evict expired entries to prevent unbounded map growth under IP churn / spoofing attacks.
  for (const [key, entry] of adminRateLimitMap) {
    if (now > entry.resetAt) adminRateLimitMap.delete(key);
  }
  // Evict expired authFailureMap entries to prevent unbounded growth under distributed probing:
  // (a) Expired lockouts: lock window passed and count was reset to 0.
  // (b) Stale partial-failure entries: count > 0 but not yet locked, idle for > STALE window.
  //     Without this, every unique spoofed-IP auth probe accumulates a permanent map entry.
  for (const [key, record] of authFailureMap) {
    const expiredLockout = record.lockedUntil > 0 && now > record.lockedUntil && record.count === 0;
    const stalePartial = record.lockedUntil === 0 && record.count > 0 && (now - record.lastSeen) > AUTH_FAILURE_STALE_MS;
    if (expiredLockout || stalePartial) {
      authFailureMap.delete(key);
    }
  }

  const entry = adminRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    adminRateLimitMap.set(ip, { count: 1, resetAt: now + ADMIN_RATE_LIMIT_WINDOW_MS });
    return true;
  }
  // Check before incrementing so >= MAX blocks exactly when the quota is full
  if (entry.count >= ADMIN_RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.writeHead(429, { "Retry-After": String(retryAfter), "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too Many Requests", message: "Admin rate limit exceeded" }));
    return false;
  }
  entry.count++;
  return true;
}

function isLockedOut(ip: string, res: ServerResponse): boolean {
  const record = authFailureMap.get(ip);
  if (record && Date.now() < record.lockedUntil) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too Many Requests", message: "Account locked due to repeated failures. Try again later." }));
    return true;
  }
  return false;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const record = authFailureMap.get(ip) ?? { count: 0, lockedUntil: 0, lastSeen: now };
  record.count++;
  record.lastSeen = now;
  if (record.count >= AUTH_LOCKOUT_THRESHOLD) {
    record.lockedUntil = now + AUTH_LOCKOUT_MS;
    record.count = 0;
  }
  authFailureMap.set(ip, record);
}

function clearAuthFailures(ip: string): void {
  authFailureMap.delete(ip);
}

/** Sanitize error messages to prevent LLM provider API key leakage.
 *
 *  Pattern coverage by provider:
 *  - OpenAI, Anthropic, OpenRouter, DeepSeek: sk-... (sk-ant-..., sk-or-..., etc.)
 *  - Gemini / Google AI Studio: AIza...
 *  - Groq: gsk_...
 *  - Fireworks AI: fw_...
 *  - xAI / Grok: xai-...
 *  - Together AI: together_api_... (canonical) and legacy tog_/togx_ formats
 *  - Perplexity: pplx-...
 *  - AWS Access Key IDs: AKIA.../ASIA.../AROA.../AIDA...
 *
 *  Providers without a detectable key prefix (Mistral, Cohere, Azure OpenAI,
 *  Bedrock secret keys, Custom) cannot be pattern-matched and are not redacted.
 *  Error paths for those providers should not include raw key values in messages. */
/** @internal Exported for unit testing only — not part of the public API */
export function sanitizeAdminError(message: string): string {
  return (
    message
      // OpenAI, Anthropic (sk-ant-...), OpenRouter (sk-or-...), DeepSeek, etc.
      .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // Gemini / Google AI Studio
      .replace(/\bAIza[A-Za-z0-9_-]{35,}\b/g, "[REDACTED]")
      // Groq
      .replace(/\bgsk_[A-Za-z0-9]{10,}\b/g, "[REDACTED]")
      // Fireworks AI
      .replace(/\bfw_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // xAI / Grok
      .replace(/\bxai-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // Together AI — canonical format (together_api_...) and legacy tog_/togx_ variants
      .replace(/\btogether_api_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      .replace(/\btog[a-z]?[_-][A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // Perplexity
      .replace(/\bpplx-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // AWS Access Key IDs (AKIA/ASIA/AROA/AIDA prefix)
      .replace(/\b(AKIA|ASIA|AROA|AIDA)[A-Z2-7]{16}\b/g, "[REDACTED]")
  );
}

/** @internal Test-only: reset module-level rate-limit and lockout maps between test cases */
export function _resetAdminRateLimitMapsForTest(): void {
  adminRateLimitMap.clear();
  authFailureMap.clear();
}

/** @internal Test-only: expose the auth failure map for lockout-expiry and eviction tests */
export function _getAuthFailureMapForTest(): Map<string, { count: number; lockedUntil: number; lastSeen: number }> {
  return authFailureMap;
}
import { AdminStore, type LLMConfigInput } from "../admin/AdminStore.js";
import { ApiKeyManager } from "../admin/ApiKeyManager.js";
import { IngestionService } from "../ingest/IngestionService.js";
import { DiagnosticsStore } from "../diagnostics/DiagnosticsStore.js";
import { EventStore } from "../storage/EventStore.js";
import { ProjectScanner } from "../ingest/ProjectScanner.js";
import { timingSafeStringEqual } from "../util/auth-utils.js";
import {
  deleteProjectSchema,
  rotateKeySchema,
  deactivateKeySchema,
  setLLMConfigSchema,
  type DeleteProjectInput,
  type RotateKeyInput,
  type DeactivateKeyInput,
  type SetLLMConfigInput,
} from "../validation/admin-schemas.js";
import { parseBody, isParseSuccess } from "../validation/parse-body.js";

export interface AdminDependencies {
  adminStore: AdminStore;
  apiKeyManager: ApiKeyManager;
  ingestionService?: IngestionService | undefined;
  diagnosticsStore: DiagnosticsStore;
  eventStore: EventStore;
}

const log = createLogger("Admin");

const ADMIN_USER_ENV = "PING_MEM_ADMIN_USER";
const ADMIN_PASS_ENV = "PING_MEM_ADMIN_PASS";

const PROVIDERS = [
  "OpenAI",
  "Anthropic",
  "OpenRouter",
  "zAI",
  "Gemini",
  "Mistral",
  "Groq",
  "Cohere",
  "Together",
  "Perplexity",
  "Azure OpenAI",
  "Bedrock",
  "DeepSeek",
  "xAI",
  "Fireworks",
  "Custom",
];

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDependencies
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathName = url.pathname;

  if (pathName === "/admin" || pathName === "/admin/") {
    if (!checkAdminRateLimit(req, res)) {
      return true;
    }
    if (!checkBasicAuth(req, res)) {
      return true;
    }
    // Generate a per-request nonce for CSP — prevents inline script injection
    const nonce = crypto.randomBytes(16).toString("base64");
    const html = renderAdminPage(nonce);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:`,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    });
    res.end(html);
    return true;
  }

  if (pathName.startsWith("/api/admin")) {
    if (!checkAdminRateLimit(req, res)) {
      return true;
    }
    if (!checkBasicAuth(req, res)) {
      return true;
    }
    if (!requireApiKey(req, res, deps.apiKeyManager)) {
      return true;
    }
    // CSRF: for state-changing methods, verify Origin/Referer matches Host when present.
    // X-API-Key is a non-simple header — browsers send CORS preflight for it, which the
    // raw Node.js handler doesn't handle permissively. This is an additional defense layer.
    // isSameHostOrigin() uses new URL().host for exact hostname+port comparison to prevent
    // bypass via a domain whose name contains the server hostname as a substring.
    if (req.method !== "GET" && req.method !== "HEAD") {
      const host = req.headers.host;
      const origin = req.headers["origin"];
      const referer = req.headers["referer"];
      if (origin && host && !isSameHostOrigin(origin, host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden", message: "Cross-origin request rejected" }));
        return true;
      }
      if (!origin && referer && host && !isSameHostOrigin(referer, host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden", message: "Cross-origin request rejected" }));
        return true;
      }
    }
    await handleAdminApi(req, res, deps, pathName);
    return true;
  }

  return false;
}

async function handleAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDependencies,
  pathName: string
): Promise<void> {
  if (req.method === "GET" && pathName === "/api/admin/projects") {
    const projects = deps.adminStore.listProjects();
    return respondJson(res, 200, { data: projects });
  }

  if (req.method === "DELETE" && pathName === "/api/admin/projects") {
    const result = await parseBody(req, deleteProjectSchema);
    if (!isParseSuccess(result)) {
      return respondJson(res, 400, { error: result.error });
    }

    const { projectDir, projectId } = result.data;

    // Guard against path traversal: resolve first, then verify within allowed scope.
    // String-split-based checks do not catch URL-encoded or null-byte traversals.
    if (projectDir) {
      const resolved = path.resolve(projectDir);
      // Block paths outside safe roots (home dirs, /projects, /Users, /home, /tmp)
      const allowedRoots = [process.env["HOME"] ?? "", "/projects", "/Users", "/home", "/tmp"];
      const isSafe = allowedRoots.some((root) => root && resolved.startsWith(root + path.sep));
      if (!isSafe) {
        return respondJson(res, 400, { error: "projectDir must not contain path traversal sequences" });
      }
    }

    let resolvedProjectId: string | null;
    try {
      if (projectId) {
        resolvedProjectId = projectId;
      } else if (projectDir) {
        resolvedProjectId = await resolveProjectId(projectDir, deps.adminStore);
      } else {
        return respondJson(res, 400, { error: "Either projectDir or projectId is required" });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log.error("deleteProject: resolveProjectId failed", { error: message });
      return respondJson(res, 400, { error: "Invalid project directory or project not found" });
    }

    if (!resolvedProjectId) {
      return respondJson(res, 404, { error: "Project not found" });
    }

    const warnings: string[] = [];

    if (deps.ingestionService) {
      try {
        await deps.ingestionService.deleteProject(resolvedProjectId);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("deleteProject: ingestion cleanup failed", { projectId: resolvedProjectId, error: msg });
        warnings.push(msg);
      }
    }
    try {
      deps.diagnosticsStore.deleteProject(resolvedProjectId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("deleteProject: diagnostics cleanup failed", { projectId: resolvedProjectId, error: msg });
      warnings.push(msg);
    }

    if (projectDir) {
      try {
        deleteProjectManifest(projectDir);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("deleteProject: manifest cleanup failed", { projectDir, error: msg });
        warnings.push(msg);
      }
      try {
        const sessionIds = deps.eventStore.findSessionIdsByProjectDir(projectDir);
        deps.eventStore.deleteSessions(sessionIds);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("deleteProject: session cleanup failed", { projectDir, error: msg });
        warnings.push(msg);
      }
    }

    try {
      deps.adminStore.deleteProject(resolvedProjectId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("deleteProject: adminStore cleanup failed", { projectId: resolvedProjectId, error: msg });
      warnings.push(msg);
    }

    return respondJson(res, 200, { data: { projectId: resolvedProjectId, warnings } });
  }

  if (req.method === "GET" && pathName === "/api/admin/keys") {
    const keys = deps.adminStore.listApiKeys();
    return respondJson(res, 200, { data: keys });
  }

  if (req.method === "POST" && pathName === "/api/admin/keys/rotate") {
    const result = await parseBody(req, rotateKeySchema);
    if (!isParseSuccess(result)) {
      return respondJson(res, 400, { error: result.error });
    }

    const rotateResult = deps.adminStore.createApiKey(result.data);
    return respondJson(res, 200, { data: rotateResult });
  }

  if (req.method === "POST" && pathName === "/api/admin/keys/deactivate") {
    const result = await parseBody(req, deactivateKeySchema);
    if (!isParseSuccess(result)) {
      return respondJson(res, 400, { error: result.error });
    }

    deps.adminStore.deactivateApiKey(result.data.id);
    return respondJson(res, 200, { data: { id: result.data.id } });
  }

  if (req.method === "GET" && pathName === "/api/admin/llm-config") {
    const config = deps.adminStore.getLLMConfig();
    return respondJson(res, 200, { data: config });
  }

  if (req.method === "POST" && pathName === "/api/admin/llm-config") {
    const result = await parseBody(req, setLLMConfigSchema);
    if (!isParseSuccess(result)) {
      return respondJson(res, 400, { error: result.error });
    }

    try {
      const setResult = deps.adminStore.setLLMConfig(result.data);
      return respondJson(res, 200, { data: setResult });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unable to save LLM config";
      return respondJson(res, 500, {
        error: "LLMConfigError",
        message: sanitizeAdminError(rawMessage),
      });
    }
  }

  return respondJson(res, 404, { error: "Not found" });
}

export function checkBasicAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = getRemoteIp(req);
  const adminUser = process.env[ADMIN_USER_ENV];
  const adminPass = process.env[ADMIN_PASS_ENV];
  if (!adminUser || !adminPass) {
    // Credentials not configured — block access and warn. Never grant open access.
    log.warn("Admin auth blocked: PING_MEM_ADMIN_USER/PING_MEM_ADMIN_PASS not set", { ip });
    res.writeHead(401, { "WWW-Authenticate": "Basic" });
    res.end("Unauthorized — admin credentials not configured");
    return false;
  }

  // Brute-force protection: lock out IP after repeated failures
  if (isLockedOut(ip, res)) {
    return false;
  }

  const header = req.headers["authorization"] ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.writeHead(401, { "WWW-Authenticate": "Basic" });
    res.end("Unauthorized");
    return false;
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  // RFC 7617: password may contain colons — split only on first colon
  const colonIndex = decoded.indexOf(":");
  const user = colonIndex === -1 ? decoded : decoded.substring(0, colonIndex);
  const pass = colonIndex === -1 ? "" : decoded.substring(colonIndex + 1);

  // Use timing-safe comparison to prevent timing attacks
  // See: https://owasp.org/www-community/attacks/Timing_analysis
  const userValid = timingSafeStringEqual(user ?? "", adminUser);
  const passValid = timingSafeStringEqual(pass ?? "", adminPass);

  if (!userValid || !passValid) {
    recordAuthFailure(ip);
    log.warn("Admin auth failed — invalid credentials", { ip });
    res.writeHead(401, { "WWW-Authenticate": "Basic" });
    res.end("Unauthorized");
    return false;
  }

  clearAuthFailures(ip);
  return true;
}

function requireApiKey(
  req: IncomingMessage,
  res: ServerResponse,
  apiKeyManager: ApiKeyManager
): boolean {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKeyManager.isValid(apiKey)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized", message: "Invalid API key" }));
    return false;
  }
  return true;
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

async function resolveProjectId(projectDir: string, adminStore: AdminStore): Promise<string | null> {
  const normalized = path.resolve(projectDir);
  const record = adminStore.findProjectByDir(normalized);
  if (record) {
    return record.projectId;
  }

  if (!fs.existsSync(normalized)) {
    return null;
  }
  try {
    const scanner = new ProjectScanner();
    const scan = await scanner.scanProject(normalized);
    return scan.manifest.projectId;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("resolveProjectId: scan failed", { projectDir: normalized, error: message });
    throw new Error("Failed to scan project directory");
  }
}

function deleteProjectManifest(projectDir: string): void {
  const resolved = path.resolve(projectDir);
  // Containment check: resolved path must be under an allowed root to prevent traversal.
  const allowedRoots = [process.env["HOME"] ?? "", "/projects", "/Users", "/home", "/tmp"];
  const isSafe = allowedRoots.some((root) => root && resolved.startsWith(root + path.sep));
  if (!isSafe) {
    throw new Error("projectDir must not contain path traversal sequences");
  }
  const manifestPath = path.join(resolved, ".ping-mem", "manifest.json");
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }
  const manifestDir = path.join(resolved, ".ping-mem");
  if (fs.existsSync(manifestDir)) {
    const remaining = fs.readdirSync(manifestDir);
    if (remaining.length === 0) {
      fs.rmdirSync(manifestDir);
    }
  }
}

function renderAdminPage(nonce: string): string {
  const providerOptions = PROVIDERS.map((p) => `<option value="${p}">${p}</option>`).join("");
  const providersJson = JSON.stringify(PROVIDERS);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ping-mem Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f5f7;
      --card: #ffffff;
      --text: #1a1d24;
      --muted: #6b7280;
      --accent: #2b6df3;
      --border: #e6e8ef;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Space Grotesk", system-ui, sans-serif;
      background: radial-gradient(circle at 10% 10%, #e8f0ff 0%, var(--bg) 40%);
      color: var(--text);
    }
    header {
      padding: 32px 24px 12px;
    }
    h1 { margin: 0; font-size: 28px; }
    p { margin: 8px 0 0; color: var(--muted); }
    main {
      display: grid;
      gap: 20px;
      padding: 16px 24px 40px;
      max-width: 1100px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.05);
    }
    .card h2 { margin: 0 0 12px; font-size: 20px; }
    .row { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
    }
    button {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 600;
    }
    button.secondary {
      background: #111827;
    }
    button.ghost {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    th, td {
      text-align: left;
      padding: 10px;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
    }
    .muted { color: var(--muted); }
    .stack { display: grid; gap: 12px; }
    .note { font-size: 12px; color: var(--muted); }
    .status { font-size: 13px; color: #0f766e; }
    .error { color: #dc2626; }
    .key-display {
      background: #0f172a;
      color: #e2e8f0;
      padding: 10px 12px;
      border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <header>
    <h1>ping-mem Admin</h1>
    <p>Manage projects, API keys, and LLM providers for memory recovery workflows.</p>
  </header>
  <main>
    <section class="card">
      <h2>Admin API Key</h2>
      <div class="row">
        <div>
          <label for="currentApiKey">Current API Key</label>
          <input id="currentApiKey" placeholder="Paste the current API key" />
        </div>
        <div style="display:flex; align-items:flex-end; gap:12px;">
          <button id="saveApiKey">Save for Admin UI</button>
          <span id="apiKeyStatus" class="muted"></span>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>API Key Management</h2>
      <div class="stack">
        <div class="row">
          <button id="rotateKey">Rotate Key (Deactivate Old)</button>
          <button id="refreshKeys" class="ghost">Refresh Keys</button>
        </div>
        <div id="newKeyBox" style="display:none;">
          <div class="note">New key generated (copy now; it won't be shown again).</div>
          <div class="key-display" id="newKeyValue"></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Key ID</th>
              <th>Last 4</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="keysTable"></tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Projects</h2>
      <div class="row">
        <button id="refreshProjects" class="ghost">Refresh Projects</button>
        <span class="note">Delete removes memories, sessions, diagnostics, graph, and vectors for the project.</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Project Dir</th>
            <th>Project ID</th>
            <th>Last Ingested</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="projectsTable"></tbody>
      </table>
    </section>

    <section class="card">
      <h2>LLM Provider Configuration</h2>
      <div class="row">
        <div>
          <label for="llmProvider">Provider</label>
          <select id="llmProvider">${providerOptions}</select>
        </div>
        <div>
          <label for="llmModel">Model (optional)</label>
          <input id="llmModel" placeholder="e.g. gpt-4.1-mini" />
        </div>
        <div>
          <label for="llmBaseUrl">Base URL (optional)</label>
          <input id="llmBaseUrl" placeholder="https://api.openai.com/v1" />
        </div>
      </div>
      <div class="row" style="margin-top:12px;">
        <div>
          <label for="llmApiKey">Provider API Key</label>
          <input id="llmApiKey" placeholder="Paste API key" />
        </div>
        <div style="display:flex; align-items:flex-end; gap:12px;">
          <button id="saveLLMConfig">Save LLM Config</button>
          <span id="llmStatus" class="muted"></span>
        </div>
      </div>
      <p class="note">Used for future LLM-assisted memory recovery workflows. Providers: ${providersJson}.</p>
    </section>
  </main>

  <script nonce="${nonce}">
    function escapeHtml(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    }

    // API key is stored in memory only (not sessionStorage) to reduce XSS exposure window.
    // Refreshing the page clears the key — a deliberate security trade-off.
    const state = {
      apiKey: "",
    };

    const apiKeyInput = document.getElementById("currentApiKey");
    const apiKeyStatus = document.getElementById("apiKeyStatus");
    const saveApiKey = document.getElementById("saveApiKey");

    saveApiKey.addEventListener("click", () => {
      state.apiKey = apiKeyInput.value.trim();
      apiKeyStatus.textContent = state.apiKey ? "Saved (in-memory only)" : "Missing";
    });

    async function apiFetch(path, options = {}) {
      if (!state.apiKey) {
        throw new Error("Set API key first");
      }
      const headers = Object.assign(
        { "Content-Type": "application/json", "X-API-Key": state.apiKey },
        options.headers || {}
      );
      const response = await fetch(path, { ...options, headers });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.message || json?.error || "Request failed");
      }
      return json.data;
    }

    function createCell(text) {
      const td = document.createElement("td");
      td.textContent = text;
      return td;
    }

    async function refreshKeys() {
      const keys = await apiFetch("/api/admin/keys");
      const table = document.getElementById("keysTable");
      table.textContent = "";
      keys.forEach((key) => {
        const row = document.createElement("tr");
        row.appendChild(createCell(key.id));
        row.appendChild(createCell(key.last4));
        row.appendChild(createCell(new Date(key.createdAt).toLocaleString()));
        row.appendChild(createCell(key.active ? "Active" : "Inactive"));
        const actionTd = document.createElement("td");
        if (key.active) {
          const btn = document.createElement("button");
          btn.className = "ghost";
          btn.textContent = "Deactivate";
          btn.dataset.id = key.id;
          btn.addEventListener("click", () => {
            apiFetch("/api/admin/keys/deactivate", {
              method: "POST",
              body: JSON.stringify({ id: key.id }),
            }).then(() => refreshKeys()).catch((err) => console.error("Deactivate key failed:", err));
          });
          actionTd.appendChild(btn);
        }
        row.appendChild(actionTd);
        table.appendChild(row);
      });
    }

    async function rotateKey() {
      const result = await apiFetch("/api/admin/keys/rotate", {
        method: "POST",
        body: JSON.stringify({ deactivateOld: true }),
      });
      const box = document.getElementById("newKeyBox");
      const value = document.getElementById("newKeyValue");
      value.textContent = result.key;
      box.style.display = "block";
      refreshKeys().catch((err) => console.error("refreshKeys failed:", err));
    }

    async function refreshProjects() {
      const projects = await apiFetch("/api/admin/projects");
      const table = document.getElementById("projectsTable");
      table.textContent = "";
      projects.forEach((project) => {
        const row = document.createElement("tr");
        const lastIngested = project.lastIngestedAt
          ? new Date(project.lastIngestedAt).toLocaleString()
          : "-";
        row.appendChild(createCell(project.projectDir));
        row.appendChild(createCell(project.projectId));
        row.appendChild(createCell(lastIngested));
        const actionTd = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.textContent = "Delete";
        btn.addEventListener("click", () => {
          if (!confirm("Delete all memory, graph, and diagnostics for this project?")) {
            return;
          }
          apiFetch("/api/admin/projects", {
            method: "DELETE",
            body: JSON.stringify({ projectDir: project.projectDir }),
          }).then(() => refreshProjects()).catch((err) => console.error("Delete project failed:", err));
        });
        actionTd.appendChild(btn);
        row.appendChild(actionTd);
        table.appendChild(row);
      });
    }

    async function loadLLMConfig() {
      const config = await apiFetch("/api/admin/llm-config");
      if (!config) {
        return;
      }
      document.getElementById("llmProvider").value = config.provider;
      document.getElementById("llmModel").value = config.model || "";
      document.getElementById("llmBaseUrl").value = config.baseUrl || "";
      document.getElementById("llmStatus").textContent = config.hasApiKey ? "Configured" : "Missing";
    }

    async function saveLLMConfig() {
      const payload = {
        provider: document.getElementById("llmProvider").value,
        model: document.getElementById("llmModel").value,
        baseUrl: document.getElementById("llmBaseUrl").value,
        apiKey: document.getElementById("llmApiKey").value,
      };
      await apiFetch("/api/admin/llm-config", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      document.getElementById("llmStatus").textContent = "Saved";
      document.getElementById("llmApiKey").value = "";
    }

    document.getElementById("refreshKeys").addEventListener("click", () => refreshKeys().catch((err) => console.error("refreshKeys failed:", err)));
    document.getElementById("rotateKey").addEventListener("click", () => rotateKey().catch((err) => console.error("rotateKey failed:", err)));
    document.getElementById("refreshProjects").addEventListener("click", () => refreshProjects().catch((err) => console.error("refreshProjects failed:", err)));
    document.getElementById("saveLLMConfig").addEventListener("click", () => saveLLMConfig().catch((err) => console.error("saveLLMConfig failed:", err)));

    if (state.apiKey) {
      refreshKeys().catch(console.error);
      refreshProjects().catch(console.error);
      loadLLMConfig().catch(console.error);
    }
  </script>
</body>
</html>`;
}
