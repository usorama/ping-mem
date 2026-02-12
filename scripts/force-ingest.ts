/**
 * Force reingest a project into Neo4j + Qdrant.
 * Usage: NEO4J_URI=... QDRANT_URL=... bun run scripts/force-ingest.ts <projectDir>
 */
import { createRuntimeServices } from "../src/config/runtime.js";
import { IngestionService } from "../src/ingest/IngestionService.js";

const projectDir = process.argv[2] || "/Users/umasankr/Projects/ping-mem";

const services = await createRuntimeServices();
if (!services.neo4jClient || !services.qdrantClient) {
  console.error("ERROR: Neo4j and Qdrant are required. Set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, QDRANT_URL, QDRANT_COLLECTION_NAME");
  process.exit(1);
}

const ingestionService = new IngestionService({
  neo4jClient: services.neo4jClient,
  qdrantClient: services.qdrantClient,
});

console.log(`Force reingesting: ${projectDir}`);
const result = await ingestionService.ingestProject({
  projectDir,
  forceReingest: true,
});

if (result) {
  console.log("SUCCESS:", JSON.stringify({
    projectId: result.projectId,
    treeHash: result.treeHash.substring(0, 16) + "...",
    filesIndexed: result.filesIndexed,
    chunksIndexed: result.chunksIndexed,
    commitsIndexed: result.commitsIndexed,
  }, null, 2));
} else {
  console.log("No changes detected");
}

process.exit(0);
