#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ISSUE_DIR = path.join(ROOT, "docs/issues/2026-04-29-ground-up-local-trust-rebuild");
const EVIDENCE_DIR = path.join(ROOT, "docs/evidence/ground-up-local-trust");
const DEFAULT_OUT_DIR = path.join(EVIDENCE_DIR, "capability-scorecard");

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const outDirArg = process.argv.find((arg) => arg.startsWith("--out-dir="));
const outDir = outDirArg ? path.resolve(ROOT, outDirArg.split("=").slice(1).join("=")) : DEFAULT_OUT_DIR;

const now = new Date().toISOString();

const capabilities = [
  {
    id: "CAP-1",
    name: "Runtime Ground Truth",
    outcome: "OUT-4",
    objective: "OBJ-4",
    goal: "One local REST runtime owns writes, sessions, indexes, and project registry truth.",
    metrics: [
      metric("S002 REST owner issue done", issueDone("S002")),
      metric("S010 runtime registry issue done", issueDone("S010")),
      metric("Direct-mode quarantine evidence exists", fileExists("S002-direct-mode-quarantine.md")),
      metric("Runtime registry alignment evidence exists", fileExists("S010-registry-alignment.md")),
    ],
  },
  {
    id: "CAP-2",
    name: "Agent Reachability",
    outcome: "OUT-1",
    objective: "OBJ-1",
    goal: "Codex and Claude Code can reach the intended local runtime through approved entrypoints.",
    metrics: [
      metric("S003 unified CLI issue done", issueDone("S003")),
      metric("S005 Codex memory proof issue done", issueDone("S005")),
      metric("S006 Claude memory proof issue done", issueDone("S006")),
      metric("S007 Codex codebase proof issue done", issueDone("S007")),
      metric("S008 Claude codebase proof issue done", issueDone("S008")),
      liveCommandMetric("Approved ping-mem wrapper projects", ["/Users/umasankr/.codex/bin/ping-mem-codex", "codebase", "projects", "--scope", "registered", "--json"]),
    ],
  },
  {
    id: "CAP-3",
    name: "Explicit Identity",
    outcome: "OUT-5",
    objective: "OBJ-5",
    goal: "Every approved path carries project, agent, and session identity or fails loudly.",
    metrics: [
      metric("S004 identity issue done", issueDone("S004")),
      metric("Identity/path safety evidence exists", fileExists("S004-identity-path-safety.md")),
      metric("Agent REST tests include graph identity gate", fileContains("src/http/__tests__/agent-rest.test.ts", "approved graph answer")),
      metric("Agent trust tests include graph answer identity", fileContains("src/cli/__tests__/agent-trust.test.ts", "buildAgentGraphAnswer")),
    ],
  },
  {
    id: "CAP-4",
    name: "Memory Lifecycle Correctness",
    outcome: "OUT-2",
    objective: "OBJ-2",
    goal: "Save, search, retrieve, update/supersede, recall, delete, and confirm absent work end to end.",
    metrics: [
      metric("S005 Codex memory issue done", issueDone("S005")),
      metric("S006 Claude memory issue done", issueDone("S006")),
      metric("Codex proof JSON exists", fileExists("S005-codex-memory/proof.json")),
      metric("Claude proof JSON exists", fileExists("S006-claude-memory/proof.json")),
      jsonFieldMetric("Codex memory proof ok", "S005-codex-memory/proof.json", ["ok"], true),
      jsonFieldMetric("Claude memory proof ok", "S006-claude-memory/proof.json", ["ok"], true),
    ],
  },
  {
    id: "CAP-5",
    name: "Codebase Grounding Correctness",
    outcome: "OUT-3",
    objective: "OBJ-3",
    goal: "Verify, ingest, search, timeline, registered inventory, and file/line anchors work on real repos.",
    metrics: [
      metric("S007 Codex codebase issue done", issueDone("S007")),
      metric("S008 Claude codebase issue done", issueDone("S008")),
      metric("Codex codebase proof JSON exists", fileExists("S007-codex-codebase/proof.json")),
      metric("Claude codebase proof JSON exists", fileExists("S008-claude-codebase/proof.json")),
      jsonFieldMetric("Codex codebase proof ok", "S007-codex-codebase/proof.json", ["ok"], true),
      jsonFieldMetric("Claude codebase proof ok", "S008-claude-codebase/proof.json", ["ok"], true),
    ],
  },
  {
    id: "CAP-6",
    name: "Recovery And Readiness",
    outcome: "OUT-6",
    objective: "OBJ-6",
    goal: "Sleep, reboot, runtime restart, Neo4j restart, Qdrant restart, auth drift, and stale launchd states are known events.",
    metrics: [
      metric("S012 LaunchAgent hygiene issue done", issueDone("S012")),
      metric("S013 recovery scenarios issue done", issueDone("S013")),
      metric("Recovery scenario report exists", fileExists("S013-recovery-scenarios.md")),
      metric("LaunchAgent reconciliation evidence exists", fileExists("S012-launchagent-hygiene.md")),
      metric("Sleep/wake HITL blocker remains explicit", fileContains("docs/evidence/ground-up-local-trust/S013-recovery-scenarios.md", "Mac sleep/wake")),
    ],
  },
  {
    id: "CAP-7",
    name: "Truthful Observability",
    outcome: "OUT-7",
    objective: "OBJ-7",
    goal: "Health, doctor, UI, logs, alerts, and graph answers distinguish healthy, stale, partial, blocked, and error states.",
    metrics: [
      metric("S009 failure-state honesty issue done", issueDone("S009")),
      metric("S014 observability issue done", issueDone("S014")),
      metric("S017 structured graph issue done", issueDone("S017")),
      metric("Failure-state matrix exists", fileExists("S009-failure-state-matrix.md")),
      metric("Observability alignment evidence exists", fileExists("S014-observability-alignment.md")),
      metric("Structured graph evidence exists", fileExists("S017-structured-knowledge-graph.md")),
      liveHealthMetric("Live health agrees codebase dependencies are ready"),
    ],
  },
  {
    id: "CAP-8",
    name: "Controlled Re-Adoption",
    outcome: "OUT-8",
    objective: "OBJ-8",
    goal: "Agent integrations are restored only after proof passes and final claims stay inside evidence.",
    metrics: [
      metric("S015 CLI-first re-adoption issue done", issueDone("S015")),
      metric("S016 optional MCP proxy remains blocked/deferred", issueStatus("S016") === "blocked"),
      metric("S015 readoption report exists", fileExists("S015-readoption-report.md")),
      metric("S016 quarantine report exists", fileExists("S016-mcp-proxy-readoption.md")),
    ],
  },
];

const featureMetrics = [
  graphLiftFeature(),
  rgBaselineFeature(),
  livePingMemFeature(),
  optionalMcpFeature(),
];
const capabilityInventory = readCapabilityInventory();

const capabilityRows = capabilities.map((capability) => {
  const scored = scoreMetrics(capability.metrics);
  return {
    ...capability,
    score: scored.score,
    passed: scored.passed,
    total: scored.total,
    status: statusFor(scored.score),
  };
});

const featureRows = featureMetrics.map((feature) => {
  const scored = scoreMetrics(feature.metrics);
  return {
    ...feature,
    score: scored.score,
    passed: scored.passed,
    total: scored.total,
    status: statusFor(scored.score),
  };
});

const overall = scoreMetrics([...capabilityRows.flatMap((row) => row.metrics), ...featureRows.flatMap((row) => row.metrics)]);
const objectives = rollupBy(capabilityRows, "objective");
const outcomes = rollupBy(capabilityRows, "outcome");
const scorecard = {
  generatedAt: now,
  liveChecksEnabled: live,
  overall: {
    score: overall.score,
    passed: overall.passed,
    total: overall.total,
    status: statusFor(overall.score),
  },
  objectives,
  outcomes,
  capabilities: capabilityRows,
  features: featureRows,
  originalCapabilityInventory: capabilityInventory,
  claimBoundary: [
    "Scorecard metrics are proof-routing signals, not a replacement for direct evidence.",
    "ping-mem results are treated as discovery leads unless backed by evidence files, tests, or live runtime output.",
    "S016 optional MCP proxy remains blocked/deferred and must not expand the current completion claim.",
  ],
};

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
writeFileSync(path.join(outDir, "scorecard.md"), renderMarkdown(scorecard));
writeFileSync(path.join(outDir, "scorecard.html"), renderHtml(scorecard));

console.log(JSON.stringify({
  ok: true,
  generatedAt: now,
  output: {
    json: path.relative(ROOT, path.join(outDir, "scorecard.json")),
    markdown: path.relative(ROOT, path.join(outDir, "scorecard.md")),
    html: path.relative(ROOT, path.join(outDir, "scorecard.html")),
  },
  overall: scorecard.overall,
}, null, 2));

function metric(name, passed, detail = undefined) {
  return {
    name,
    passed: Boolean(passed),
    weight: 1,
    detail: detail ?? (passed ? "passed" : "missing or not proven"),
  };
}

function scoreMetrics(metrics) {
  const total = metrics.reduce((sum, item) => sum + item.weight, 0);
  const passed = metrics.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0);
  return {
    passed,
    total,
    score: total === 0 ? 0 : Math.round((passed / total) * 100),
  };
}

function statusFor(score) {
  if (score >= 100) return "green";
  if (score >= 70) return "yellow";
  return "red";
}

function rollupBy(rows, field) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row[field] ?? "unknown";
    const metrics = grouped.get(key) ?? [];
    metrics.push(...row.metrics);
    grouped.set(key, metrics);
  }
  return [...grouped.entries()].map(([id, metrics]) => {
    const scored = scoreMetrics(metrics);
    return {
      id,
      score: scored.score,
      passed: scored.passed,
      total: scored.total,
      status: statusFor(scored.score),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function issueStatus(id) {
  const file = findIssueFile(id);
  if (!file) return "missing";
  const match = readFileSync(file, "utf8").match(/^status:\s*(\S+)/m);
  return match?.[1] ?? "unknown";
}

function issueDone(id) {
  return issueStatus(id) === "done";
}

function findIssueFile(id) {
  const prefix = `${id}-`;
  try {
    const entries = execFileSync("bash", ["-lc", `ls ${shellQuote(ISSUE_DIR)}/${prefix}*.md 2>/dev/null | head -1`], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    return entries || null;
  } catch {
    return null;
  }
}

function fileExists(relativePath) {
  return existsSync(path.join(EVIDENCE_DIR, relativePath)) || existsSync(path.join(ROOT, relativePath));
}

function fileContains(relativePath, text) {
  const file = path.join(ROOT, relativePath);
  return existsSync(file) && readFileSync(file, "utf8").includes(text);
}

function jsonFieldMetric(name, relativePath, fieldPath, expected) {
  const file = path.join(EVIDENCE_DIR, relativePath);
  if (!existsSync(file)) return metric(name, false, `${relativePath} missing`);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const value = fieldPath.reduce((current, field) => current?.[field], parsed);
    return metric(name, value === expected, `${fieldPath.join(".")}=${JSON.stringify(value)}`);
  } catch (error) {
    return metric(name, false, `invalid JSON: ${error.message}`);
  }
}

function graphLiftFeature() {
  const complete = readJson(path.join(EVIDENCE_DIR, "S017-structured-knowledge-graph/complete_graph-answer.json"));
  const semantic = readJson(path.join(EVIDENCE_DIR, "S017-structured-knowledge-graph/semantic_neighborhood-answer.json"));
  const completeAnswer = complete?.answer ?? complete?.data?.answer ?? complete;
  const semanticAnswer = semantic?.answer ?? semantic?.data?.answer ?? semantic;
  const edgeCount = completeAnswer?.denominator?.edgeCount ?? completeAnswer?.edges?.length ?? 0;
  const nodeCount = completeAnswer?.denominator?.nodeCount ?? completeAnswer?.nodes?.length ?? 0;
  const anchorCount = completeAnswer?.sourceAnchors?.length ?? 0;
  const semanticIncomplete = Array.isArray(semanticAnswer?.blockedClaims)
    && semanticAnswer.blockedClaims.some((claim) => String(claim).includes("incomplete"));

  return {
    id: "FEATURE-graph-relationship-lift",
    name: "ping-mem relationship lift over rg",
    goal: "Return the files rg can reveal plus relationship edges, paths, provenance, and denominator evidence the user did not explicitly ask for.",
    metrics: [
      metric("Complete graph evidence file exists", Boolean(completeAnswer?.answerKind), "complete_graph-answer.json"),
      metric("Complete answer has denominator", Boolean(completeAnswer?.denominator), `nodeCount=${nodeCount}, edgeCount=${edgeCount}`),
      metric("Complete answer has unasked relationship edges", edgeCount > 0, `edgeCount=${edgeCount}`),
      metric("Complete answer has source anchors", anchorCount > 0, `sourceAnchorCount=${anchorCount}`),
      metric("Semantic answer blocks completeness language", semanticIncomplete, "semantic blockedClaims mention incomplete"),
    ],
    extra: { nodeCount, edgeCount, anchorCount },
  };
}

function rgBaselineFeature() {
  const query = "Structured Knowledge Graph";
  const result = runOptional("rg", ["-n", query, "CONTEXT.md", "docs/architecture", "docs/issues", "src/graph"], false);
  const hits = result.ok ? result.stdout.trim().split(/\r?\n/).filter(Boolean).length : 0;
  return {
    id: "FEATURE-rg-baseline",
    name: "rg baseline remains available",
    goal: "rg stays the fast exact-match baseline; ping-mem must add relationship and provenance lift, not replace exact search.",
    metrics: [
      metric("rg exact search runs", result.ok, result.ok ? `${hits} hit(s)` : result.error),
      metric("rg finds direct text hits", hits > 0, `${hits} hit(s) for ${query}`),
    ],
    extra: { query, hits },
  };
}

function livePingMemFeature() {
  const health = liveHealthMetric("REST health exposes ready codebase dependencies");
  const projects = liveCommandMetric(
    "ping-mem registered project inventory live check",
    ["/Users/umasankr/.codex/bin/ping-mem-codex", "codebase", "projects", "--scope", "registered", "--json"],
  );
  const search = liveCommandMetric(
    "ping-mem indexed discovery live check",
    ["/Users/umasankr/.codex/bin/ping-mem-codex", "codebase", "search", "capability scorecard relationship graph", "--json"],
  );
  return {
    id: "FEATURE-live-ping-mem-discovery",
    name: "Live ping-mem discovery path",
    goal: "The approved ping-mem wrapper should discover indexed context when the runtime has ingestion configured.",
    metrics: [health, projects, search],
  };
}

function optionalMcpFeature() {
  return {
    id: "FEATURE-optional-mcp-proxy",
    name: "Optional MCP proxy remains outside current claim",
    goal: "MCP can become a convenience adapter later, but it must not inflate the current proven capability score.",
    metrics: [
      metric("S016 is blocked/deferred", issueStatus("S016") === "blocked", `status=${issueStatus("S016")}`),
      metric("S016 quarantine evidence exists", fileExists("S016-mcp-proxy-readoption.md")),
    ],
  };
}

function liveCommandMetric(name, command) {
  if (!live) return metric(name, false, "not run; use --live to execute");
  const [cmd, ...args] = command;
  const result = runOptional(cmd, args, false);
  return metric(name, result.ok, result.ok ? "command exited 0" : result.error);
}

function liveHealthMetric(name) {
  if (!live) return metric(name, false, "not run; use --live to execute");
  const result = runOptional("curl", ["-sS", "http://localhost:3003/health"], false);
  if (!result.ok) return metric(name, false, result.error);
  try {
    const health = JSON.parse(result.stdout);
    const components = health.components ?? {};
    const ok = health.status === "ok" && components.neo4j === "healthy" && components.qdrant === "healthy";
    return metric(
      name,
      ok,
      `status=${health.status ?? "missing"}, neo4j=${components.neo4j ?? "missing"}, qdrant=${components.qdrant ?? "missing"}`,
    );
  } catch (error) {
    return metric(name, false, `invalid health JSON: ${summarizeError(error.message)}`);
  }
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readCapabilityInventory() {
  const inventory = readJson(path.join(EVIDENCE_DIR, "capability-inventory.json"));
  const capabilities = Array.isArray(inventory?.capabilities) ? inventory.capabilities : [];
  const statusCounts = {};
  for (const capability of capabilities) {
    const status = String(capability.status ?? "unknown");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return {
    source: "docs/evidence/ground-up-local-trust/capability-inventory.json",
    total: capabilities.length,
    statusCounts,
    capabilities,
  };
}

function runOptional(command, args, throwOnError = false) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    if (throwOnError) throw error;
    return {
      ok: false,
      stdout: error.stdout?.toString?.() ?? "",
      error: summarizeError(error.stderr?.toString?.().trim() || error.message),
    };
  }
}

function summarizeError(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  const httpMatch = text.match(/HTTP\s+\d+:\s*.*?(?=\s+at\s+|$)/i);
  if (httpMatch) return httpMatch[0].trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function renderMarkdown(card) {
  const lines = [];
  lines.push("# ping-mem Capability Scorecard");
  lines.push("");
  lines.push(`Generated: ${card.generatedAt}`);
  lines.push(`Live checks: ${card.liveChecksEnabled ? "enabled" : "disabled"}`);
  lines.push("");
  lines.push(`Overall: **${card.overall.score}% ${card.overall.status}** (${card.overall.passed}/${card.overall.total} weighted metrics)`);
  lines.push("");
  lines.push("## Objective Rollup");
  lines.push("");
  lines.push("| Objective | Score | Status |");
  lines.push("|---|---:|---|");
  for (const row of card.objectives) {
    lines.push(`| ${row.id} | ${row.score}% (${row.passed}/${row.total}) | ${row.status} |`);
  }
  lines.push("");
  lines.push("## Outcome Rollup");
  lines.push("");
  lines.push("| Outcome | Score | Status |");
  lines.push("|---|---:|---|");
  for (const row of card.outcomes) {
    lines.push(`| ${row.id} | ${row.score}% (${row.passed}/${row.total}) | ${row.status} |`);
  }
  lines.push("");
  lines.push("## Capability Metrics");
  lines.push("");
  lines.push("| Capability | Objective | Outcome | Score | Status | Goal |");
  lines.push("|---|---|---|---:|---|---|");
  for (const row of card.capabilities) {
    lines.push(`| ${row.id} ${row.name} | ${row.objective} | ${row.outcome} | ${row.score}% | ${row.status} | ${row.goal} |`);
  }
  lines.push("");
  for (const row of card.capabilities) {
    lines.push(`### ${row.id} ${row.name}`);
    lines.push("");
    for (const item of row.metrics) {
      lines.push(`- ${item.passed ? "[x]" : "[ ]"} ${item.name}: ${item.detail}`);
    }
    lines.push("");
  }
  lines.push("## Feature Metrics");
  lines.push("");
  lines.push("| Feature | Score | Status | Goal |");
  lines.push("|---|---:|---|---|");
  for (const row of card.features) {
    lines.push(`| ${row.name} | ${row.score}% | ${row.status} | ${row.goal} |`);
  }
  lines.push("");
  for (const row of card.features) {
    lines.push(`### ${row.name}`);
    lines.push("");
    for (const item of row.metrics) {
      lines.push(`- ${item.passed ? "[x]" : "[ ]"} ${item.name}: ${item.detail}`);
    }
    if (row.extra) {
      lines.push(`- metric data: \`${JSON.stringify(row.extra)}\``);
    }
    lines.push("");
  }
  lines.push("## Original Capability Inventory");
  lines.push("");
  lines.push(`Source: \`${card.originalCapabilityInventory.source}\``);
  lines.push("");
  lines.push(`Total original capabilities: **${card.originalCapabilityInventory.total}**`);
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("|---|---:|");
  for (const [status, count] of Object.entries(card.originalCapabilityInventory.statusCounts)) {
    lines.push(`| ${status} | ${count} |`);
  }
  lines.push("");
  lines.push("| ID | Capability | Status | Claim Boundary |");
  lines.push("|---|---|---|---|");
  for (const item of card.originalCapabilityInventory.capabilities) {
    lines.push(`| ${item.id} | ${item.name} | ${item.status} | ${item.claimBoundary} |`);
  }
  lines.push("");
  lines.push("## Claim Boundary");
  lines.push("");
  for (const claim of card.claimBoundary) {
    lines.push(`- ${claim}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderHtml(card) {
  const data = JSON.stringify(card).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ping-mem Capability Scorecard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-2: #eef2f6;
      --text: #151922;
      --muted: #5f6877;
      --line: #d9dee7;
      --green: #177245;
      --green-bg: #e8f6ef;
      --yellow: #8a5a00;
      --yellow-bg: #fff3cf;
      --red: #b42318;
      --red-bg: #fde7e4;
      --blue: #155eef;
      --blue-bg: #e8f0ff;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main {
      max-width: 1240px;
      margin: 0 auto;
      padding: 28px 20px 48px;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: end;
      margin-bottom: 18px;
    }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 30px; line-height: 1.1; }
    h2 { font-size: 18px; margin: 28px 0 10px; }
    h3 { font-size: 15px; }
    p { margin: 6px 0 0; color: var(--muted); }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 18px 0;
    }
    .tile, .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .tile { padding: 14px; min-height: 96px; }
    .label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .value { display: block; margin-top: 8px; font-size: 28px; font-weight: 800; }
    .small { font-size: 13px; color: var(--muted); }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin: 18px 0;
    }
    input[type="search"] {
      min-width: 260px;
      flex: 1 1 280px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 12px;
      font: inherit;
      background: var(--surface);
      color: var(--text);
    }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 11px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button[aria-pressed="true"] {
      border-color: var(--blue);
      background: var(--blue-bg);
      color: var(--blue);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    th, td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    th {
      background: var(--surface-2);
      color: #344054;
      font-size: 12px;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    .score { font-weight: 800; white-space: nowrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-width: 68px;
      justify-content: center;
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .green { color: var(--green); background: var(--green-bg); }
    .yellow { color: var(--yellow); background: var(--yellow-bg); }
    .red { color: var(--red); background: var(--red-bg); }
    .blocked { color: #344054; background: var(--surface-2); }
    .panel { padding: 14px; margin-top: 12px; }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
      margin-bottom: 8px;
    }
    .metric-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px;
      background: #fbfcfe;
      min-height: 70px;
    }
    .metric strong {
      display: block;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .decision {
      border-left: 4px solid var(--red);
      padding: 10px 12px;
      background: var(--surface);
      border-radius: 6px;
      margin-top: 8px;
      box-shadow: var(--shadow);
    }
    .decision.yellow { border-left-color: #d89d00; }
    .claim {
      margin: 6px 0;
      padding: 9px 10px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    @media (max-width: 840px) {
      header { grid-template-columns: 1fr; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric-list { grid-template-columns: 1fr; }
      th:nth-child(3), td:nth-child(3) { display: none; }
    }
    @media (max-width: 560px) {
      main { padding: 20px 12px 36px; }
      h1 { font-size: 24px; }
      .summary { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>ping-mem Capability Scorecard</h1>
        <p>Visible proof map for objectives, outcomes, capabilities, and the rg versus ping-mem relationship-lift claim.</p>
      </div>
      <div class="small" id="generated"></div>
    </header>

    <section class="summary" id="summary"></section>

    <section class="toolbar" aria-label="Scorecard filters">
      <input id="search" type="search" placeholder="Search capability, feature, metric, or evidence">
      <button type="button" data-filter="all" aria-pressed="true">All</button>
      <button type="button" data-filter="green">Green</button>
      <button type="button" data-filter="yellow">Yellow</button>
      <button type="button" data-filter="red">Red</button>
      <button type="button" data-filter="failed">Failed Metrics</button>
    </section>

    <section>
      <h2>Decision Queue</h2>
      <div id="decisions"></div>
    </section>

    <section>
      <h2>Capability Metrics</h2>
      <div id="capability-table"></div>
      <div id="capability-details"></div>
    </section>

    <section>
      <h2>Feature Metrics</h2>
      <div id="feature-table"></div>
      <div id="feature-details"></div>
    </section>

    <section>
      <h2>Objective And Outcome Rollup</h2>
      <div id="rollups"></div>
    </section>

    <section>
      <h2>Original Capability Inventory</h2>
      <div id="inventory"></div>
    </section>

    <section>
      <h2>Claim Boundary</h2>
      <div id="claims"></div>
    </section>
  </main>

  <script>
    window.SCORECARD = ${data};
    const state = { filter: "all", search: "" };
    const card = window.SCORECARD;

    function badge(status) {
      return '<span class="badge ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
    }

    function rowMatches(row) {
      const haystack = JSON.stringify(row).toLowerCase();
      const searchOk = !state.search || haystack.includes(state.search);
      if (!searchOk) return false;
      if (state.filter === "all") return true;
      if (state.filter === "failed") return row.metrics.some(function(metric) { return !metric.passed; });
      return row.status === state.filter;
    }

    function renderSummary() {
      const graph = card.features.find(function(item) { return item.id === "FEATURE-graph-relationship-lift"; }) || {};
      const rg = card.features.find(function(item) { return item.id === "FEATURE-rg-baseline"; }) || {};
      const live = card.features.find(function(item) { return item.id === "FEATURE-live-ping-mem-discovery"; }) || {};
      const tiles = [
        ["Overall", card.overall.score + "%", card.overall.passed + "/" + card.overall.total + " metrics passed", card.overall.status],
        ["Graph Lift", (graph.extra && graph.extra.edgeCount || 0) + " edges", "Structured answer adds unasked relationships", graph.status || "red"],
        ["rg Baseline", (rg.extra && rg.extra.hits || 0) + " hits", "Exact search stays available", rg.status || "red"],
        ["Live Discovery", live.status || "red", card.liveChecksEnabled ? "Approved wrapper was executed" : "Run with --live for runtime proof", live.status || "red"],
      ];
      document.getElementById("summary").innerHTML = tiles.map(function(tile) {
        return '<article class="tile"><span class="label">' + escapeHtml(tile[0]) + '</span><span class="value">' + escapeHtml(tile[1]) + '</span><p>' + escapeHtml(tile[2]) + '</p><div style="margin-top:10px">' + badge(tile[3]) + '</div></article>';
      }).join("");
    }

    function renderTable(target, rows, columns) {
      const filtered = rows.filter(rowMatches);
      const body = filtered.map(function(row) {
        return '<tr><td><strong>' + escapeHtml(row.id || row.name) + '</strong><br><span class="small">' + escapeHtml(row.name || "") + '</span></td><td class="score">' + row.score + '%<br><span class="small">' + row.passed + '/' + row.total + '</span></td><td>' + badge(row.status) + '</td><td>' + escapeHtml(row.goal || "") + '</td></tr>';
      }).join("");
      document.getElementById(target).innerHTML = '<table><thead><tr>' + columns.map(function(col) { return '<th>' + escapeHtml(col) + '</th>'; }).join("") + '</tr></thead><tbody>' + (body || '<tr><td colspan="4">No rows match the current filter.</td></tr>') + '</tbody></table>';
    }

    function renderDetails(target, rows) {
      const filtered = rows.filter(rowMatches);
      document.getElementById(target).innerHTML = filtered.map(function(row) {
        const metrics = row.metrics.map(function(metric) {
          const status = metric.passed ? "green" : "red";
          return '<div class="metric"><strong>' + escapeHtml(metric.name) + '</strong>' + badge(status) + '<p>' + escapeHtml(metric.detail || "") + '</p></div>';
        }).join("");
        const extra = row.extra ? '<p class="small">Metric data: ' + escapeHtml(JSON.stringify(row.extra)) + '</p>' : "";
        return '<article class="panel"><div class="panel-head"><div><h3>' + escapeHtml((row.id ? row.id + " " : "") + row.name) + '</h3><p>' + escapeHtml(row.goal || "") + '</p></div>' + badge(row.status) + '</div>' + extra + '<div class="metric-list">' + metrics + '</div></article>';
      }).join("");
    }

    function renderDecisions() {
      const rows = card.features.concat(card.capabilities).filter(function(row) { return row.status !== "green"; });
      const decisions = rows.map(function(row) {
        const failed = row.metrics.filter(function(metric) { return !metric.passed; }).map(function(metric) { return metric.name + ": " + metric.detail; }).join("; ");
        const action = row.id === "FEATURE-live-ping-mem-discovery"
          ? "Fix the approved ping-mem runtime ingestion path before claiming live discovery is better than rg."
          : "Refine this capability until every metric has evidence or explicitly narrow the claim.";
        return '<div class="decision ' + escapeHtml(row.status) + '"><strong>' + escapeHtml(row.name) + '</strong><p>' + escapeHtml(action) + '</p><p class="small">' + escapeHtml(failed || "No failed metric detail available.") + '</p></div>';
      }).join("");
      document.getElementById("decisions").innerHTML = decisions || '<div class="decision yellow"><strong>No open scorecard actions</strong><p>All tracked metrics are green. Continue with broader acceptance testing before expanding the claim.</p></div>';
    }

    function renderRollups() {
      function miniTable(title, rows) {
        const body = rows.map(function(row) {
          return '<tr><td>' + escapeHtml(row.id) + '</td><td class="score">' + row.score + '%</td><td>' + badge(row.status) + '</td><td>' + row.passed + '/' + row.total + '</td></tr>';
        }).join("");
        return '<div class="panel"><h3>' + escapeHtml(title) + '</h3><table><thead><tr><th>ID</th><th>Score</th><th>Status</th><th>Metrics</th></tr></thead><tbody>' + body + '</tbody></table></div>';
      }
      document.getElementById("rollups").innerHTML = miniTable("Objectives", card.objectives) + miniTable("Outcomes", card.outcomes);
    }

    function renderInventory() {
      const inventory = card.originalCapabilityInventory || { capabilities: [], statusCounts: {}, total: 0 };
      const counts = Object.entries(inventory.statusCounts || {}).map(function(entry) {
        return '<div class="claim"><strong>' + escapeHtml(entry[0]) + '</strong>: ' + escapeHtml(entry[1]) + '</div>';
      }).join("");
      const rows = (inventory.capabilities || []).map(function(item) {
        return '<tr><td><strong>' + escapeHtml(item.id) + '</strong><br><span class="small">' + escapeHtml(item.name) + '</span></td><td>' + escapeHtml(item.status) + '</td><td>' + escapeHtml(item.feature) + '</td><td>' + escapeHtml(item.claimBoundary) + '</td></tr>';
      }).join("");
      document.getElementById("inventory").innerHTML =
        '<p class="small">Source: ' + escapeHtml(inventory.source || "") + ' | Total: ' + escapeHtml(inventory.total) + '</p>' +
        '<div class="metric-list">' + counts + '</div>' +
        '<table><thead><tr><th>ID</th><th>Status</th><th>Feature</th><th>Claim Boundary</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderClaims() {
      document.getElementById("claims").innerHTML = card.claimBoundary.map(function(claim) {
        return '<div class="claim">' + escapeHtml(claim) + '</div>';
      }).join("");
    }

    function render() {
      document.getElementById("generated").textContent = "Generated " + card.generatedAt + " | Live checks " + (card.liveChecksEnabled ? "enabled" : "disabled");
      renderSummary();
      renderDecisions();
      renderTable("capability-table", card.capabilities, ["Capability", "Score", "Status", "Goal"]);
      renderTable("feature-table", card.features, ["Feature", "Score", "Status", "Goal"]);
      renderDetails("capability-details", card.capabilities);
      renderDetails("feature-details", card.features);
      renderRollups();
      renderInventory();
      renderClaims();
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(char) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
      });
    }

    document.getElementById("search").addEventListener("input", function(event) {
      state.search = event.target.value.trim().toLowerCase();
      render();
    });
    document.querySelectorAll("[data-filter]").forEach(function(button) {
      button.addEventListener("click", function() {
        state.filter = button.dataset.filter;
        document.querySelectorAll("[data-filter]").forEach(function(item) {
          item.setAttribute("aria-pressed", String(item === button));
        });
        render();
      });
    });
    render();
  </script>
</body>
</html>
`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
