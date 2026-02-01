import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "fs";
import * as path from "path";

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
    if (!checkBasicAuth(req, res)) {
      return true;
    }
    const html = renderAdminPage();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  if (pathName.startsWith("/api/admin")) {
    if (!checkBasicAuth(req, res)) {
      return true;
    }
    if (!requireApiKey(req, res, deps.apiKeyManager)) {
      return true;
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
    const resolvedProjectId = projectId ?? resolveProjectId(projectDir ?? "", deps.adminStore);
    if (!resolvedProjectId) {
      return respondJson(res, 404, { error: "Project not found" });
    }

    if (deps.ingestionService) {
      await deps.ingestionService.deleteProject(resolvedProjectId);
    }
    deps.diagnosticsStore.deleteProject(resolvedProjectId);

    if (projectDir) {
      deleteProjectManifest(projectDir);
      const sessionIds = deps.eventStore.findSessionIdsByProjectDir(projectDir);
      deps.eventStore.deleteSessions(sessionIds);
    }

    deps.adminStore.deleteProject(resolvedProjectId);

    return respondJson(res, 200, { data: { projectId: resolvedProjectId } });
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
      return respondJson(res, 500, {
        error: "LLMConfigError",
        message: error instanceof Error ? error.message : "Unable to save LLM config",
      });
    }
  }

  return respondJson(res, 404, { error: "Not found" });
}

export function checkBasicAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const adminUser = process.env[ADMIN_USER_ENV];
  const adminPass = process.env[ADMIN_PASS_ENV];
  if (!adminUser || !adminPass) {
    return true;
  }

  const header = req.headers["authorization"] ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.writeHead(401, { "WWW-Authenticate": "Basic" });
    res.end("Unauthorized");
    return false;
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  // Use timing-safe comparison to prevent timing attacks
  // See: https://owasp.org/www-community/attacks/Timing_analysis
  const userValid = timingSafeStringEqual(user ?? "", adminUser);
  const passValid = timingSafeStringEqual(pass ?? "", adminPass);

  if (!userValid || !passValid) {
    res.writeHead(401, { "WWW-Authenticate": "Basic" });
    res.end("Unauthorized");
    return false;
  }

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
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function resolveProjectId(projectDir: string, adminStore: AdminStore): string | null {
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
    const scan = scanner.scanProject(normalized);
    return scan.manifest.projectId;
  } catch {
    return null;
  }
}

function deleteProjectManifest(projectDir: string): void {
  const manifestPath = path.join(projectDir, ".ping-mem", "manifest.json");
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }
  const manifestDir = path.join(projectDir, ".ping-mem");
  if (fs.existsSync(manifestDir)) {
    const remaining = fs.readdirSync(manifestDir);
    if (remaining.length === 0) {
      fs.rmdirSync(manifestDir);
    }
  }
}

function renderAdminPage(): string {
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

  <script>
    const state = {
      apiKey: localStorage.getItem("pingMemApiKey") || "",
    };

    const apiKeyInput = document.getElementById("currentApiKey");
    const apiKeyStatus = document.getElementById("apiKeyStatus");
    const saveApiKey = document.getElementById("saveApiKey");
    apiKeyInput.value = state.apiKey;

    saveApiKey.addEventListener("click", () => {
      state.apiKey = apiKeyInput.value.trim();
      localStorage.setItem("pingMemApiKey", state.apiKey);
      apiKeyStatus.textContent = state.apiKey ? "Saved" : "Missing";
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

    async function refreshKeys() {
      const keys = await apiFetch("/api/admin/keys");
      const table = document.getElementById("keysTable");
      table.innerHTML = "";
      keys.forEach((key) => {
        const row = document.createElement("tr");
        const createdAt = new Date(key.createdAt).toLocaleString();
        const status = key.active ? "Active" : "Inactive";
        const action = key.active
          ? "<button data-id=\"" + key.id + "\" class=\"ghost\">Deactivate</button>"
          : "";
        row.innerHTML =
          "<td>" + key.id + "</td>" +
          "<td>" + key.last4 + "</td>" +
          "<td>" + createdAt + "</td>" +
          "<td>" + status + "</td>" +
          "<td>" + action + "</td>";
        table.appendChild(row);
      });

      table.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await apiFetch("/api/admin/keys/deactivate", {
            method: "POST",
            body: JSON.stringify({ id: btn.dataset.id }),
          });
          refreshKeys();
        });
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
      refreshKeys();
    }

    async function refreshProjects() {
      const projects = await apiFetch("/api/admin/projects");
      const table = document.getElementById("projectsTable");
      table.innerHTML = "";
      projects.forEach((project) => {
        const row = document.createElement("tr");
        const lastIngested = project.lastIngestedAt
          ? new Date(project.lastIngestedAt).toLocaleString()
          : "-";
        row.innerHTML =
          "<td>" + project.projectDir + "</td>" +
          "<td>" + project.projectId + "</td>" +
          "<td>" + lastIngested + "</td>" +
          "<td><button data-dir=\"" + project.projectDir + "\" class=\"secondary\">Delete</button></td>";
        table.appendChild(row);
      });

      table.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete all memory, graph, and diagnostics for this project?")) {
            return;
          }
          await apiFetch("/api/admin/projects", {
            method: "DELETE",
            body: JSON.stringify({ projectDir: btn.dataset.dir }),
          });
          refreshProjects();
        });
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

    document.getElementById("refreshKeys").addEventListener("click", refreshKeys);
    document.getElementById("rotateKey").addEventListener("click", rotateKey);
    document.getElementById("refreshProjects").addEventListener("click", refreshProjects);
    document.getElementById("saveLLMConfig").addEventListener("click", saveLLMConfig);

    if (state.apiKey) {
      refreshKeys().catch(console.error);
      refreshProjects().catch(console.error);
      loadLLMConfig().catch(console.error);
    }
  </script>
</body>
</html>`;
}
