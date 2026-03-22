# Code Ingestion & Diagnostics Systems

## Code Ingestion (v1.1.0)

Deterministic, time-aware codebase understanding with full provenance.

### Pipeline
1. `IngestionOrchestrator.ingest()` — scan + semantic chunk (function/class/file) + git history
2. `TemporalCodeGraph.persistIngestion()` — Neo4j (files -> chunks -> commits)
3. `CodeIndexer.indexIngestion()` — Qdrant vectors + BM25/FTS5 (CodeChunkStore)
4. `IngestionQueue` — serial queue for concurrent requests
5. `IngestionEventEmitter` — progress/completion events

### Capabilities
- **Merkle tree hashing** for project integrity, manifest-based change detection
- **Code chunking**: separates code/comments/docstrings (TS, JS, Python)
- **Git history**: full commit DAG, file changes (A/M/D/R/C), unified diffs
- **Bi-temporal Neo4j graph**: point-in-time queries on code evolution
- **Semantic search**: deterministic hash-based vectors + BM25 hybrid
- **Explicit "why"**: parses `Why:`, `Reason:`, `Fixes #`, ADR refs from commit messages

### Usage
```bash
# MCP tools
codebase_ingest({ projectDir: "/path/to/project", forceReingest: false })
codebase_search({ query: "auth logic", projectId: "...", type: "code", limit: 10 })
codebase_timeline({ projectId: "...", filePath: "src/auth.ts", limit: 50 })
```

## Diagnostics System (v1.3.0)

Bit-for-bit reproducible diagnostics tracking with multi-tool support.

### Features
- **SARIF 2.1.0** integration (tsc, eslint, prettier)
- **Symbol-level attribution** via AST (TypeScript) or regex (Python)
- **LLM summaries** with content-addressable caching
- **Deterministic IDs**: `analysisId = sha256(projectId + treeHash + tool + config + findings)`

### Usage
```bash
# Generate SARIF
bun run diagnostics:tsc-sarif --output diagnostics/tsc.sarif
bun run diagnostics:eslint-sarif --output diagnostics/eslint.sarif

# Collect (batch)
bun run diagnostics:collect --projectDir . --sarifPaths "diagnostics/tsc.sarif,diagnostics/eslint.sarif"

# MCP tools
diagnostics_latest({ projectId: "...", toolName: "tsc" })
diagnostics_diff({ analysisIdA: "before", analysisIdB: "after" })
diagnostics_by_symbol({ analysisId: "...", groupBy: "symbol" })
diagnostics_summarize({ analysisId: "...", useLLM: true })
```

## Worklog
```bash
worklog_record({ kind: "diagnostics", title: "TypeScript check", status: "success", toolName: "tsc", durationMs: 1234 })
worklog_list({ sessionId: "...", limit: 20 })
```

## Admin System (v1.4.0)
- **Admin UI**: `/admin` with Basic Auth
- **API Key Management**: rotate, deactivate, seed (AES-256-GCM encrypted)
- **Project Management**: list/delete ingested projects
- **LLM Provider Config**: OpenAI, Anthropic, OpenRouter
