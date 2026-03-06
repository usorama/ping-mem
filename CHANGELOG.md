# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-14

### Added
- Initial release of ping-mem — persistent memory layer for AI coding agents
- MCP (Model Context Protocol) server with 32+ tools for memory operations
- REST API and SSE server for flexible integration
- Multi-project support with `codebase_list_projects` tool and project discovery
- Deterministic temporal code ingestion system with line numbers and diagnostics
- Cross-session intelligence with relevance decay and proactive recall
- UserProfile system with SQLite store for personalized memory
- SessionManager with hydration for persistence across restarts
- Memory migration infrastructure (Phase 0–2) for data portability
- Qdrant vector database integration for semantic search
- Git history reader for codebase-aware memory
- Docker Compose support for self-hosting
- GitHub Actions workflow for diagnostics collection
- Comprehensive test suite including determinism and regression tests
- MIT LICENSE

### Fixed
- Docker deployment and SSE server startup issues
- Path-independent projectId for Docker/local parity
- Batched Qdrant upserts to prevent 400 errors on large repos
- SQL injection prevention in EventStore
- Command injection prevention in GitHistoryReader
- Timing attack prevention and input validation
- Path traversal prevention in SafeGit file content access

### Changed
- Diagnostics subsystem enhanced with multi-tool support, symbols, LLM integration, and performance improvements
