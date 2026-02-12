/**
 * Re-index a project's code chunks into Qdrant.
 * Use when Neo4j data is complete but Qdrant indexing failed.
 * Usage: NEO4J_URI=... QDRANT_URL=... bun run scripts/reindex-qdrant.ts <projectDir>
 */
import { createRuntimeServices } from "../src/config/runtime.js";
import { IngestionOrchestrator } from "../src/ingest/IngestionOrchestrator.js";
import { CodeIndexer } from "../src/search/CodeIndexer.js";

const projectDir = process.argv[2] || "/Users/umasankr/Projects/ping-mem";

const services = await createRuntimeServices();
if (!services.qdrantClient) {
  console.error("ERROR: Qdrant required. Set QDRANT_URL, QDRANT_COLLECTION_NAME");
  process.exit(1);
}

const orchestrator = new IngestionOrchestrator();
const codeIndexer = new CodeIndexer({ qdrantClient: services.qdrantClient });

console.log(`Re-scanning ${projectDir} for Qdrant re-index...`);
const result = await orchestrator.ingest(projectDir, { forceReingest: true });

if (!result) {
  console.log("No ingestion result - nothing to index");
  process.exit(1);
}

console.log(`Indexing ${result.codeFiles.reduce((sum, f) => sum + f.chunks.length, 0)} chunks to Qdrant...`);
await codeIndexer.indexIngestion(result);

console.log("SUCCESS: Qdrant re-index complete");
process.exit(0);
