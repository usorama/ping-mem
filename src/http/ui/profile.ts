/**
 * Profile view for ping-mem UI
 *
 * Displays the active user profile: name, role, expertise tags,
 * active projects tags, current focus, and last updated timestamp.
 */

import type { Context } from "hono";
import { renderLayout, escapeHtml, formatDate, getCspNonce, getCsrfToken } from "./layout.js";
import { badge, emptyState } from "./components.js";
import type { UIDependencies } from "./routes.js";
import { UserProfileStore } from "../../profile/UserProfile.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("UI:Profile");

export function registerProfileRoutes(_deps: UIDependencies) {
  return async (c: Context) => {
    try {
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);

      const profileStore = new UserProfileStore();
      const profile = profileStore.getProfile("default");

      let profileContent: string;

      if (!profile) {
        profileContent = emptyState(
          "No user profile found. Profile is populated automatically when mining runs.",
          "\u25A6"
        );
      } else {
        const expertiseTags = profile.expertise.length > 0
          ? profile.expertise.map((e: string) => badge(e, "info")).join(" ")
          : `<span style="color:var(--text-secondary);font-size:13px">None set</span>`;

        const projectTags = profile.activeProjects.length > 0
          ? profile.activeProjects.map((p: string) => badge(p, "success")).join(" ")
          : `<span style="color:var(--text-secondary);font-size:13px">None set</span>`;

        const focusList = profile.currentFocus.length > 0
          ? `<ul style="margin:0;padding-left:20px;color:var(--text-primary)">${
              profile.currentFocus.map((f: string) => `<li>${escapeHtml(f)}</li>`).join("")
            }</ul>`
          : `<span style="color:var(--text-secondary);font-size:13px">None set</span>`;

        profileContent = `
          <div class="card" style="max-width:640px">
            <div class="card-header" style="display:flex;align-items:center;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--border)">
              <div style="width:56px;height:56px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff;flex-shrink:0">
                &#9634;
              </div>
              <div>
                <div style="font-size:20px;font-weight:600;color:var(--text-primary)">${escapeHtml(profile.name ?? "Unknown User")}</div>
                <div style="font-size:13px;color:var(--text-secondary);margin-top:2px">${escapeHtml(profile.role ?? "No role set")}</div>
              </div>
            </div>

            <div style="padding:20px 0;display:grid;gap:20px">
              <div>
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-secondary);margin-bottom:8px">Expertise</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px">${expertiseTags}</div>
              </div>

              <div>
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-secondary);margin-bottom:8px">Active Projects</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px">${projectTags}</div>
              </div>

              <div>
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-secondary);margin-bottom:8px">Current Focus</div>
                ${focusList}
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                <div>
                  <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-secondary);margin-bottom:4px">Relevance Threshold</div>
                  <div style="font-size:15px;font-weight:500;color:var(--text-primary)">${profile.relevanceThreshold.toFixed(2)}</div>
                </div>
                <div>
                  <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-secondary);margin-bottom:4px">Auto-Checkpoint</div>
                  <div style="font-size:15px;font-weight:500;color:var(--text-primary)">${Math.round(profile.autoCheckpointInterval / 60000)} min</div>
                </div>
              </div>

              <div style="padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary)">
                Last updated: ${formatDate(profile.updatedAt)}
              </div>
            </div>
          </div>
        `;
      }

      const content = `
        <div class="page-header" style="margin-bottom:20px">
          <p style="color:var(--text-secondary);margin:0">
            User profile populated from conversation mining. Used to personalize memory relevance.
          </p>
        </div>
        ${profileContent}
      `;

      return c.html(renderLayout({
        title: "Profile",
        content,
        activeRoute: "profile",
        nonce,
        csrfToken,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Page render error", { error: errMsg });
      const nonce = getCspNonce(c);
      const csrfToken = getCsrfToken(c);
      return c.html(renderLayout({
        title: "Profile",
        content: emptyState(`Profile unavailable: ${errMsg}`),
        activeRoute: "profile",
        nonce,
        csrfToken,
      }));
    }
  };
}
