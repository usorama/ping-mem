#!/usr/bin/env bun
/**
 * Direct ingestion using IngestionService
 * Runs on host (not in container) to access local filesystem
 *
 * Usage:
 *   bun run scripts/direct-ingest.ts [PROJECT_DIR]
 *
 * Example:
 *   bun run scripts/direct-ingest.ts /Users/umasankr/Projects/sn-assist
 */

import { IngestionService } from "../src/ingest/IngestionService.js";
import { createNeo4jClient } from "../src/graph/Neo4jClient.js";
import { QdrantClientWrapper } from "../src/search/QdrantClient.js";

// Get project directory from command-line argument
const projectDir = process.argv[2];

if (!projectDir) {
  console.error("Error: Project directory required");
  console.error("Usage: bun run scripts/direct-ingest.ts [PROJECT_DIR]");
  console.error("Example: bun run scripts/direct-ingest.ts /Users/umasankr/Projects/sn-assist");
  process.exit(1);
}

async function main() {
  console.log(`=== Direct Ingestion: ${projectDir} ===\n`);

  // Create Neo4j client
  const neo4jClient = createNeo4jClient({
    uri: "bolt://localhost:7687",
    username: "neo4j",
    password: "neo4j_password",
  });

  // Connect to Neo4j
  console.log("[0/4] Connecting to Neo4j...");
  await neo4jClient.connect();
  console.log("  Connected to Neo4j");

  // Create Qdrant client
  const qdrantClient = new QdrantClientWrapper({
    url: "http://localhost:6333",
    collectionName: "ping-mem-vectors",
    vectorDimensions: 768,
  });

  // Connect to Qdrant
  console.log("  Connecting to Qdrant...");
  await qdrantClient.connect();
  console.log("  Connected to Qdrant");

  // Create ingestion service
  const ingestionService = new IngestionService({
    neo4jClient,
    qdrantClient,
  });

  console.log("\n[1/4] Starting ingestion...");
  const result = await ingestionService.ingestProject({
    projectDir,
    forceReingest: false,
  });

  if (!result) {
    console.log("  No changes detected - project already up to date");
  } else {
    console.log("\n[2/4] Ingestion Result:");
    console.log(`  Project ID: ${result.projectId}`);
    console.log(`  Tree Hash: ${result.treeHash}`);
    console.log(`  Files Indexed: ${result.filesIndexed}`);
    console.log(`  Chunks Indexed: ${result.chunksIndexed}`);
    console.log(`  Commits Indexed: ${result.commitsIndexed}`);
    console.log(`  Had Changes: ${result.hadChanges}`);
    console.log(`  Ingested At: ${result.ingestedAt}`);

    // Verify with search
    console.log("\n[3/4] Verifying search...");
    const searchResults = await ingestionService.searchCode(
      "import",
      {
        projectId: result.projectId,
        limit: 5,
      }
    );

    console.log(`  Found ${searchResults.length} matches for "import":`);
    for (const r of searchResults.slice(0, 5)) {
      const lineInfo = r.lineStart ? `:${r.lineStart}` : "";
      console.log(`    - ${r.filePath}${lineInfo}`);
    }
  }

  console.log("\n[4/4] Cleanup...");

  // Cleanup
  await neo4jClient.disconnect();
  await qdrantClient.disconnect();

  console.log("\n=== Ingestion Complete ===");
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
