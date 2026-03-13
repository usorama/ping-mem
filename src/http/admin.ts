import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "node:crypto";

import { createLogger } from "../util/logger.js";
import { AdminStore, type LLMConfigInput } from "../admin/AdminStore.js";
import { ApiKeyManager } from "../admin/ApiKeyManager.js";
import { IngestionService } from "../ingest/IngestionService.js";
import { DiagnosticsStore } from "../diagnostics/DiagnosticsStore.js";
import { EventStore } from "../storage/EventStore.js";
import { ProjectScanner } from "../ingest/ProjectScanner.js";
import { timingSafeStringEqual } from "../util/auth-utils.js";
import { isProjectDirSafe as _isProjectDirSafe } from "../util/path-safety.js";
import {
  deleteProjectSchema,
  rotateKeySchema,
  deactivateKeySchema,
  setLLMConfigSchema,
  SUPPORTED_PROVIDERS,
  type DeleteProjectInput,
  type RotateKeyInput,
  type DeactivateKeyInput,
  type SetLLMConfigInput,
} from "../validation/admin-schemas.js";
import { parseBody, isParseSuccess } from "../validation/parse-body.js";

// ============================================================================
// Admin rate limiting + brute-force protection (not routed through Hono)
// ============================================================================

/** Sliding-window rate limiter for admin API: 20 requests per minute per IP.
 *  Count starts at 1 on the first request in a new window; the check fires when
 *  count >= MAX (i.e., the (MAX+1)th request is blocked, exactly MAX are served). */
const adminRateLimitMap = new Map<string, { count: number; resetAt: number }>();
/** Maximum requests served per window before the next one is blocked.
 *  Exported so tests can import the constant rather than hard-coding the magic number 20. */
export const ADMIN_RATE_LIMIT_MAX = 20;
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
 *
 * WARNING: Never set PING_MEM_BEHIND_PROXY=true without a trusted proxy in front
 * that strips or rewrites incoming X-Forwarded-For headers. If this server is
 * directly reachable, an attacker can set arbitrary XFF values to spoof their IP
 * and bypass per-IP rate limiting and brute-force lockout.
 */
function getRemoteIp(req: IncomingMessage): string {
  if (process.env.PING_MEM_BEHIND_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      // X-Forwarded-For can be a comma-separated list; first entry is the original client
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const firstIp = raw?.split(",")[0]?.trim();
      // Sanitize the XFF value before returning: strip non-IP characters to prevent
      // log injection when the IP is later written to structured logs.
      // A trusted upstream proxy should have already validated this, but defense-in-depth
      // applies here because attacker-controlled XFF may reach this code before proxy validation.
      if (firstIp) return firstIp.replace(/[^\w\.\:\[\]\-]/g, "?").slice(0, 64);
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** Check CSRF: compare the Origin (or Referer) header against the Host header
 *  using exact URL-hostname equality, not substring matching.
 *  Substring matching (`origin.includes(host)`) can be bypassed by a domain
 *  whose name contains the server hostname as a substring (e.g., evil-myhost.com).
 *
 *  @internal Exported for unit testing only */
export function isSameHostOrigin(header: string, host: string): boolean {
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
  // Both scans are O(n) in the number of unique IPs seen. This is acceptable because the admin
  // endpoint is not a high-throughput path (single human operator). Under an active IP-churn
  // attack the maps grow transiently, but AUTH_FAILURE_STALE_MS and the rate-limit window
  // bound the maximum entry lifetime. A hard cap or background sweep would be more robust
  // under extreme sustained attack but adds complexity not warranted for this use case.
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
  const now = Date.now();
  if (!record || record.lockedUntil === 0) return false;
  if (now >= record.lockedUntil) {
    // Lockout window has expired — eagerly evict this entry rather than waiting for
    // the next checkAdminRateLimit sweep. This ensures expired lockouts don't linger
    // when checkAdminRateLimit is not called (e.g., test scenarios or low-traffic paths).
    authFailureMap.delete(ip);
    return false;
  }
  const retryAfter = Math.ceil((record.lockedUntil - now) / 1000);
  res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
  res.end(JSON.stringify({ error: "Too Many Requests", message: "Account locked due to repeated failures. Try again later." }));
  return true;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const record = authFailureMap.get(ip) ?? { count: 0, lockedUntil: 0, lastSeen: now };
  // If a previous lockout has expired, normalize it so stale-partial eviction can fire later.
  // Without this, entries with (lockedUntil=expired, count>0) are unreachable by either
  // eviction path in checkAdminRateLimit (expiredLockout requires count===0; stalePartial
  // requires lockedUntil===0), creating permanent accumulation under IP-churn probing.
  if (record.lockedUntil > 0 && now > record.lockedUntil) {
    record.lockedUntil = 0;
    record.count = 0;
  }
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
 *  - Together AI: together_api_... (canonical) and legacy tog_/togx_ formats (32+ alphanum chars)
 *  - Perplexity: pplx-...
 *  - AWS: AKIA/ASIA (access key IDs, secret) and AROA/AIDA (role/user principal IDs,
 *    non-secret but included to avoid accidental disclosure in stack traces)
 *
 *  Providers without a detectable key prefix (Mistral, Cohere, Azure OpenAI,
 *  Bedrock secret keys, Custom) cannot be pattern-matched and are not redacted.
 *  Error paths for those providers should not include raw key values in messages. */
/** @internal Exported for unit testing only — not part of the public API */
export function sanitizeAdminError(message: string): string {
  // Cap message length before applying regex chain to prevent DoS via pathologically long
  // error strings from misbehaving LLM providers (each regex scans the entire string).
  const capped = message.slice(0, 4096);
  return (
    capped
      // OpenAI, Anthropic (sk-ant-...), OpenRouter (sk-or-...), DeepSeek, etc.
      .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // Gemini / Google AI Studio
      .replace(/\bAIza[A-Za-z0-9_-]{35,}\b/g, "[REDACTED]")
      // Groq
      .replace(/\bgsk_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // Fireworks AI
      .replace(/\bfw_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // xAI / Grok
      .replace(/\bxai-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // Together AI — canonical format (together_api_...) and legacy tog_/togx_ variants.
      // The legacy pattern uses underscore-only separator and [A-Za-z0-9]{32,} body (no underscores,
      // long minimum) to avoid false-positive redaction of identifiers like tog_feature_flag_name
      // or tog-correlation-id that happen to be long.
      // Known false-negative: a key immediately followed by an underscore (e.g. tog_KEY_ctx)
      // escapes redaction because \b does not fire between [A-Za-z0-9] and _ (both \w).
      // Error messages from Together AI callers must not include underscore-adjacent key material.
      .replace(/\btogether_api_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      .replace(/\btog[a-z]?_[A-Za-z0-9]{32,}\b/g, "[REDACTED]")
      // Perplexity
      .replace(/\bpplx-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
      // AWS IAM credentials (prefix + 16 uppercase alphanumeric chars = 20 total)
      // AKIA/ASIA = access key IDs (secret); AROA/AIDA = role/user principal IDs (non-secret,
      // included conservatively since they appear in stack traces and error messages)
      // [A-Z0-9] not [A-Z2-7]: AWS uses full alphanumeric, not base32 (which excludes 0,1,8,9)
      .replace(/\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g, "[REDACTED]")
  );
}

// ============================================================================
// Test-only exports (prefixed _ and @internal)
// These live in the production module rather than a separate test-utilities file
// because they expose module-private state. They carry no runtime risk as long
// as production callers only import the non-_ exports. If this file is ever
// tree-shaken or bundled, these exports can be excluded via conditional exports
// in package.json or a separate test-utilities file.
// ============================================================================

/** @internal Exported for unit testing only.
 *  Checks whether projectDir is a subdirectory of an allowed root.
 *  Uses path.resolve to normalise before checking, catching ../ and similar sequences.
 *
 *  NOTE: /tmp is intentionally excluded from the allowed roots. /tmp is world-writable
 *  on all POSIX systems — any process (including untrusted containers sharing the host's
 *  /tmp) can create directories there. Including it would allow an authenticated attacker
 *  to trigger EventStore, DiagnosticsStore, and manifest deletions for arbitrary /tmp paths. */
// Re-exported for test access. Implementation lives in util/path-safety.ts.
export { _isProjectDirSafe };

/** @internal Test-only: reset module-level rate-limit and lockout maps between test cases */
export function _resetAdminRateLimitMapsForTest(): void {
  adminRateLimitMap.clear();
  authFailureMap.clear();
}

/** @internal Test-only: expose the auth failure map for lockout-expiry and eviction tests */
export function _getAuthFailureMapForTest(): Map<string, { count: number; lockedUntil: number; lastSeen: number }> {
  return authFailureMap;
}

/** @internal Test-only: expose the rate-limit map for window-reset tests */
export function _getAdminRateLimitMapForTest(): Map<string, { count: number; resetAt: number }> {
  return adminRateLimitMap;
}

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

// SUPPORTED_PROVIDERS is imported from admin-schemas.ts — single source of truth.
// Do not redeclare a local list here; the two arrays must never drift out of sync.

export async function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDependencies
): Promise<boolean> {
  // Use a fixed placeholder base URL so the Host header cannot influence URL parsing.
  // req.url from Node.js is always a path string (never a full absolute URL), so the
  // placeholder base is only used to satisfy the URL constructor's requirement for an
  // absolute base when resolving relative paths.
  const pathName = new URL(req.url ?? "/", "http://localhost").pathname;

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
      // no-store: the admin page contains the admin panel structure. Even though the API key
      // is not stored in the HTML, the page structure should not be cached by shared proxies.
      "Cache-Control": "no-store",
      // frame-ancestors 'none' is the modern replacement for X-Frame-Options: DENY.
      // Both are included for maximum browser compatibility.
      // connect-src 'self': restricts fetch() calls to same origin (all /api/admin/* calls).
      // form-action 'none': no HTML forms are used; blocks form-submission hijacking from XSS.
      // base-uri 'none': prevents a <base> tag injection from redirecting relative URLs.
      "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      // HSTS is only meaningful over HTTPS. Only send it in production (behind a TLS proxy).
      // Sending HSTS over plain HTTP causes browsers to refuse future plain-HTTP connections,
      // which would break local development.
      ...(process.env.PING_MEM_BEHIND_PROXY === "true"
        ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" }
        : {}),
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
      // Reject: a well-formed HTTP/1.1 request always includes Host. Accepting state-changing
      // requests without Host would silently bypass the CSRF origin check entirely, since the
      // isSameHostOrigin comparison requires both sides to be present.
      if (!host) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request", message: "Host header is required" }));
        return true;
      }
      const origin = req.headers["origin"];
      const referer = req.headers["referer"];
      if (origin && !isSameHostOrigin(origin, host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden", message: "Cross-origin request rejected" }));
        return true;
      }
      if (!origin && referer && !isSameHostOrigin(referer, host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden", message: "Cross-origin request rejected" }));
        return true;
      }
      // No origin AND no referer: allow — server-to-server / CLI callers omit browser headers;
      // X-API-Key is the primary auth layer for those callers.
      // KNOWN LIMITATION: a browser that omits both headers (e.g., via a privacy proxy that
      // strips Referer, or a direct <form> POST without JavaScript) also passes this check.
      // Full CSRF elimination would require a Double-Submit Cookie or Synchronizer Token.
      // The current design accepts this residual risk because X-API-Key is a high-entropy
      // secret that must be explicitly obtained and configured by the caller.
    }
    try {
      await handleAdminApi(req, res, deps, pathName);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      log.error("handleAdminApi: unexpected error", { method: req.method, path: pathName, error: message });
      if (!res.headersSent) {
        respondJson(res, 500, { error: "Internal Server Error" });
      }
    }
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
    try {
      const projects = deps.adminStore.listProjects();
      return respondJson(res, 200, { data: projects });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to list projects";
      log.error("listProjects failed", { error: message });
      return respondJson(res, 500, { error: "Internal Server Error" });
    }
  }

  if (req.method === "DELETE" && pathName === "/api/admin/projects") {
    const result = await parseBody(req, deleteProjectSchema);
    if (!isParseSuccess(result)) {
      return respondJson(res, 400, { error: result.error });
    }

    const { projectDir, projectId } = result.data;

    // Guard against path traversal: path.resolve normalises ../ sequences before the root check.
    if (projectDir && !_isProjectDirSafe(projectDir)) {
      return respondJson(res, 400, { error: "projectDir must be a subdirectory of an allowed root (not the root itself, and not outside allowed paths)" });
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
        // Sanitize before including in the response body — raw error messages may contain
        // internal paths, SQLite errors, or other details unsuitable for client exposure.
        warnings.push(sanitizeAdminError(msg));
      }
    }
    try {
      deps.diagnosticsStore.deleteProject(resolvedProjectId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("deleteProject: diagnostics cleanup failed", { projectId: resolvedProjectId, error: msg });
      warnings.push(sanitizeAdminError(msg));
    }

    if (projectDir) {
      try {
        await deleteProjectManifest(projectDir);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("deleteProject: manifest cleanup failed", { projectDir, error: msg });
        warnings.push(sanitizeAdminError(msg));
      }
      try {
        const sessionIds = deps.eventStore.findSessionIdsByProjectDir(projectDir);
        deps.eventStore.deleteSessions(sessionIds);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("deleteProject: session cleanup failed", { projectDir, error: msg });
        warnings.push(sanitizeAdminError(msg));
      }
    }

    try {
      deps.adminStore.deleteProject(resolvedProjectId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("deleteProject: adminStore cleanup failed", { projectId: resolvedProjectId, error: msg });
      warnings.push(sanitizeAdminError(msg));
    }

    // Return 207 Multi-Status when partial failures occurred so the caller knows
    // that some cleanup steps were skipped. 200 would mask silent data inconsistency.
    const status = warnings.length > 0 ? 207 : 200;
    return respondJson(res, status, { data: { projectId: resolvedProjectId, warnings } });
  }

  if (req.method === "GET" && pathName === "/api/admin/keys") {
    try {
      const keys = deps.adminStore.listApiKeys();
      return respondJson(res, 200, { data: keys });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to list keys";
      log.error("listApiKeys failed", { error: message });
      return respondJson(res, 500, { error: "Internal Server Error" });
    }
  }

  if (req.method === "POST" && pathName === "/api/admin/keys/rotate") {
    const result = await parseBody(req, rotateKeySchema);
    if (!isParseSuccess(result)) {
      return respondJson(res, 400, { error: result.error });
    }

    try {
      const rotateResult = deps.adminStore.createApiKey(result.data);
      return respondJson(res, 200, { data: rotateResult });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to rotate key";
      log.error("createApiKey failed", { error: message });
      return respondJson(res, 500, { error: "Internal Server Error" });
    }
  }

  if (req.method === "POST" && pathName === "/api/admin/keys/deactivate") {
    const result = await parseBody(req, deactivateKeySchema);
    if (!isParseSuccess(result)) {
      return respondJson(res, 400, { error: result.error });
    }

    try {
      deps.adminStore.deactivateApiKey(result.data.id);
      return respondJson(res, 200, { data: { id: result.data.id } });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to deactivate key";
      log.error("deactivateApiKey failed", { error: message });
      return respondJson(res, 500, { error: "Internal Server Error" });
    }
  }

  if (req.method === "GET" && pathName === "/api/admin/llm-config") {
    try {
      const config = deps.adminStore.getLLMConfig();
      return respondJson(res, 200, { data: config });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to get LLM config";
      log.error("getLLMConfig failed", { error: message });
      return respondJson(res, 500, { error: "Internal Server Error" });
    }
  }

  if (req.method === "POST" && pathName === "/api/admin/llm-config") {
    const result = await parseBody(req, setLLMConfigSchema);
    if (!isParseSuccess(result)) {
      return respondJson(res, 400, { error: result.error });
    }

    try {
      const setResult = deps.adminStore.setLLMConfig(result.data);
      return respondJson(res, 200, { data: setResult });
    } catch (error: unknown) {
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
  // Split only on the first space to handle edge cases. RFC 7235 §2.1 specifies the auth-scheme
  // is case-insensitive, so normalize to lowercase before comparing.
  const spaceIdx = header.indexOf(" ");
  const scheme = spaceIdx === -1 ? header : header.slice(0, spaceIdx);
  const encoded = spaceIdx === -1 ? "" : header.slice(spaceIdx + 1).trim();
  if (scheme.toLowerCase() !== "basic" || !encoded) {
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
  const rawApiKey = req.headers["x-api-key"];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  // ApiKeyManager.isValid hashes the supplied key with SHA-256 and performs a DB equality
  // lookup on the hash. The comparison is timing-safe because the timing-sensitive step
  // is the deterministic hash computation, not string comparison.
  if (!apiKeyManager.isValid(apiKey)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized", message: "Invalid API key" }));
    return false;
  }
  return true;
}

/**
 * Escape HTML special characters to prevent XSS when interpolating values into HTML.
 * Safe for both element content and attribute contexts (double-quoted or single-quoted).
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    // Fallback: payload contained a circular reference, BigInt, or other non-serializable value.
    // Use a safe literal so the client always receives a valid JSON body.
    body = JSON.stringify({ error: "Internal Server Error", message: "Response serialization failed" });
    status = 500;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    // Unconditional no-store: admin responses contain sensitive data (key lists, project IDs,
    // LLM config) and must never be cached by intermediary proxies or the browser.
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
  });
  res.end(body);
}

async function resolveProjectId(projectDir: string, adminStore: AdminStore): Promise<string | null> {
  const normalized = path.resolve(projectDir);
  const record = adminStore.findProjectByDir(normalized);
  if (record) {
    return record.projectId;
  }

  // Do not pre-check with existsSync — that creates a TOCTOU race: the directory could be
  // replaced between the existence check and the scan. scanProject will throw if the directory
  // is not accessible; the caller's catch block handles this as a 400 response.
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

async function deleteProjectManifest(projectDir: string): Promise<void> {
  // Defense-in-depth: re-check containment here even though the caller (handleAdminApi)
  // already called _isProjectDirSafe(). deleteProjectManifest is a standalone function
  // that could be invoked from other call sites in the future. A path-traversal escape
  // here would delete .ping-mem/manifest.json in arbitrary directories.
  // path.resolve normalises ../ sequences before the startsWith root check.
  if (!_isProjectDirSafe(projectDir)) {
    throw new Error("projectDir must be a subdirectory of an allowed root (not the root itself, and not outside allowed paths)");
  }
  const resolved = path.resolve(projectDir);
  const manifestPath = path.join(resolved, ".ping-mem", "manifest.json");
  // Use fs.promises.unlink with an ENOENT-tolerant catch so we avoid both sync I/O blocking
  // the event loop and the TOCTOU race between an existsSync check and the unlink call.
  await fs.unlink(manifestPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
  const manifestDir = path.join(resolved, ".ping-mem");
  try {
    const remaining = await fs.readdir(manifestDir);
    if (remaining.length === 0) {
      await fs.rmdir(manifestDir);
    }
  } catch (e: unknown) {
    // Directory does not exist — nothing to clean up.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

function renderAdminPage(nonce: string): string {
  const providerOptions = SUPPORTED_PROVIDERS.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  // escapeHtml applied to the JSON string: SUPPORTED_PROVIDERS are hardcoded safe strings today,
  // but future provider names containing < > & could otherwise create an XSS injection point.
  const providersJson = escapeHtml(JSON.stringify(SUPPORTED_PROVIDERS));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ping-mem Admin</title>
  <style nonce="${nonce}">
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
    // API key is stored in memory only (not sessionStorage) to reduce XSS exposure window.
    // Refreshing the page clears the key — a deliberate security trade-off.
    const state = {
      apiKey: "",
    };

    const apiKeyInput = document.getElementById("currentApiKey");
    const apiKeyStatus = document.getElementById("apiKeyStatus");
    const saveApiKey = document.getElementById("saveApiKey");

    if (!apiKeyInput || !apiKeyStatus || !saveApiKey) {
      console.error("Admin UI: missing required DOM elements (currentApiKey/apiKeyStatus/saveApiKey)");
    } else {
      saveApiKey.addEventListener("click", () => {
        state.apiKey = apiKeyInput.value.trim();
        apiKeyStatus.textContent = state.apiKey ? "Saved (in-memory only)" : "Missing";
      });
    }

    async function apiFetch(path, options = {}) {
      if (!state.apiKey) {
        throw new Error("Set API key first");
      }
      const headers = Object.assign(
        { "Content-Type": "application/json", "X-API-Key": state.apiKey },
        options.headers || {}
      );
      const response = await fetch(path, { ...options, headers });
      // Check ok before calling .json(): a non-JSON error body (e.g. proxy HTML error page,
      // plain-text 429) would throw a SyntaxError, masking the real HTTP error status.
      if (!response.ok) {
        let errMsg = "Request failed";
        try {
          const json = await response.json();
          errMsg = json?.message || json?.error || errMsg;
        } catch {
          errMsg = await response.text().catch(() => errMsg);
        }
        throw new Error(errMsg);
      }
      const json = await response.json();
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
      if (!table) { console.error("refreshKeys: missing DOM element keysTable"); return; }
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
            const statusEl = document.getElementById("apiKeyStatus");
            apiFetch("/api/admin/keys/deactivate", {
              method: "POST",
              body: JSON.stringify({ id: key.id }),
            }).then(() => refreshKeys()).catch((err) => {
              console.error("Deactivate key failed:", err);
              if (statusEl) statusEl.textContent = "Error: " + (err?.message ?? "Deactivate failed");
            });
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
      if (!result?.key) {
        console.error("rotateKey: unexpected response — no key in data", result);
        return;
      }
      const box = document.getElementById("newKeyBox");
      const value = document.getElementById("newKeyValue");
      if (!box || !value) {
        console.error("rotateKey: missing DOM elements newKeyBox/newKeyValue");
        return;
      }
      // Sync the in-memory API key so subsequent apiFetch calls (including refreshKeys)
      // use the new key instead of the now-deactivated old one.
      state.apiKey = result.key;
      const apiKeyInput = document.getElementById("currentApiKey") as HTMLInputElement | null;
      if (apiKeyInput) apiKeyInput.value = result.key;
      value.textContent = result.key;
      box.style.display = "block";
      refreshKeys().catch((err) => console.error("refreshKeys failed:", err));
    }

    async function refreshProjects() {
      const projects = await apiFetch("/api/admin/projects");
      const table = document.getElementById("projectsTable");
      if (!table) { console.error("refreshProjects: missing DOM element projectsTable"); return; }
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
          const statusNote = document.querySelector(".card h2");
          apiFetch("/api/admin/projects", {
            method: "DELETE",
            body: JSON.stringify({ projectDir: project.projectDir }),
          }).then(() => refreshProjects()).catch((err) => {
            console.error("Delete project failed:", err);
            if (statusNote) {
              const errEl = document.createElement("span");
              errEl.className = "error";
              errEl.textContent = " Error: " + (err?.message ?? "Delete failed");
              statusNote.appendChild(errEl);
              setTimeout(() => errEl.remove(), 5000);
            }
          });
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
      const providerEl = document.getElementById("llmProvider");
      const modelEl = document.getElementById("llmModel");
      const baseUrlEl = document.getElementById("llmBaseUrl");
      const statusEl = document.getElementById("llmStatus");
      if (!providerEl || !modelEl || !baseUrlEl || !statusEl) {
        console.error("loadLLMConfig: missing DOM elements");
        return;
      }
      providerEl.value = config.provider;
      modelEl.value = config.model || "";
      baseUrlEl.value = config.baseUrl || "";
      statusEl.textContent = config.hasApiKey ? "Configured" : "Missing";
    }

    async function saveLLMConfig() {
      const providerEl = document.getElementById("llmProvider");
      const modelEl = document.getElementById("llmModel");
      const baseUrlEl = document.getElementById("llmBaseUrl");
      const llmApiKeyEl = document.getElementById("llmApiKey");
      const statusEl = document.getElementById("llmStatus");
      if (!providerEl || !modelEl || !baseUrlEl || !llmApiKeyEl || !statusEl) {
        console.error("saveLLMConfig: missing DOM elements");
        return;
      }
      const payload = {
        provider: providerEl.value,
        model: modelEl.value,
        baseUrl: baseUrlEl.value,
        apiKey: llmApiKeyEl.value,
      };
      await apiFetch("/api/admin/llm-config", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      statusEl.textContent = "Saved";
      llmApiKeyEl.value = "";
    }

    // Wire up button event listeners with null-guards: if the HTML template ever changes
    // and an element is missing, we log an error instead of throwing a silent TypeError.
    const btn_refreshKeys = document.getElementById("refreshKeys");
    const btn_rotateKey = document.getElementById("rotateKey");
    const btn_refreshProjects = document.getElementById("refreshProjects");
    const btn_saveLLMConfig = document.getElementById("saveLLMConfig");

    if (btn_refreshKeys) btn_refreshKeys.addEventListener("click", () => refreshKeys().catch((err) => console.error("refreshKeys failed:", err)));
    else console.error("Admin UI: missing element refreshKeys");
    if (btn_rotateKey) btn_rotateKey.addEventListener("click", () => rotateKey().catch((err) => console.error("rotateKey failed:", err)));
    else console.error("Admin UI: missing element rotateKey");
    if (btn_refreshProjects) btn_refreshProjects.addEventListener("click", () => refreshProjects().catch((err) => console.error("refreshProjects failed:", err)));
    else console.error("Admin UI: missing element refreshProjects");
    if (btn_saveLLMConfig) btn_saveLLMConfig.addEventListener("click", () => saveLLMConfig().catch((err) => console.error("saveLLMConfig failed:", err)));
    else console.error("Admin UI: missing element saveLLMConfig");

    // Data is not auto-loaded on page open: the API key must be entered via 'Save for Admin UI'
    // before any API calls can be made. The key is stored in memory only (not sessionStorage)
    // to reduce the XSS exposure window — refreshing the page clears the key.
  </script>
</body>
</html>`;
}
