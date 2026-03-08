#!/usr/bin/env bun
/**
 * Seed curated knowledge entries into ping-mem via the REST API.
 *
 * Idempotent: KnowledgeStore upserts by SHA-256(projectId + "::" + title),
 * so running this script multiple times is safe.
 *
 * Usage:
 *   bun run scripts/seed-knowledge.ts [--base-url http://localhost:3000]
 *
 * Requirements:
 *   - ping-mem REST server must be running at the target URL
 */

import { createLogger } from "../src/util/logger.js";

const log = createLogger("seed-knowledge");

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(argv: string[]): { baseUrl: string } {
  let baseUrl = "http://localhost:3000";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url" && i + 1 < argv.length) {
      baseUrl = argv[i + 1]!;
      i++;
    }
  }

  // Validate URL scheme to prevent SSRF
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      log.error(`Invalid URL scheme "${parsed.protocol}". Only http: and https: are allowed.`);
      process.exit(1);
    }
  } catch {
    log.error(`Invalid URL: "${baseUrl}"`);
    process.exit(1);
  }

  return { baseUrl };
}

const args = parseArgs(process.argv.slice(2));

// ============================================================================
// Knowledge Entry Type (matches POST /api/v1/knowledge/ingest body)
// ============================================================================

interface KnowledgeSeedEntry {
  projectId: string;
  title: string;
  solution: string;
  symptoms?: string;
  rootCause?: string;
  tags?: string[];
}

// ============================================================================
// Curated Knowledge Entries
// ============================================================================

const ENTRIES: KnowledgeSeedEntry[] = [
  {
    projectId: "ping-mem",
    title: "IngestionService not configured (503)",
    solution:
      "Restart ping-mem container or rebuild Docker image. Ensure Neo4j and Qdrant are running and healthy.",
    symptoms: "503 on /api/v1/codebase/* endpoints",
    rootCause:
      "IngestionService requires Neo4j and Qdrant connections at startup",
    tags: ["troubleshooting", "docker", "ingestion"],
  },
  {
    projectId: "ping-mem",
    title: "Empty codebase search results",
    solution:
      "Force re-ingest: bun run scripts/force-ingest.ts /path/to/project. Delete stale .ping-mem/manifest.json if needed.",
    symptoms: "Codebase search returns 0 results or empty content",
    rootCause: "Project not ingested or stale manifest blocking re-ingestion",
    tags: ["troubleshooting", "search", "ingestion"],
  },
  {
    projectId: "ping-mem",
    title: "MCP tools not appearing in IDE",
    solution:
      "Verify .cursor/mcp.json or ~/.claude/mcp.json path is correct. Rebuild: cd /path/to/ping-mem && bun run build. Restart IDE.",
    symptoms: "No ping-mem tools in Cursor/Claude Code",
    rootCause: "MCP config path incorrect or build artifacts missing",
    tags: ["troubleshooting", "mcp", "ide"],
  },
  {
    projectId: "ping-mem",
    title: "Neo4j connection failed",
    solution:
      "Check container: docker ps | grep neo4j. Verify bolt://localhost:7687. Check .env credentials.",
    symptoms: "ECONNREFUSED on Neo4j, ingestion fails",
    rootCause: "Neo4j container not running or credentials incorrect",
    tags: ["troubleshooting", "neo4j", "docker"],
  },
  {
    projectId: "ping-mem",
    title: "Docker deployment on OrbStack",
    solution:
      "Run ./scripts/setup.sh for infrastructure. Run ./scripts/install-client.sh for client tools. Run ./scripts/ingest-project.sh for each project.",
    symptoms: "Need to set up ping-mem locally",
    rootCause: "Initial deployment",
    tags: ["deployment", "docker", "orbstack"],
  },
  {
    projectId: "ping-mem",
    title: "Backup and restore procedure",
    solution:
      "Backup: ./scripts/backup.sh [dir]. Restore: ./scripts/restore.sh backup.tar.gz. Covers SQLite, Qdrant snapshots, Neo4j dump.",
    symptoms: "Need to backup or restore ping-mem data",
    rootCause: "Operational procedure",
    tags: ["operations", "backup", "restore"],
  },
  {
    projectId: "ping-mem",
    title: "Rate limiting returns 429",
    solution:
      "Wait for Retry-After header value. Default: 100 requests per 60 seconds per IP.",
    symptoms: "429 Too Many Requests on API calls",
    rootCause: "Per-IP rate limiting enforced on all endpoints",
    tags: ["api", "rate-limiting", "troubleshooting"],
  },
  {
    projectId: "ping-mem",
    title: "Multi-agent quota exhausted",
    solution:
      "Check quota: GET /api/v1/agents/quotas?agentId=<id>. Increase quota via agent_register with higher quotaBytes/quotaCount.",
    symptoms: "QuotaExhaustedError on memory save",
    rootCause: "Agent exceeded allocated memory quota",
    tags: ["agents", "quota", "troubleshooting"],
  },
  {
    projectId: "ping-mem",
    title: "ProjectId mismatch between Docker and local",
    solution:
      "ProjectId is SHA-256(remoteUrl + :: + relativeToGitRoot). Ensure git remote URL is consistent. Docker mounts /Users/.../Projects to /projects.",
    symptoms: "Different projectIds for same project, duplicate data",
    rootCause:
      "Path-based projectId computation instead of git-identity based",
    tags: ["ingestion", "docker", "projectid"],
  },
  {
    projectId: "ping-mem",
    title: "Web UI architecture",
    solution:
      "HTMX server-rendered at /ui with 9 views. Layout in src/http/ui/layout.ts. Pages in src/http/ui/*.ts. Partials in src/http/ui/partials/*.ts.",
    symptoms: "Need to understand or modify web UI",
    rootCause: "Architecture reference",
    tags: ["architecture", "ui", "htmx"],
  },
];

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { baseUrl } = args;
  log.info(`Seeding ${ENTRIES.length} knowledge entries into ${baseUrl}`);

  // 1. Health check
  log.info("Running health check...");
  try {
    const healthResp = await fetch(`${baseUrl}/health`);
    if (!healthResp.ok) {
      log.error(`Health check failed: ${healthResp.status} ${healthResp.statusText}`);
      process.exit(1);
    }
    log.info("Health check passed");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      log.error(`Cannot connect to server at ${baseUrl}. Is it running?`);
      process.exit(1);
    }
    log.error(`Health check failed: ${message}`);
    process.exit(1);
  }

  // 2. Ingest each entry
  let succeeded = 0;
  let failed = 0;

  for (const entry of ENTRIES) {
    try {
      const resp = await fetch(`${baseUrl}/api/v1/knowledge/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });

      if (!resp.ok) {
        const body = await resp.text();
        log.error(`Failed to ingest "${entry.title}": ${resp.status} ${body}`);
        failed++;
        continue;
      }

      const json = (await resp.json()) as Record<string, unknown>;
      const entryData = (json?.data as Record<string, unknown>)?.entry as Record<string, unknown> | undefined;
      const id = typeof entryData?.id === "string" ? entryData.id.substring(0, 12) : "unknown";
      log.info(`Ingested: "${entry.title}" (id: ${id}...)`);
      succeeded++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to ingest "${entry.title}": ${message}`);
      failed++;
    }
  }

  // 3. Summary
  log.info(`Done: ${succeeded} succeeded, ${failed} failed out of ${ENTRIES.length} entries`);

  if (failed > 0) {
    process.exit(1);
  }
}

await main();
