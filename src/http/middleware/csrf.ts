/**
 * CSRF protection middleware for ping-mem UI routes.
 *
 * Sets a CSRF token cookie on GET requests and validates it on state-changing requests.
 * API clients using API keys (X-API-Key or Authorization: Bearer) bypass CSRF
 * since they don't rely on cookies for authentication.
 */

import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";

const CSRF_HEADER = "x-csrf-token";
const CSRF_COOKIE = "csrf_token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Generate a random CSRF token
 */
export function generateCsrfToken(): string {
  return crypto.randomUUID();
}

/**
 * CSRF protection middleware.
 * Sets a CSRF token cookie on GET requests and validates it on state-changing requests.
 * For API clients using API keys, CSRF is not required (they don't use cookies).
 */
export function csrfProtection() {
  return createMiddleware(async (c: Context, next: Next) => {
    // Skip CSRF for API key authenticated requests (non-browser clients)
    if (c.req.header("x-api-key") || c.req.header("authorization")?.startsWith("Bearer ")) {
      return next();
    }

    if (SAFE_METHODS.has(c.req.method)) {
      // Set CSRF token cookie on safe methods
      const token = generateCsrfToken();
      c.set("csrfToken", token);
      c.header("Set-Cookie", `${CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure`);
      return next();
    }

    // Validate CSRF token on state-changing methods
    const headerToken = c.req.header(CSRF_HEADER);
    const cookieHeader = c.req.header("cookie") ?? "";
    const rawCookie = cookieHeader
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${CSRF_COOKIE}=`));
    const cookieToken = rawCookie !== undefined
      ? rawCookie.substring(`${CSRF_COOKIE}=`.length)
      : undefined;

    if (!headerToken || !cookieToken
      || headerToken.length !== cookieToken.length
      || !timingSafeEqual(Buffer.from(headerToken), Buffer.from(cookieToken))) {
      return c.json({ error: "Forbidden", message: "Invalid or missing CSRF token" }, 403);
    }

    return next();
  });
}
