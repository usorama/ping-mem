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
}) {
  const { name, maxRequests, windowMs, maxMapSize = 10_000 } = options;
  if (!stores.has(name)) stores.set(name, new Map());
  const limits = stores.get(name)!;

  return createMiddleware(async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const now = Date.now();

    // Evict expired entries if map too large
    if (limits.size > maxMapSize) {
      for (const [key, entry] of limits) {
        if (now > entry.resetAt) limits.delete(key);
      }
    }

    const entry = limits.get(ip);
    if (!entry || now > entry.resetAt) {
      limits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return c.json({ error: "Too Many Requests", message: "Rate limit exceeded" }, 429);
    }
    return next();
  });
}
