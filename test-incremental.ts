/**
 * Test incremental ingestion after bug fixes
 */

import { createRuntimeServices } from "./src/config/runtime.js";
import { IngestionService } from "./src/ingest/IngestionService.js";

async function main() {
  console.log("=".repeat(80));
  console.log("INCREMENTAL INGESTION TEST - ping-mem Codebase");
  console.log("=".repeat(80));

  // Initialize services
  console.log("\n[1/6] Initializing services...");
  const services = await createRuntimeServices();
  const ingestionService = new IngestionService({
    neo4jClient: services.neo4jClient,
    qdrantClient: services.qdrantClient,
  });

  const projectDir = process.cwd();
  console.log(`✓ Services connected. Project: ${projectDir}`);

  // Test 1: Check manifest before ingestion
  console.log("\n[2/6] Checking existing manifest...");
  const verifyBefore = await ingestionService.verifyProject(projectDir);
  console.log(`  - Project ID (old): ${verifyBefore.projectId}`);
  console.log(`  - Manifest Tree Hash: ${verifyBefore.manifestTreeHash || "none"}`);
  console.log(`  - Current Tree Hash: ${verifyBefore.currentTreeHash || "none"}`);
  console.log(`  - Valid: ${verifyBefore.valid}`);

  // Test 2: Ingest (should detect changes due to new commit)
  console.log("\n[3/6] Ingesting codebase (detecting changes)...");
  const startTime = Date.now();
  const result = await ingestionService.ingestProject({ 
    projectDir: projectDir,
    forceReingest: false 
  });
  const elapsed = Date.now() - startTime;

  if (!result) {
    console.log("⚠️  No changes detected (unexpected - we just committed!)");
    await services.neo4jClient.disconnect();
    await services.qdrantClient.disconnect();
    return;
  }

  console.log(`✓ Ingestion complete (${elapsed}ms)`);
  console.log(`  - Project ID (new): ${result.projectId}`);
  console.log(`  - Tree Hash (new): ${result.treeHash}`);
  console.log(`  - Files Indexed: ${result.filesIndexed}`);
  console.log(`  - Code Chunks: ${result.chunksIndexed}`);
  console.log(`  - Git Commits: ${result.commitsIndexed}`);

  // Test 3: Verify manifest after ingestion
  console.log("\n[4/6] Verifying updated manifest...");
  const verifyAfter = await ingestionService.verifyProject(projectDir);
  console.log(`  - Manifest integrity: ${verifyAfter.isValid ? "✓ VALID" : "✗ INVALID"}`);
  console.log(`  - Project ID matches: ${verifyAfter.projectId === result.projectId ? "✓ YES" : "✗ NO"}`);
  console.log(`  - Tree Hash matches: ${verifyAfter.treeHash === result.treeHash ? "✓ YES" : "✗ NO"}`);

  // Test 4: Re-ingest immediately (should detect NO changes)
  console.log("\n[5/6] Re-ingesting immediately (determinism check)...");
  const result2 = await ingestionService.ingestProject({ projectDir: projectDir });
  if (result2 === null) {
    console.log("✓ No changes detected (CORRECT - determinism verified!)");
  } else {
    console.log("✗ Changes detected (INCORRECT - determinism broken!)");
    console.log(`  - Files: ${result2.filesIndexed}, Chunks: ${result2.chunksIndexed}`);
  }

  // Test 5: Search for bug fix commits
  console.log("\n[6/6] Querying git timeline for 'bug fix' commits...");
  const timeline = await ingestionService.queryTimeline({
    projectId: result.projectId,
    limit: 5,
  });

  console.log(`✓ Found ${timeline.length} recent commits:`);
  for (const event of timeline.slice(0, 3)) {
    console.log(`\n  Commit: ${event.commitHash?.substring(0, 8) || "unknown"}`);
    console.log(`  Date: ${event.date || event.timestamp || "unknown"}`);
    console.log(`  Message: ${event.message?.substring(0, 80)}${event.message && event.message.length > 80 ? "..." : ""}`);
    if (event.why) {
      console.log(`  Why: ${event.why}`);
    }
    if (event.changeType) {
      console.log(`  Change Type: ${event.changeType}`);
    }
  }

  // Test 6: Semantic search for "ProjectScanner getGitIdentity"
  console.log("\n[7/7] Semantic search: 'ProjectScanner getGitIdentity'...");
  const searchResults = await ingestionService.searchCode(
    "getGitIdentity compute project ID",
    {
      projectId: result.projectId,
      limit: 5,
    }
  );

  console.log(`✓ Found ${searchResults.length} code chunks:`);
  for (const chunk of searchResults.slice(0, 3)) {
    console.log(`\n  File: ${chunk.filePath}`);
    console.log(`  Type: ${chunk.type}`);
    console.log(`  Content: ${chunk.content.substring(0, 100).replace(/\n/g, " ")}...`);
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("TEST SUMMARY");
  console.log("=".repeat(80));
  console.log(`✓ Project ID changed: ${verifyBefore.projectId !== result.projectId ? "YES (due to bug fix)" : "NO"}`);
  console.log(`✓ Incremental detection works: ${result2 === null ? "YES" : "NO"}`);
  console.log(`✓ Determinism verified: ${result2 === null ? "YES" : "NO"}`);
  console.log(`✓ Git timeline works: ${timeline.length > 0 ? "YES" : "NO"}`);
  console.log(`✓ Semantic search works: ${searchResults.length > 0 ? "YES" : "NO"}`);
  console.log(`\nMathematical Verification:`);
  console.log(`  - Old Project ID: ${verifyBefore.projectId}`);
  console.log(`  - New Project ID: ${result.projectId}`);
  console.log(`  - Old Tree Hash: ${verifyBefore.manifestTreeHash || "none"}`);
  console.log(`  - New Tree Hash: ${result.treeHash}`);
  console.log(`  - Files Indexed: ${result.filesIndexed}`);
  console.log(`  - Code Chunks: ${result.chunksIndexed}`);
  console.log(`  - Commits: ${result.commitsIndexed}`);

  // Cleanup
  await services.neo4jClient.disconnect();
  await services.qdrantClient.disconnect();
}

main().catch((error) => {
  console.error("\n✗ TEST FAILED:");
  console.error(error);
  process.exit(1);
});
