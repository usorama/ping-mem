/**
 * HTML layout template for ping-mem UI
 *
 * Renders the full page shell: sidebar nav, topbar, main content area.
 * All views use this layout for consistent structure.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Layout");

function computeSri(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha384").update(content).digest("base64");
    return `sha384-${hash}`;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn("SRI hash computation failed — SRI protection disabled for this asset", { filePath, error: msg });
    return "";
  }
}

const staticDir = process.env.PING_MEM_STATIC_DIR ?? path.resolve(process.cwd(), "src/static");
const SRI_HTMX = computeSri(path.join(staticDir, "htmx.min.js"));
const SRI_CHAT = computeSri(path.join(staticDir, "chat.js"));

export type UIRoute = "dashboard" | "memories" | "diagnostics" | "ingestion" | "agents" | "knowledge" | "sessions" | "events" | "worklog" | "codebase" | "eval" | "insights" | "mining" | "profile";

interface LayoutOptions {
  title: string;
  content: string;
  activeRoute: UIRoute;
  /** CSP nonce for inline scripts (required for nonce-based CSP) */
  nonce?: string | undefined;
  /** CSRF token for state-changing requests from HTMX */
  csrfToken?: string | undefined;
}

const NAV_ITEMS: Array<{ route: UIRoute; path: string; icon: string; label: string }> = [
  { route: "dashboard", path: "/ui", icon: "\u25A3", label: "Dashboard" },
  { route: "memories", path: "/ui/memories", icon: "\u29C9", label: "Memories" },
  { route: "diagnostics", path: "/ui/diagnostics", icon: "\u2261", label: "Diagnostics" },
  { route: "ingestion", path: "/ui/ingestion", icon: "\u21BB", label: "Ingestion" },
  { route: "agents", path: "/ui/agents", icon: "\u2295", label: "Agents" },
  { route: "knowledge", path: "/ui/knowledge", icon: "\u25C8", label: "Knowledge" },
  { route: "sessions", path: "/ui/sessions", icon: "\u25A1", label: "Sessions" },
  { route: "events", path: "/ui/events", icon: "\u2261", label: "Events" },
  { route: "worklog", path: "/ui/worklog", icon: "\u25F7", label: "Worklog" },
  { route: "codebase", path: "/ui/codebase", icon: "\u2302", label: "Codebase" },
  { route: "eval", path: "/ui/eval", icon: "\u2261", label: "Eval" },
  { route: "insights", path: "/ui/insights", icon: "\u25CE", label: "Insights" },
  { route: "mining", path: "/ui/mining", icon: "\u25BC", label: "Mining" },
  { route: "profile", path: "/ui/profile", icon: "\u25A6", label: "Profile" },
];

export function renderLayout(options: LayoutOptions): string {
  const { title, content, activeRoute, nonce, csrfToken } = options;
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";

  const navLinks = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.path}" class="${item.route === activeRoute ? "active" : ""}">
        <span class="nav-icon">${item.icon}</span>
        ${item.label}
      </a>`
  ).join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeHtml(csrfToken ?? '')}">
  <title>${escapeHtml(title)} - ping-mem</title>
  <link rel="stylesheet" href="/static/styles.css">
  <script src="/static/htmx.min.js" defer${nonceAttr}${SRI_HTMX ? ` integrity="${SRI_HTMX}" crossorigin="anonymous"` : ""}></script>
  <script src="/static/chat.js" defer${nonceAttr}${SRI_CHAT ? ` integrity="${SRI_CHAT}" crossorigin="anonymous"` : ""}></script>
  <script${nonceAttr}>
    // Theme: check localStorage before paint to prevent flash
    (function() {
      var t = localStorage.getItem('ping-mem-theme');
      if (t) document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
</head>
<body>
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h1>ping-mem</h1>
        <div class="subtitle">observability</div>
      </div>
      <nav class="sidebar-nav">
        ${navLinks}
      </nav>
      <div class="sidebar-footer">
        <a href="/admin" style="color:inherit;text-decoration:none;font-size:11px;">Admin Panel</a>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="flex items-center gap-4">
          <button class="hamburger" id="hamburger-btn" aria-label="Menu">&#9776;</button>
          <span class="topbar-title">${escapeHtml(title)}</span>
        </div>
        <div class="topbar-actions">
          <span id="health-dot" class="health-dot" title="Checking..."
            hx-get="/ui/partials/health" hx-trigger="load, every 30s" hx-swap="outerHTML"></span>
          <button class="theme-toggle" id="theme-toggle-btn" title="Toggle theme" aria-label="Toggle theme">
            <span id="theme-icon">&#9789;</span>
          </button>
        </div>
      </header>

      <main class="content">
        ${content}
      </main>
    </div>
  </div>

  <div class="toast-container" id="toast-container"></div>

  <script${nonceAttr}>
    function toggleTheme() {
      var html = document.documentElement;
      var current = html.getAttribute('data-theme');
      var next = current === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      localStorage.setItem('ping-mem-theme', next);
      document.getElementById('theme-icon').textContent = next === 'dark' ? '\\u2600' : '\\u263D';
    }
    // Set icon on load
    (function() {
      var t = document.documentElement.getAttribute('data-theme');
      var icon = document.getElementById('theme-icon');
      if (icon && t === 'dark') icon.textContent = '\\u2600';
    })();

    // Toast helper
    function showToast(message) {
      var container = document.getElementById('toast-container');
      var toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(function() { toast.remove(); }, 4000);
    }

    // Listen for HTMX toast events
    document.body.addEventListener('showToast', function(e) {
      showToast(e.detail.value || e.detail);
    });

    // Bind button handlers (avoids inline onclick which CSP blocks)
    document.getElementById('hamburger-btn').addEventListener('click', function() {
      document.getElementById('sidebar').classList.toggle('open');
    });
    document.getElementById('theme-toggle-btn').addEventListener('click', toggleTheme);

    // Event delegation for dynamically loaded HTMX partials
    document.addEventListener('click', function(e) {
      if (e.target && e.target.id === 'detail-close-btn') {
        var panel = document.getElementById('detail-panel');
        if (panel) panel.textContent = '';
      }
    });

    // CSRF: inject token header into all HTMX requests
    document.addEventListener('DOMContentLoaded', function() {
      var csrfMeta = document.querySelector('meta[name="csrf-token"]');
      if (csrfMeta) {
        document.body.setAttribute('hx-headers', JSON.stringify({'x-csrf-token': csrfMeta.content}));
      }
      // Configure htmx CSP nonce so inline style mutations don't violate style-src
      if (window.htmx) {
        htmx.config.inlineStyleNonce = '${nonce ?? ""}';
      }
    });
  </script>
</body>
</html>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\x60/g, "&#96;");
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();

  // Future dates
  if (diff < 0) {
    const seconds = Math.floor(-diff / 1000);
    if (seconds < 60) return `in ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.floor(hours / 24);
    return `in ${days}d`;
  }

  // Past dates
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Safely retrieve the CSP nonce from a Hono context.
 * Returns undefined if context doesn't have the get() method (e.g. in test mocks).
 */
export function getCspNonce(c: { get?: (key: string) => unknown }): string | undefined {
  if (typeof c.get === "function") {
    return c.get("cspNonce") as string | undefined;
  }
  return undefined;
}

/**
 * Safely retrieve the CSRF token from a Hono context.
 * Returns undefined if context doesn't have the get() method (e.g. in test mocks).
 */
export function getCsrfToken(c: { get?: (key: string) => unknown }): string | undefined {
  if (typeof c.get === "function") {
    return c.get("csrfToken") as string | undefined;
  }
  return undefined;
}

/**
 * Get client IP address from a Hono context.
 *
 * When TRUST_PROXY env var is set to "1" or "true", uses X-Forwarded-For
 * or X-Real-IP headers (suitable when behind a trusted reverse proxy like
 * nginx, Cloudflare, etc.).
 *
 * When TRUST_PROXY is not set, falls back to "unknown" since forwarded
 * headers can be trivially spoofed by clients.
 */
// Cache conninfo getter for Bun runtime (lazy-loaded, avoids import issues in tests)
let _getConnInfo: ((c: unknown) => { remote: { address?: string } }) | null | false = null;

export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy === "1" || trustProxy === "true") {
    // Behind a trusted proxy — use forwarded headers
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      // X-Forwarded-For can be comma-separated; first entry is the original client
      const first = forwarded.split(",")[0];
      return first ? first.trim() : "unknown";
    }
    return c.req.header("x-real-ip") ?? "unknown";
  }
  // No trusted proxy — use Bun's socket-level IP via conninfo (not spoofable)
  if (_getConnInfo === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy-load to avoid test/non-Bun failures
      _getConnInfo = require("hono/bun").getConnInfo;
    } catch (err) {
      log.warn("Failed to load hono/bun getConnInfo", { error: err instanceof Error ? err.message : String(err) });
      _getConnInfo = false; // Mark as unavailable so we don't retry
    }
  }
  if (_getConnInfo) {
    // Guard: getConnInfo requires c.env to be an Object (set by Bun's serve adapter)
    const ctx = c as Record<string, unknown>;
    if (ctx.env && typeof ctx.env === "object") {
      try {
        const info = _getConnInfo(c);
        if (info?.remote?.address) return info.remote.address;
      } catch {
        // Fall through to "unknown" — don't log per-request
      }
    }
  }
  return "unknown";
}
