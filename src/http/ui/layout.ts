/**
 * HTML layout template for ping-mem UI
 *
 * Renders the full page shell: sidebar nav, topbar, main content area.
 * All views use this layout for consistent structure.
 */

export type UIRoute = "dashboard" | "memories" | "diagnostics" | "ingestion";

interface LayoutOptions {
  title: string;
  content: string;
  activeRoute: UIRoute;
  /** CSP nonce for inline scripts (required for nonce-based CSP) */
  nonce?: string | undefined;
}

const NAV_ITEMS: Array<{ route: UIRoute; path: string; icon: string; label: string }> = [
  { route: "dashboard", path: "/ui", icon: "\u25A3", label: "Dashboard" },
  { route: "memories", path: "/ui/memories", icon: "\u29C9", label: "Memories" },
  { route: "diagnostics", path: "/ui/diagnostics", icon: "\u2261", label: "Diagnostics" },
  { route: "ingestion", path: "/ui/ingestion", icon: "\u21BB", label: "Ingestion" },
];

export function renderLayout(options: LayoutOptions): string {
  const { title, content, activeRoute, nonce } = options;
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";

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
  <title>${escapeHtml(title)} - ping-mem</title>
  <link rel="stylesheet" href="/static/styles.css">
  <script src="/static/htmx.min.js" defer${nonceAttr}></script>
  <script src="/static/chat.js" defer${nonceAttr}></script>
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
        if (panel) panel.innerHTML = '';
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
    .replace(/'/g, "&#39;");
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
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
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
 * Get client IP address from a Hono context.
 *
 * When TRUST_PROXY env var is set to "1" or "true", uses X-Forwarded-For
 * or X-Real-IP headers (suitable when behind a trusted reverse proxy like
 * nginx, Cloudflare, etc.).
 *
 * When TRUST_PROXY is not set, falls back to "unknown" since forwarded
 * headers can be trivially spoofed by clients.
 */
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
  // No trusted proxy — do not trust forwarded headers as they are spoofable
  return "unknown";
}
