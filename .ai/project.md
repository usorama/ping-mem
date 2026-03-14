# Project: ping-mem

## Purpose
Universal Memory Layer for AI Agents — persistent, intelligent, contextually-aware memory across sessions, tools, and applications. Self-contained infrastructure consumed by other projects (openclaw, sn-assist, ro-new, etc.). Provides MCP server with 62 tools across 9 modules for memory management, semantic search, knowledge graphs, and multi-agent orchestration.

## Outcomes
- Persistent memory with session management and checkpoints
- Semantic search via vector embeddings (Qdrant)
- Knowledge graph with temporal relationship tracking (Neo4j)
- Multi-agent orchestration with quotas and TTL-based lifecycle
- Full-text searchable knowledge base (SQLite FTS5)
- Real-time web dashboard with observability (HTMX at /ui)
- Hybrid search combining semantic, keyword, and graph queries
- Diagnostics system with SARIF integration
- Codebase ingestion with git-aware file discovery and streaming persistence
- Causal reasoning with directional graph search

## Stack
TypeScript, Bun, MCP SDK (1.25.3), Hono (HTTP), HTMX (UI), Neo4j 5.25 (graph), Qdrant 1.12 (vectors), SQLite + sqlite-vec (storage), OpenAI SDK (embeddings), Zod 4 (validation), Cockatiel (circuit breakers)

## Architecture
- API: Hono REST on port 3003 with 40+ endpoints (/api/v1/session, /api/v1/context, /api/v1/codebase, /api/v1/diagnostics, /api/v1/knowledge, /api/v1/agents, /ui/*)
- Database: Triple-store — SQLite (event sourcing, core state), Neo4j (temporal code graph, entity relationships, lineage), Qdrant (vector embeddings, semantic search)
- MCP: 62 tools across 9 modules (Context, Graph, Codebase, Memory, Diagnostics, Worklog, Agent, Knowledge, Causal)
- Tests: 91 test files, bun test runner
- Modules: 24 top-level (admin, client, config, diagnostics, graph, http, ingest, knowledge, llm, mcp, memory, metrics, migration, observability, profile, pubsub, search, session, static, storage, types, util, validation, cli)
- Infrastructure: Docker Compose on OrbStack (3 services: neo4j, qdrant, ping-mem), multi-stage Dockerfile (oven/bun:1.2.5-alpine)
- Deployment: Production at https://ping-mem.ping-gadgets.com (Hostinger VPS), local on OrbStack

## Conventions
- Quality gate: `bun run typecheck && bun run lint && bun test` before any merge
- Test runner: bun test ONLY (never vitest/jest)
- Commit messages: explicit 'Why:' or 'Reason:' or 'Fixes #' — never inferred
- Security: AES-256-GCM API keys, timingSafeEqual auth, CSRF protection, rate limiting
- Event sourcing: immutable append-only SQLite EventStore
- ProjectId: SHA-256(remoteUrl + '::' + relativeToGitRoot) — path-independent
- TypeScript strict: exactOptionalPropertyTypes, noImplicitReturns, noImplicitOverride, noUncheckedIndexedAccess
- No `as any` type escapes
- Configuration centralized at src/config/runtime.ts
- Cross-project Docker volume: /Users/umasankr/Projects → /projects
- PR-Zero: all findings resolved before merge, no deferral to v2

## Quality Targets
- pr-zero target: ≤3 cycles (current: 39 cycles on feat/self-healing, actively improving)
- Plan predictability: ≥85%
- Test coverage: >80% on critical paths
- Uptime: self-healing within 60s of backend failure
- Security: SSRF/CSRF/CSP hardened

## Active Work
- Issue #29: Code structural intelligence — import graph, call graph, impact analysis, blast radius
- Issue #28: Replace n-gram hash vectorizer with BM25+TF-IDF for deterministic search quality
- Issue #27: FTS5 multi-word knowledge search returns 0 results
- Issue #26: Consolidate MCP and REST on single port 3003 (streamable-http transport)
