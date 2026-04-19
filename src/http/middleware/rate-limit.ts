/**
 * Rate limiting middleware for ping-mem REST API.
 *
 * In-memory sliding-window rate limiter keyed by client IP.
 * Supports multiple named stores for different route groups.
 */

import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import { getClientIp } from "../ui/layout.js";

const stores = new Map<string, Map<string, { count: number; resetAt: number }>>();

export function rateLimiter(options: {
  name: string;
  maxRequests: number;
  windowMs: number;
  maxMapSize?: number;
  /** Optional predicate — when it returns true the request bypasses the limiter entirely. */
  skip?: (c: Context) => boolean;
  /** Elevated quota for admin-authed callers. Used when isAdmin(c) is true. */
  adminMaxRequests?: number;
  isAdmin?: (c: Context) => boolean;
}) {
  const { name, maxRequests, windowMs, maxMapSize = 10_000, skip, adminMaxRequests, isAdmin } = options;
  if (!stores.has(name)) stores.set(name, new Map());
  const limits = stores.get(name)!;

  return createMiddleware(async (c: Context, next: Next) => {
    if (skip?.(c)) return next();

    const ip = getClientIp(c);
    const now = Date.now();
    const admin = isAdmin?.(c) === true;
    const effectiveMax = admin && adminMaxRequests !== undefined ? adminMaxRequests : maxRequests;

    // Evict expired entries if map too large
    if (limits.size > maxMapSize) {
      for (const [key, entry] of limits) {
        if (now > entry.resetAt) limits.delete(key);
      }
    }

    // Admin and non-admin share the same IP-keyed bucket, but admin enjoys
    // a higher ceiling. This prevents admin bursts from starving non-admin
    // traffic, and prevents a compromised admin cred from DoS-ing the process.
    const entry = limits.get(ip);
    if (!entry || now > entry.resetAt) {
      limits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > effectiveMax) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({ error: "Too Many Requests", message: "Rate limit exceeded" }, 429);
    }
    return next();
  });
}
