# Contributing to ping-mem

Thank you for your interest in contributing to ping-mem! This guide covers how to set up your development environment, run tests, and submit changes.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- [Docker](https://www.docker.com/) and Docker Compose (for full-stack features)
- [Git](https://git-scm.com/)

### Setup

```bash
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem
bun install
bun run build
```

### Start Dependencies (Optional)

For code ingestion and knowledge graph features:

```bash
docker compose up -d ping-mem-neo4j ping-mem-qdrant
```

---

## Development Workflow

### Build

```bash
bun run build        # Compile TypeScript
bun run dev          # Watch mode
```

### Test

```bash
bun test             # Run all tests
bun test --watch     # Watch mode
bun test src/memory  # Run tests in a specific directory
```

### Type Check

```bash
bun run typecheck    # Must pass with 0 errors
```

### Quality Gates

All three must pass before submitting a PR:

| Gate | Command | Requirement |
|------|---------|-------------|
| TypeScript | `bun run typecheck` | 0 errors |
| Tests | `bun test` | All pass |
| Build | `bun run build` | No errors |

---

## Project Structure

```
src/
├── mcp/            # MCP server (stdio transport)
├── http/           # HTTP server (REST/SSE)
├── client/         # Client SDK
├── memory/         # Memory CRUD operations + RelevanceEngine
├── session/        # Session lifecycle
├── storage/        # SQLite event store + WriteLockManager
├── ingest/         # Code ingestion pipeline
├── graph/          # Neo4j knowledge graph + causal graph
├── search/         # Qdrant vector search
├── diagnostics/    # SARIF diagnostics tracking
├── admin/          # Admin panel and API key management
├── knowledge/      # KnowledgeStore (FTS5 knowledge entries)
├── pubsub/         # MemoryPubSub (real-time event bus)
├── integration/    # CcMemoryBridge and cross-system bridges
├── observability/  # Health monitoring and probes
├── config/         # Runtime configuration
├── types/          # TypeScript type definitions
├── util/           # Logger, auth utilities, path safety
└── validation/     # Input validation (Zod schemas)
```

---

## Code Style

### TypeScript

- Strict mode is enabled (`strict: true` in `tsconfig.json`)
- No `any` types — use proper type definitions
- Use `bun:sqlite` for database access
- Prefer `async/await` over callbacks
- Use content-addressable IDs (SHA-256) for deterministic operations

### Naming

- Files: `PascalCase.ts` for classes, `camelCase.ts` for utilities
- Types/interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`

### Tests

- Test files live next to source: `src/module/__tests__/Module.test.ts`
- Use Bun's built-in test runner (`bun test`)
- Test deterministic behavior — same inputs must produce same outputs
- Mock external services (Neo4j, Qdrant) in unit tests

---

## Making Changes

### 1. Create a Branch

```bash
git checkout -b feat/your-feature
# or
git checkout -b fix/your-bugfix
```

### 2. Make Changes

- Write code
- Add or update tests
- Run quality gates

### 3. Commit

Write clear commit messages:

```
feat: Add semantic search filtering by file type
fix: Prevent SQL injection in EventStore.deleteSessions
docs: Update API reference with new diagnostics tools
test: Add determinism tests for CodeChunker
```

Prefix with: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

### 4. Submit a Pull Request

```bash
git push origin feat/your-feature
```

Open a PR against `main`. Include:
- Description of what changed and why
- How to test the changes
- Any breaking changes

---

## Areas for Contribution

### High Priority

Check the [CLAUDE.md](CLAUDE.md) for current priorities and architecture details.

### Feature Work

- Differential code queries ("What changed between commit A and B?")
- PostgreSQL storage backend
- Additional language support for code chunking

### Documentation

- Improve inline code comments
- Add more usage examples
- Write integration test guides

---

## Testing

### Running Tests

```bash
# All tests
bun test

# Specific file
bun test src/memory/__tests__/MemoryManager.test.ts

# Specific directory
bun test src/diagnostics/

# Watch mode
bun test --watch
```

### Writing Tests

Tests should verify deterministic behavior:

```typescript
import { describe, it, expect } from "bun:test";
import { CodeChunker } from "../CodeChunker";

describe("CodeChunker", () => {
  it("produces deterministic chunk IDs", () => {
    const chunker = new CodeChunker();
    const result1 = chunker.chunk("const x = 1;", "test.ts");
    const result2 = chunker.chunk("const x = 1;", "test.ts");

    expect(result1[0].id).toBe(result2[0].id);
  });
});
```

### Test Structure

```
src/
└── module/
    ├── Module.ts
    └── __tests__/
        └── Module.test.ts
```

---

## Reporting Issues

File issues on [GitHub Issues](https://github.com/ping-gadgets/ping-mem/issues) with:

- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Bun version, Docker version)
- Relevant logs

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
