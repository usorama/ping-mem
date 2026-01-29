# Multi-Tool Diagnostics Example

This example demonstrates how to use ping-mem's diagnostics system with multiple tools (TypeScript, ESLint, Prettier).

## Setup

```bash
# Navigate to your project
cd /path/to/your/project

# Install ping-mem (if not already installed)
bun install ping-mem

# Start ping-mem server (optional, for MCP/REST access)
bun run ping-mem start
```

## Generate SARIF Files

```bash
# Create diagnostics directory
mkdir -p diagnostics

# Generate TypeScript diagnostics
bun run diagnostics:tsc-sarif --output diagnostics/tsc.sarif

# Generate ESLint diagnostics
bun run diagnostics:eslint-sarif --output diagnostics/eslint.sarif

# Generate Prettier diagnostics
bun run diagnostics:prettier-sarif --output diagnostics/prettier.sarif
```

## Collect Diagnostics (Batch Mode)

```bash
# Compute config hash
CONFIG_HASH=$(cat package.json bun.lock tsconfig.json | sha256sum | cut -d' ' -f1)

# Ingest all SARIF files at once
bun run diagnostics:collect \
  --projectDir . \
  --configHash $CONFIG_HASH \
  --sarifPaths "diagnostics/tsc.sarif,diagnostics/eslint.sarif,diagnostics/prettier.sarif" \
  --environmentHash "dev-$(uname -s)" \
  --recordWorklog
```

Output:
```json
{
  "success": true,
  "projectId": "ping-mem-abc123",
  "treeHash": "deadbeef...",
  "results": [
    {
      "analysisId": "tsc-analysis-id",
      "runId": "run-1",
      "toolName": "tsc",
      "findingsCount": 5
    },
    {
      "analysisId": "eslint-analysis-id",
      "runId": "run-2",
      "toolName": "eslint",
      "findingsCount": 12
    },
    {
      "analysisId": "prettier-analysis-id",
      "runId": "run-3",
      "toolName": "prettier",
      "findingsCount": 3
    }
  ],
  "totalFindings": 20
}
```

## Query Diagnostics via MCP

```typescript
// Get latest run for each tool
const tscRun = await ping_mem_diagnostics_latest({
  projectId: "ping-mem-abc123",
  toolName: "tsc"
});

const eslintRun = await ping_mem_diagnostics_latest({
  projectId: "ping-mem-abc123",
  toolName: "eslint"
});

// Compare across tools
const comparison = await ping_mem_diagnostics_compare_tools({
  projectId: "ping-mem-abc123",
  treeHash: "deadbeef...",
  toolNames: ["tsc", "eslint", "prettier"]
});

console.log(comparison);
// {
//   projectId: "...",
//   treeHash: "...",
//   toolCount: 3,
//   tools: [
//     { toolName: "tsc", total: 5, bySeverity: { error: 5 }, affectedFiles: 3 },
//     { toolName: "eslint", total: 12, bySeverity: { warning: 12 }, affectedFiles: 8 },
//     { toolName: "prettier", total: 3, bySeverity: { warning: 3 }, affectedFiles: 3 }
//   ],
//   overlappingFiles: [
//     { filePath: "src/index.ts", tools: ["tsc", "prettier"] }
//   ],
//   aggregateSeverity: { error: 5, warning: 15 },
//   totalFindings: 20
// }
```

## Query by Symbol

```typescript
// Group findings by symbol
const bySymbol = await ping_mem_diagnostics_by_symbol({
  analysisId: tscRun.analysisId,
  groupBy: "symbol"
});

console.log(bySymbol);
// {
//   analysisId: "...",
//   groupBy: "symbol",
//   symbolCount: 3,
//   symbols: [
//     {
//       symbolId: "symbol-1",
//       symbolName: "processData",
//       symbolKind: "function",
//       filePath: "src/utils.ts",
//       total: 3,
//       bySeverity: { error: 2, warning: 1 }
//     },
//     ...
//   ],
//   totalAttributed: 5,
//   totalUnattributed: 0
// }
```

## Get LLM Summary

```typescript
// Generate summary with LLM (requires OPENAI_API_KEY)
const summary = await ping_mem_diagnostics_summarize({
  analysisId: tscRun.analysisId,
  useLLM: true
});

console.log(summary);
// {
//   analysisId: "...",
//   useLLM: true,
//   summary: {
//     text: "The codebase has 5 type errors across 3 files. The most critical issues are in utils.ts:processData() with 2 type mismatches. Recommend fixing the processData function signature first, then addressing the remaining errors in auth.ts.",
//     model: "gpt-4o-mini",
//     provider: "openai",
//     promptTokens: 150,
//     completionTokens: 45,
//     costUsd: 0.00012,
//     isFromCache: false
//   },
//   findingsCount: 5
// }

// Subsequent calls use cached summary (no API cost)
const cached = await ping_mem_diagnostics_summarize({
  analysisId: tscRun.analysisId,
  useLLM: true
});
// cached.summary.isFromCache === true
```

## REST API Usage

```bash
# Compare tools
curl -X POST http://localhost:3000/api/v1/diagnostics/compare-tools \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "ping-mem-abc123",
    "treeHash": "deadbeef...",
    "toolNames": ["tsc", "eslint", "prettier"]
  }'

# Get LLM summary
curl -X POST http://localhost:3000/api/v1/diagnostics/summarize/analysis-123 \
  -H "Content-Type: application/json" \
  -d '{ "useLLM": true }'
```

## CI/CD Integration

See `.github/workflows/diagnostics.yml` for the full workflow that:
1. Generates SARIF files for all three tools
2. Batch ingests via CLI
3. Uploads artifacts
4. Runs performance benchmarks

```yaml
- name: Generate SARIF files
  run: |
    bun run diagnostics:tsc-sarif --output diagnostics/tsc.sarif || true
    bun run diagnostics:eslint-sarif --output diagnostics/eslint.sarif || true
    bun run diagnostics:prettier-sarif --output diagnostics/prettier.sarif || true

- name: Collect diagnostics
  run: |
    bun run diagnostics:collect \
      --projectDir $PWD \
      --configHash ${{ steps.config.outputs.hash }} \
      --sarifPaths "diagnostics/tsc.sarif,diagnostics/eslint.sarif,diagnostics/prettier.sarif"
```

## Performance Expectations

- **Small project** (< 1,000 findings): < 30 seconds
- **Medium project** (1,000-10,000 findings): < 2 minutes
- **Large project** (> 10,000 findings): < 5 minutes

See [PERFORMANCE.md](../../docs/PERFORMANCE.md) for detailed benchmarks.
