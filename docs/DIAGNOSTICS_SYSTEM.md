## Deterministic Diagnostics + Worklog - Current State and Gaps

### Current indexing (evidence-based)

**Codebase indexing**
- Deterministic project scan + Merkle tree hashing with manifest storage in `.ping-mem/manifest.json`.
- `projectId` derived from git identity plus project path.
- Deterministic code chunking with `chunkId = sha256(filePath + fileSha256 + type + start + end + content)`.
- Qdrant indexing with full chunk provenance payload (projectId, filePath, chunkId, sha256, type, start, end, ingestedAt).
- Neo4j temporal graph persistence for Project/File/Chunk/Commit relationships.

**Git history indexing**
- Commit DAG, file changes, and diff hunks ingested deterministically from git.
- Neo4j relationships:
  - (Commit)-[:MODIFIES]->(File)
  - (Commit)-[:CHANGES]->(Chunk) using diff hunk metadata

**Session and memory events**
- Append-only SQLite `EventStore` for session/memory/checkpoint events.
- `EventType` currently limited to session lifecycle and memory operations.
- `MemoryManager` stores memories in memory and records events; `SessionManager.loadContextFrom` is a placeholder.

### Gaps that block deterministic bug discovery

1. **No diagnostics ingestion pipeline** for test/lint/typecheck results.
2. **No deterministic linking** of diagnostics to code chunks (line vs offset mismatch).
3. **Work history is not captured** beyond session/memory events.
4. **Transport parity gap**: SSE lists tools it cannot execute; REST lacks codebase endpoints.

### Attribution risk (must fix)

Neo4j CHANGES uses git hunk line numbers while chunk offsets are byte-based. This mismatch weakens attribution for diagnostics and diff reasoning.
