/**
 * One-time migration script: remove .env file vectors from Qdrant.
 *
 * Scans the ping-mem-vectors collection for chunks whose filePath
 * matches *.env* and deletes them. Safe to run multiple times (idempotent).
 *
 * Usage: bun run scripts/cleanup-env-vectors.ts [--qdrant-url http://localhost:6333]
 */

const COLLECTION = "ping-mem-vectors";
const BATCH_SIZE = 100;

function parseQdrantUrl(): string {
  const idx = process.argv.indexOf("--qdrant-url");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1]!.replace(/\/+$/, "");
  }
  return "http://localhost:6333";
}

interface QdrantPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

interface ScrollResponse {
  result: {
    points: QdrantPoint[];
    next_page_offset: string | number | null;
  };
}

async function main(): Promise<void> {
  const qdrantUrl = parseQdrantUrl();
  console.log(`Connecting to Qdrant at ${qdrantUrl}`);
  console.log(`Collection: ${COLLECTION}`);

  // Verify collection exists
  const collectionRes = await fetch(`${qdrantUrl}/collections/${COLLECTION}`);
  if (!collectionRes.ok) {
    console.error(`Collection '${COLLECTION}' not found (status ${collectionRes.status}). Nothing to clean up.`);
    process.exit(0);
  }

  let totalDeleted = 0;
  let offset: string | number | null = null;

  // Scroll through all points, filtering for .env files
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const scrollBody: Record<string, unknown> = {
      limit: BATCH_SIZE,
      with_payload: ["filePath"],
      with_vector: false,
    };
    if (offset !== null) {
      scrollBody.offset = offset;
    }

    const scrollRes = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scrollBody),
    });

    if (!scrollRes.ok) {
      const errText = await scrollRes.text();
      console.error(`Scroll request failed: ${scrollRes.status} — ${errText}`);
      process.exit(1);
    }

    const scrollData = (await scrollRes.json()) as ScrollResponse;
    const points = scrollData.result.points;

    // Find points with .env in filePath
    const envPointIds: Array<string | number> = [];
    for (const point of points) {
      const filePath = point.payload.filePath;
      if (typeof filePath === "string" && /\.env/i.test(filePath)) {
        envPointIds.push(point.id);
      }
    }

    // Delete matching points
    if (envPointIds.length > 0) {
      const deleteRes = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: envPointIds }),
      });

      if (!deleteRes.ok) {
        const errText = await deleteRes.text();
        console.error(`Delete request failed: ${deleteRes.status} — ${errText}`);
        process.exit(1);
      }

      totalDeleted += envPointIds.length;
      console.log(`  Deleted ${envPointIds.length} .env vectors (batch)`);
    }

    // Check for next page
    offset = scrollData.result.next_page_offset;
    if (offset === null || offset === undefined || points.length === 0) {
      break;
    }
  }

  console.log(`\nDone. Total .env vectors deleted: ${totalDeleted}`);
}

await main();
