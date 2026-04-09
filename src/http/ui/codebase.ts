/**
 * Codebase Architecture view for ping-mem UI
 *
 * Serves the codebase overview diagram as an embedded page within the
 * ping-mem UI layout. The diagram content is stored as a static HTML file
 * and rendered inside an iframe for style isolation.
 */

import type { Context } from "hono";
import * as fs from "fs";
import * as path from "path";
import { renderLayout, getCspNonce, getCsrfToken, escapeHtml } from "./layout.js";
import type { UIDependencies } from "./routes.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Codebase");

/**
 * Resolve the path to the codebase diagram HTML file.
 * Checks multiple locations: static dir, project root, home agent dir.
 */
function resolveDiagramPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "src/static/codebase-diagram.html"),
    path.resolve(process.cwd(), "static/codebase-diagram.html"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function registerCodebaseRoutes(_deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);

      const diagramPath = resolveDiagramPath();

      let content: string;
      if (diagramPath) {
        // Serve the diagram in an iframe for style isolation
        content = `
          <div style="display:flex;flex-direction:column;height:calc(100vh - 120px);">
            <div style="display:flex;align-items:center;justify-content:between;margin-bottom:12px;gap:12px;">
              <span style="font-size:13px;color:var(--text-dim)">Interactive codebase architecture diagram with Mermaid visualizations</span>
              <a href="/static/codebase-diagram.html" target="_blank"
                 style="font-size:12px;color:var(--primary);text-decoration:none;margin-left:auto;">
                Open in new tab &rarr;
              </a>
            </div>
            <iframe
              src="/static/codebase-diagram.html"
              style="flex:1;border:1px solid var(--border);border-radius:8px;width:100%;background:#08111f;"
              sandbox="allow-scripts"
              title="Codebase Architecture Diagram"
            ></iframe>
          </div>
        `;
      } else {
        content = `
          <div class="card" style="padding:24px;text-align:center;">
            <p style="color:var(--text-dim);margin-bottom:12px;">
              Codebase diagram not found. Place <code>codebase-diagram.html</code> in <code>src/static/</code>.
            </p>
            <p style="font-size:12px;color:var(--text-dim);">
              Expected at: <code>src/static/codebase-diagram.html</code>
            </p>
          </div>
        `;
      }

      return c.html(renderLayout({
        title: "Codebase",
        content,
        activeRoute: "codebase",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Codebase",
        content: `<div class="card" style="padding:24px;color:var(--error)">Codebase error: ${escapeHtml(errMsg)}. Check server logs.</div>`,
        activeRoute: "codebase",
        nonce,
        csrfToken,
      }));
    }
  };
}
