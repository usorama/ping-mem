/**
 * Extract OpenAPI spec from the ping-mem REST server and write to sdk/openapi.json.
 *
 * Usage: bun run scripts/extract-openapi.ts
 */
import { generateOpenAPISpec } from "../src/http/routes/openapi.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const outPath = resolve(import.meta.dirname ?? ".", "../sdk/openapi.json");
mkdirSync(dirname(outPath), { recursive: true });

const spec = generateOpenAPISpec();
writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n", "utf-8");

console.log(`OpenAPI spec written to ${outPath}`);
