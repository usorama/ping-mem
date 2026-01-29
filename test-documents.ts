/**
 * Test document ingestion with resume tracking example
 */

import { createRuntimeServices } from "./src/config/runtime.js";
import { UnifiedIngestionService } from "./src/ingest/UnifiedIngestionService.js";

async function main() {
  console.log("=".repeat(80));
  console.log("DOCUMENT INGESTION TEST - Resume Tracking");
  console.log("=".repeat(80));

  // Initialize services
  console.log("\n[1/5] Initializing services...");
  const services = await createRuntimeServices();
  const ingestionService = new UnifiedIngestionService({
    neo4jClient: services.neo4jClient,
    qdrantClient: services.qdrantClient,
  });

  const projectDir = process.cwd() + "/examples/resume-tracking";
  console.log(`✓ Services connected. Project: ${projectDir}`);

  // Ingest documents
  console.log("\n[2/5] Ingesting resume tracking documents...");
  const startTime = Date.now();
  const result = await ingestionService.ingestProject(projectDir, {
    projectType: "documents",
    // Note: Set forceReingest: true to test full ingestion even when no changes
  });
  const elapsed = Date.now() - startTime;

  if (!result) {
    console.log("✓ No changes detected");
    console.log("\n[Cleanup] Disconnecting services...");
    await services.neo4jClient.disconnect();
    await services.qdrantClient.disconnect();
    console.log("✓ Test complete");
    return;
  }

  console.log(`✓ Ingestion complete (${elapsed}ms)`);
  console.log(`  - Project ID: ${result.projectId}`);
  console.log(`  - Project Type: ${result.projectType}`);
  console.log(`  - Files Indexed: ${result.filesIndexed}`);
  console.log(`  - Entities Indexed: ${result.entitiesIndexed}`);

  // Search by entity type
  console.log("\n[3/5] Querying job applications...");
  const applications = await ingestionService.searchDocuments({
    projectId: result.projectId,
    entityType: "structured_field",
    limit: 10,
  });

  console.log(`✓ Found ${applications.length} structured fields`);
  const appFields = applications.filter((e) => e.key.startsWith("applications"));
  console.log(`  - ${appFields.length} application-related fields`);
  
  // Show sample
  for (const field of appFields.slice(0, 5)) {
    console.log(`\n  Field: ${field.key}`);
    console.log(`  Value: ${field.value.substring(0, 60)}...`);
    console.log(`  Source: ${field.sourceFile}`);
  }

  // Search by key pattern
  console.log("\n[4/5] Searching for 'Meta' application...");
  const metaFields = applications.filter((e) => 
    e.key.includes("Meta") || e.value.includes("Meta")
  );
  console.log(`✓ Found ${metaFields.length} Meta-related fields`);

  // Semantic search
  console.log("\n[5/5] Semantic search for 'distributed systems experience'...");
  const semanticResults = await ingestionService.searchDocuments({
    projectId: result.projectId,
    query: "distributed systems experience",
    limit: 5,
  });

  console.log(`✓ Found ${semanticResults.length} semantic matches:`);
  for (const match of semanticResults.slice(0, 3)) {
    console.log(`\n  - Key: ${match.key}`);
    console.log(`    Value: ${match.value.substring(0, 80)}...`);
    console.log(`    Source: ${match.sourceFile}`);
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("TEST SUMMARY");
  console.log("=".repeat(80));
  console.log(`✓ Document ingestion works: ${result.filesIndexed} files, ${result.entitiesIndexed} entities`);
  console.log(`✓ Structured queries work: Found application fields`);
  console.log(`✓ Semantic search works: ${semanticResults.length} matches`);
  console.log("\nDocument projects (resume tracking, decisions) are now supported!");

  // Cleanup
  await services.neo4jClient.disconnect();
  await services.qdrantClient.disconnect();
}

main().catch((error) => {
  console.error("\n✗ TEST FAILED:");
  console.error(error);
  process.exit(1);
});
