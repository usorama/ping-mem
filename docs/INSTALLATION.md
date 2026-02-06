# ping-mem Installation Guide

Complete installation guide for ping-mem Universal Memory Layer.

---

## Installation Architecture

ping-mem uses a **three-script architecture**:

| Script | Purpose | Runs Once |
|--------|---------|-----------|
| `setup.sh` | Install ping-mem infrastructure (Docker + services) | Per machine |
| `install-client.sh` | Install client tools in IDE/project | Per project or global |
| `ingest-project.sh` | Ingest a codebase into ping-mem | Per project |

---

## Quick Start (3 Commands)

```bash
# 1. Install ping-mem infrastructure
./scripts/setup.sh

# 2. Install client tools for your project
./scripts/install-client.sh /path/to/your/project

# 3. Ingest your project
./scripts/ingest-project.sh /path/to/your/project
```

Done! Your IDE now has ping-mem tools available.

---

## Detailed Installation

### Step 1: Install ping-mem Infrastructure

**What it does:**
- Validates prerequisites (bun, docker)
- Installs dependencies and builds TypeScript
- Starts Docker services (Neo4j, Qdrant, ping-mem HTTP server)
- Runs health checks

**Command:**
```bash
cd /path/to/ping-mem
./scripts/setup.sh
```

**Options:**
```bash
./scripts/setup.sh --docker-only   # Skip bun install/build
./scripts/setup.sh --skip-docker   # Skip Docker start
```

**What you get:**
- Neo4j: http://localhost:7474 (graph database)
- Qdrant: http://localhost:6333 (vector database)
- ping-mem: http://localhost:3000 (HTTP API)

**Note**: MCP server is NOT in Docker (runs locally via stdio).

---

### Step 2: Install Client Tools

**What it does:**
- Detects your IDE/CLI environment (Cursor, VS Code, Claude Code, Cline, etc.)
- Prompts you to choose one or more environments to configure
- Installs appropriate MCP configuration
- Copies `.cursorrules` for agent instructions
- Creates project-specific `.ping-mem/` directory
- Triggers ingestion automatically for project installs

**For a specific project:**
```bash
./scripts/install-client.sh /path/to/your/project
```

**For all projects (global):**
```bash
./scripts/install-client.sh --global
```

**Detected environments:**
- **Cursor**: Creates `.cursor/mcp.json`
- **VS Code**: Detects `.vscode/` directory
- **Claude Code**: Updates `~/.claude/mcp.json`
- **Cline**: Detects VS Code extension
- **Generic**: Falls back to basic config

**Files created:**
```
your-project/
├── .cursor/
│   └── mcp.json          # Cursor MCP config
├── .cursorrules          # Agent instructions
└── .ping-mem/
    ├── config.json       # Project config
    └── manifest.json     # Created after ingestion
```

---

### Step 3: Ingest Your Project

**What it does:**
- Scans all code files (TypeScript, JavaScript, Python, etc.)
- Separates code vs comments vs docstrings
- Extracts full git history (commits, diffs, hunks)
- Indexes into Neo4j (temporal graph)
- Indexes into Qdrant (semantic vectors)
- Creates deterministic manifest

**Command (if you installed globally or want to re-ingest):**
```bash
./scripts/ingest-project.sh /path/to/your/project
```

**What gets ingested:**
- All code files (respects .gitignore)
- Comments and docstrings separately
- Git commit history with explicit "why"
- File change hunks mapped to code chunks

**Time estimate:**
- Small project (<1000 files): 1-2 minutes
- Medium project (1000-5000 files): 3-10 minutes
- Large project (>5000 files): 10-30 minutes

---

## Environment Variables

Optional variables for diagnostics summaries:

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_MEM_ENABLE_LLM_SUMMARIES` | `false` | Enable LLM summaries for diagnostics |
| `OPENAI_API_KEY` | | OpenAI API key (only used when summaries are enabled) |

## IDE-Specific Instructions

### Cursor IDE

```bash
# Install for current project
cd /path/to/your/project
/path/to/ping-mem/scripts/install-client.sh .

# Restart Cursor
# MCP tools will appear automatically
```

**Verify:**
1. Open Cursor
2. Check that ping-mem tools are available in MCP panel
3. Try: `context_health` tool

### Claude Code

```bash
# Install globally
/path/to/ping-mem/scripts/install-client.sh --global

# Restart Claude Code
```

**Verify:**
1. Check `~/.claude/mcp.json` contains ping-mem entry
2. Run any ping-mem tool

### VS Code + Cline

```bash
# Install for project
cd /path/to/your/project
/path/to/ping-mem/scripts/install-client.sh .

# Restart VS Code
```

**Verify:**
1. Open Cline extension
2. Check MCP tools are available

### Kilo Code / Other Extensions

Same process as above - the script detects the environment automatically.

---

## npm Script Shortcuts

All scripts are also available via npm:

```bash
# Infrastructure
bun run setup                # Full setup
bun run setup:docker         # Start Docker only
bun run health               # Check all services

# Client installation
bun run install:client       # Install for current dir
bun run install:client:global # Install globally

# Project ingestion
bun run ingest               # Ingest current dir

# Testing
bun run smoke-test           # Run smoke tests
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Your Machine                                                │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Docker (OrbStack)                                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │  │
│  │  │  Neo4j   │  │  Qdrant  │  │  ping-mem HTTP   │  │  │
│  │  │  :7687   │  │  :6333   │  │  :3000           │  │  │
│  │  └──────────┘  └──────────┘  └──────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
│                          ▲                                  │
│                          │ HTTP                             │
│  ┌───────────────────────┴──────────────────────────────┐  │
│  │ MCP Server (stdio, runs locally)                     │  │
│  │  bun run dist/mcp/cli.js                             │  │
│  └───────────────────────┬──────────────────────────────┘  │
│                          │ stdio                            │
│  ┌───────────────────────┴──────────────────────────────┐  │
│  │ IDE (Cursor, VS Code, Claude Code, etc.)            │  │
│  │  - Loads .cursor/mcp.json or ~/.claude/mcp.json     │  │
│  │  - Reads .cursorrules for agent instructions        │  │
│  │  - Calls ping-mem tools via MCP                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Your Projects                                        │  │
│  │  /Users/you/Projects/project-a/.ping-mem/           │  │
│  │  /Users/you/Projects/project-b/.ping-mem/           │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Why MCP is NOT in Docker

**Question**: Why doesn't Docker include the MCP server?

**Answer**: MCP uses **stdio transport** (stdin/stdout) which requires:
- Direct process communication with IDE
- File descriptor inheritance
- TTY access

Docker containers can't easily provide this. Instead:
- **MCP server runs locally** (via `bun run dist/mcp/cli.js`)
- **Connects to Dockerized services** (Neo4j, Qdrant, ping-mem HTTP)
- **IDE communicates via stdio** (standard input/output)

This architecture provides:
- ✅ IDE integration (stdio works natively)
- ✅ Service isolation (Neo4j/Qdrant in Docker)
- ✅ Shared infrastructure (all projects use same services)

---

## Verification

After installation, verify everything works:

```bash
# 1. Check services
bun run health

# 2. Run smoke test
bun run smoke-test

# 3. Test MCP connection (in your IDE)
# Run: context_health
# Should return: { status: "healthy", ... }

# 4. Test search (after ingestion)
# Run: codebase_search({ query: "function" })
# Should return: { results: [...] }
```

---

## Troubleshooting

### Services won't start

```bash
# Check Docker is running
docker info

# Check ports are available
lsof -i :3000  # ping-mem
lsof -i :7474  # Neo4j
lsof -i :6333  # Qdrant

# Restart services
docker compose down
docker compose up -d
```

### MCP tools not appearing

```bash
# 1. Check MCP config exists
cat .cursor/mcp.json    # Cursor
cat ~/.claude/mcp.json  # Claude Code

# 2. Check ping-mem is built
ls dist/mcp/cli.js

# 3. Rebuild if needed
bun run build

# 4. Restart IDE
```

### Ingestion fails

```bash
# Check logs
docker compose logs ping-mem

# Check Neo4j/Qdrant are healthy
curl http://localhost:7474
curl http://localhost:6333/health

# Try force re-ingest
curl -X POST http://localhost:3000/api/v1/codebase/ingest \
  -H "Content-Type: application/json" \
  -d '{"projectDir":"/path/to/project","forceReingest":true}'
```

---

## Uninstallation

```bash
# Remove Docker services
docker compose down -v  # -v removes volumes

# Remove client configs
rm -rf .cursor/mcp.json
rm -rf .cursorrules
rm -rf .ping-mem/

# Remove global config
rm -rf ~/.claude/mcp.json  # Backup first if you have other servers
```

---

## See Also

- [AGENT_INSTRUCTIONS.md](../AGENT_INSTRUCTIONS.md) - Agent workflow
- [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) - Detailed patterns
- [CLAUDE.md](../CLAUDE.md) - Full project documentation
- [DOCKER.md](../DOCKER.md) - Docker deployment details
