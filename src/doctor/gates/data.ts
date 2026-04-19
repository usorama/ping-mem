/**
 * Data gates (4):
 *   data.commit-coverage, data.file-coverage, data.last-ingest-age, data.sync-lag.
 *
 * Each gate loops over CANONICAL_PROJECTS and reports the weakest project.
 * Coverage thresholds are per plan §101: ≥95% commit coverage, ≥95% file coverage.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { DoctorGate } from "../gates.js";
import { CANONICAL_PROJECTS, fetchWithTimeout, runCmd } from "../util.js";

const COMMIT_COVERAGE_MIN = 0.95;
const FILE_COVERAGE_MIN = 0.95;
const LAST_INGEST_MAX_AGE_H = 48;
const SYNC_LAG_MAX_MIN = 60;
// Marker fallback: markers only update on content change, so a stable repo
// with a healthy hook will show stale markers. 24h catches "hook actually
// broken" without false-alarming on "nothing changed today".
const SYNC_MARKER_FALLBACK_MAX_MIN = 24 * 60;

interface ProjectStats {
  projectId: string;
  rootPath: string;
  filesCount: number;
  commitsCount: number;
  lastIngestedAt: string | null;
}

function adminAuthHeader(user: string | undefined, pass: string | undefined): HeadersInit {
  if (!user || !pass) return {};
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

// Cache listProjects for the duration of a single doctor run — 3 data gates
// share the same data. Use a promise-memo so concurrent callers share one
// in-flight fetch instead of racing.
let projectsPromise: Promise<ProjectStats[]> | null = null;
let projectsCacheTs = 0;
const PROJECTS_CACHE_MS = 5_000;

async function listProjects(restUrl: string, user: string | undefined, pass: string | undefined): Promise<ProjectStats[]> {
  const now = Date.now();
  if (projectsPromise && now - projectsCacheTs < PROJECTS_CACHE_MS) {
    return projectsPromise;
  }
  projectsCacheTs = now;
  projectsPromise = (async () => {
    try {
      const { status, body } = await fetchWithTimeout(
        `${restUrl}/api/v1/codebase/projects?limit=500`,
        { headers: adminAuthHeader(user, pass) },
        4500,
      );
      if (status !== 200) return [];
      const parsed = JSON.parse(body) as { data?: { projects?: ProjectStats[] } };
      return parsed.data?.projects ?? [];
    } catch {
      return [];
    }
  })();
  return projectsPromise;
}

function matchProject(projects: ProjectStats[], rootPath: string): ProjectStats | undefined {
  // Match by rootPath, tolerant to:
  //   - trailing slash
  //   - host path (/Users/umasankr/Projects/foo) vs container path (/projects/foo)
  // The ping-mem container mounts /Users/umasankr/Projects → /projects, so both
  // representations refer to the same project.
  const norm = rootPath.replace(/\/+$/, "");
  const containerNorm = norm.replace(/^\/Users\/umasankr\/Projects/, "/projects");
  return projects.find((p) => {
    const pNorm = p.rootPath.replace(/\/+$/, "");
    return pNorm === norm || pNorm === containerNorm;
  });
}

async function actualCommitCount(rootPath: string): Promise<number> {
  if (!fs.existsSync(path.join(rootPath, ".git"))) return 0;
  // argv form avoids shell interpolation of rootPath (defence-in-depth; path
  // comes from a static CANONICAL_PROJECTS list today, but don't let that drift).
  const { stdout, code } = await runCmd("git", ["-C", rootPath, "rev-list", "--count", "HEAD"]);
  if (code !== 0) return 0;
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

// Mirror ProjectScanner's DEFAULT_IGNORE_DIRS + DEFAULT_EXCLUDE_EXTENSIONS so
// the ratio "ingested / actual" uses the same denominator the scanner uses.
// Counting raw `git ls-files` would compare against images, .pdf, .log, .d.ts,
// .min.js, etc. which the scanner intentionally filters out, guaranteeing the
// gate fails on any repo with >5% non-text artefacts.
const SCANNER_IGNORE_DIRS = new Set([
  ".git", ".svn", ".hg", "node_modules", "dist", "build", ".next", ".cache",
  ".venv", "venv", "__pycache__", ".ping-mem", ".worktrees", ".claude",
  ".vscode", ".idea", ".overstory", "coverage", "tmp", "temp", "out",
  ".turbo", ".parcel-cache", ".swc", "vendor", ".terraform", ".serverless",
  "e2e-tests", ".autoresearch", ".beads", ".mulch", ".playwright-mcp",
  ".deployments", "snapshots",
]);
const SCANNER_EXCLUDE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".webp", ".ico", ".svg",
  ".mp4", ".webm", ".mp3", ".wav", ".ogg", ".pdf", ".doc", ".docx", ".xls",
  ".xlsx", ".ppt", ".pptx", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".eot", ".otf", ".exe", ".dll", ".so", ".dylib",
  ".pyc", ".pyo", ".class", ".db", ".sqlite", ".sqlite3", ".lock", ".d.ts",
  ".map", ".min.js", ".min.css", ".snap", ".log", ".wasm", ".pbxproj",
  ".xcworkspacedata", ".xcscheme", ".tsbuildinfo",
]);

function readIgnoreEntries(filePath: string): { dirNames: Set<string>; pathPrefixes: string[] } {
  const dirNames = new Set<string>();
  const pathPrefixes: string[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const rawLine of content.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      const cleaned = trimmed.replace(/^\//, "").replace(/\/+$/, "");
      if (!cleaned) continue;
      if (cleaned.includes("*") || cleaned.includes("?")) continue;
      if (cleaned.includes("/")) pathPrefixes.push(cleaned);
      else dirNames.add(cleaned);
    }
  } catch {
    /* file absent — ignore */
  }
  return { dirNames, pathPrefixes };
}

function isFileScanEligible(
  relPath: string,
  extraIgnoreDirs: Set<string>,
  extraIgnorePrefixes: readonly string[],
): boolean {
  const parts = relPath.split("/");
  for (const part of parts.slice(0, -1)) {
    if (SCANNER_IGNORE_DIRS.has(part)) return false;
    if (extraIgnoreDirs.has(part)) return false;
  }
  for (const prefix of extraIgnorePrefixes) {
    if (relPath === prefix || relPath.startsWith(prefix + "/")) return false;
  }
  const last = parts[parts.length - 1] ?? "";
  const lowerLast = last.toLowerCase();
  // Compound extensions (.d.ts, .min.js, .min.css)
  if (lowerLast.endsWith(".d.ts") || lowerLast.endsWith(".min.js") || lowerLast.endsWith(".min.css")) {
    return false;
  }
  const lastDot = lowerLast.lastIndexOf(".");
  if (lastDot >= 0) {
    const ext = lowerLast.slice(lastDot);
    if (SCANNER_EXCLUDE_EXT.has(ext)) return false;
  }
  return true;
}

async function actualFileCount(rootPath: string): Promise<number> {
  if (!fs.existsSync(path.join(rootPath, ".git"))) return 0;
  const { stdout, code } = await runCmd("git", ["-C", rootPath, "ls-files"]);
  if (code !== 0) return 0;
  const lines = stdout.split("\n").filter((l) => l.length > 0);

  // Mirror ProjectScanner's ignore-file parsing: .gitignore + .pingmemignore
  // (directory-name entries go in the set; path-prefix entries stay literal).
  const extraDirs = new Set<string>();
  const extraPrefixes: string[] = [];
  for (const f of [".gitignore", ".pingmemignore"]) {
    const entries = readIgnoreEntries(path.join(rootPath, f));
    for (const d of entries.dirNames) extraDirs.add(d);
    extraPrefixes.push(...entries.pathPrefixes);
  }

  let n = 0;
  for (const rel of lines) {
    if (isFileScanEligible(rel, extraDirs, extraPrefixes)) n++;
  }
  return n;
}

export const dataGates: DoctorGate[] = [
  {
    id: "data.commit-coverage",
    group: "data",
    description: `All canonical projects ≥${(COMMIT_COVERAGE_MIN * 100).toFixed(0)}% commit coverage`,
    async run(ctx) {
      const projects = await listProjects(ctx.restUrl, ctx.adminUser, ctx.adminPass);
      if (projects.length === 0) return { status: "skip", detail: "no projects listed" };

      // Parallel per-project git calls — 5 projects serially exceeded the 5s gate budget.
      const rows = await Promise.all(
        CANONICAL_PROJECTS.map(async (root) => {
          const p = matchProject(projects, root);
          const actual = await actualCommitCount(root);
          const ingested = p?.commitsCount ?? 0;
          const pct = actual === 0 ? 1 : ingested / actual;
          return { name: path.basename(root), pct, count: ingested, actual };
        }),
      );
      const worst = rows.reduce((a, b) => (a.pct < b.pct ? a : b));
      const pass = worst.pct >= COMMIT_COVERAGE_MIN;
      return {
        status: pass ? "pass" : "fail",
        detail: `weakest=${worst.name} ${(worst.pct * 100).toFixed(1)}% (${worst.count}/${worst.actual})`,
        metrics: { worstPct: Number(worst.pct.toFixed(4)), minPct: COMMIT_COVERAGE_MIN },
      };
    },
  },

  {
    id: "data.file-coverage",
    group: "data",
    description: `All canonical projects ≥${(FILE_COVERAGE_MIN * 100).toFixed(0)}% file coverage`,
    async run(ctx) {
      const projects = await listProjects(ctx.restUrl, ctx.adminUser, ctx.adminPass);
      if (projects.length === 0) return { status: "skip", detail: "no projects listed" };

      const rows = await Promise.all(
        CANONICAL_PROJECTS.map(async (root) => {
          const p = matchProject(projects, root);
          const actual = await actualFileCount(root);
          const ingested = p?.filesCount ?? 0;
          const pct = actual === 0 ? 1 : ingested / actual;
          return { name: path.basename(root), pct, count: ingested, actual };
        }),
      );
      const worst = rows.reduce((a, b) => (a.pct < b.pct ? a : b));
      const pass = worst.pct >= FILE_COVERAGE_MIN;
      return {
        status: pass ? "pass" : "fail",
        detail: `weakest=${worst.name} ${(worst.pct * 100).toFixed(1)}% (${worst.count}/${worst.actual})`,
        metrics: { worstPct: Number(worst.pct.toFixed(4)), minPct: FILE_COVERAGE_MIN },
      };
    },
  },

  {
    id: "data.last-ingest-age",
    group: "data",
    description: `Each canonical project ingested within ${LAST_INGEST_MAX_AGE_H}h`,
    async run(ctx) {
      const projects = await listProjects(ctx.restUrl, ctx.adminUser, ctx.adminPass);
      if (projects.length === 0) return { status: "skip", detail: "no projects listed" };

      const now = Date.now();
      const rows: Array<{ name: string; ageH: number }> = [];
      for (const root of CANONICAL_PROJECTS) {
        const p = matchProject(projects, root);
        if (!p || !p.lastIngestedAt) {
          rows.push({ name: path.basename(root), ageH: Number.POSITIVE_INFINITY });
          continue;
        }
        const ageH = (now - new Date(p.lastIngestedAt).getTime()) / 3_600_000;
        rows.push({ name: path.basename(root), ageH });
      }
      const worst = rows.reduce((a, b) => (a.ageH > b.ageH ? a : b));
      const pass = worst.ageH <= LAST_INGEST_MAX_AGE_H;
      return {
        status: pass ? "pass" : "fail",
        detail: `oldest=${worst.name} ${Number.isFinite(worst.ageH) ? worst.ageH.toFixed(1) + "h" : "never"}`,
        metrics: { worstAgeH: Number.isFinite(worst.ageH) ? Number(worst.ageH.toFixed(2)) : -1, maxAgeH: LAST_INGEST_MAX_AGE_H },
      };
    },
  },

  {
    id: "data.sync-lag",
    group: "data",
    description: `Native-sync hook ran within ${SYNC_LAG_MAX_MIN} min (heartbeat) or changed content within ${SYNC_MARKER_FALLBACK_MAX_MIN / 60} h`,
    async run(ctx) {
      // Measure "when did the native-sync hook last RUN" (not "when was new content ingested").
      // Prefer a dedicated sync-heartbeat touched every hook run; fall back to sync-session-id
      // (only rewritten on session rotation) and finally to newest sync-marker (only updated
      // on content change — generous 24h threshold so stable repos don't false-alarm).
      const heartbeatFile = path.join(ctx.pingMemDir, "sync-heartbeat");
      const sessionIdFile = path.join(ctx.pingMemDir, "sync-session-id");
      let newestMs = 0;
      let source = "none";
      // Track stat failures so "hook never ran" vs "permission denied" are
      // distinguishable in the fail message.
      let statErrors = 0;
      if (fs.existsSync(heartbeatFile)) {
        try {
          newestMs = fs.statSync(heartbeatFile).mtimeMs;
          source = "sync-heartbeat";
        } catch {
          statErrors++;
        }
      }
      if (newestMs === 0 && fs.existsSync(sessionIdFile)) {
        try {
          newestMs = fs.statSync(sessionIdFile).mtimeMs;
          source = "sync-session-id";
        } catch {
          statErrors++;
        }
      }

      // Also walk sync-markers/ for fallback + visibility.
      const markerDir = path.join(ctx.pingMemDir, "sync-markers");
      let markerNewestMs = 0;
      let fileCount = 0;
      if (fs.existsSync(markerDir)) {
        const walk = (dir: string, depth: number): void => {
          if (depth > 6) return; // safety cap
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              walk(full, depth + 1);
            } else if (e.isFile()) {
              try {
                const s = fs.statSync(full);
                if (s.mtimeMs > markerNewestMs) markerNewestMs = s.mtimeMs;
                fileCount++;
              } catch {
                statErrors++;
              }
            }
          }
        };
        walk(markerDir, 0);
      }

      if (newestMs === 0 && markerNewestMs === 0) {
        const detail = statErrors > 0
          ? `sync files may exist but statSync failed ${statErrors}× — check permissions on ${ctx.pingMemDir}`
          : "no sync heartbeat and no markers (hook never ran?)";
        return { status: "fail", detail };
      }
      if (newestMs === 0) {
        newestMs = markerNewestMs;
        source = "marker-fallback";
      }
      const ageMin = (Date.now() - newestMs) / 60_000;
      // Heartbeat/session-id want <60min (hook should run frequently).
      // Marker fallback wants <24h (stable repo, no recent content change is fine).
      const threshold = source === "marker-fallback" ? SYNC_MARKER_FALLBACK_MAX_MIN : SYNC_LAG_MAX_MIN;
      const pass = ageMin <= threshold;
      return {
        status: pass ? "pass" : "fail",
        detail: `${source} ${ageMin.toFixed(1)} min old, ${fileCount} markers (threshold ${threshold}min)`,
        metrics: {
          ageMin: Number(ageMin.toFixed(2)),
          maxMin: threshold,
          fileCount,
          source,
        },
      };
    },
  },
];
