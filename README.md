# ping-mem

**Universal Memory Layer for AI Agents**

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

ping-mem is a Model Context Protocol (MCP) server that provides persistent memory and knowledge graph capabilities for AI agents. It supports session management, context storage, semantic search, entity extraction, and relationship tracking.

## Features

- **Context Management** - Save, retrieve, and search context with categories and priorities
- **Session Support** - Organize context by sessions with checkpoints
- **Semantic Search** - Vector-based similarity search (requires Qdrant)
- **Entity Extraction** - Automatic extraction of entities from context
- **Knowledge Graph** - Temporal relationship tracking with Neo4j
- **Hybrid Search** - Combined semantic, keyword, and graph search
- **Lineage Tracking** - Trace upstream/downstream entity relationships
- **Evolution Queries** - Track entity changes over time
- **HTTP Server** - REST and SSE endpoints for direct integration

## Quick Start

### Installation

```bash
# Clone repository
git clone https://github.com/ping-gadgets/ping-mem.git
cd ping-mem

# Install dependencies
bun install
```

### Basic Usage (SQLite only)

```bash
# Build
bun run build

# Run MCP server
bun run dist/mcp/cli.js

# Or start HTTP server (REST mode)
bun run start
```

### Full Stack (with Neo4j and Qdrant)

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your API keys
vim .env

# Start all services
docker-compose up -d

# Verify health
docker-compose ps
```

## Usage as Library

```typescript
import { PingMemServer } from 'ping-mem/mcp';
import { createHttpServer } from 'ping-mem/http';

// Create MCP server
const server = new PingMemServer({
  dbPath: './ping-mem.db'
});

// Or create HTTP server
const httpServer = createHttpServer({
  port: 3000,
  transport: 'rest' // or 'sse'
});
```

## MCP Tools

### Core Tools

| Tool | Description |
|------|-------------|
| `context_session_start` | Start a new session |
| `context_save` | Save context with optional entity extraction |
| `context_get` | Retrieve context by key, category, or filters |
| `context_search` | Search context by query |
| `context_checkpoint` | Create a named checkpoint |
| `context_status` | Get current session status |

### Graph Tools (requires Neo4j/Qdrant)

| Tool | Description |
|------|-------------|
| `context_query_relationships` | Query entity relationships |
| `context_hybrid_search` | Combined semantic/keyword/graph search |
| `context_get_lineage` | Trace entity lineage |
| `context_query_evolution` | Query temporal evolution |

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PING_MEM_DB_PATH` | | `:memory:` | SQLite database path |
| `PING_MEM_VECTOR_SEARCH` | | `false` | Enable vector search |
| `NEO4J_URI` | For graph | | Neo4j Bolt URI |
| `NEO4J_USERNAME` | For graph | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | For graph | | Neo4j password |
| `QDRANT_URL` | For vectors | | Qdrant REST URL |
| `OPENAI_API_KEY` | For embeddings | | OpenAI API key |
| `PING_MEM_PORT` | | `3000` | HTTP server port |
| `PING_MEM_TRANSPORT` | | `rest` | HTTP transport mode (rest/sse) |

### Claude Code Integration

Add to your Claude Code MCP settings (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/path/to/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.claude/ping-mem.db",
        "PING_MEM_VECTOR_SEARCH": "false"
      }
    }
  }
}
```

## Development

### Prerequisites

- Bun runtime (required for bun:sqlite)
- Docker (for Neo4j/Qdrant)
- Node.js 18+ (for TypeScript)

### Commands

```bash
# Install dependencies
bun install

# Build TypeScript
bun run build

# Run tests
bun test

# Type checking
bun run typecheck

# Watch mode
bun run dev

# Start HTTP server
bun run start           # REST mode
bun run start:sse       # SSE mode
bun run start:rest      # REST mode (explicit)
```

### Project Structure

```
ping-mem/
├── src/
│   ├── mcp/           # MCP server implementation
│   ├── http/          # HTTP server (REST/SSE)
│   ├── graph/         # Knowledge graph layer
│   │   ├── EntityExtractor.ts
│   │   ├── GraphManager.ts
│   │   └── RelationshipManager.ts
│   ├── search/        # Search engines
│   │   ├── VectorIndex.ts
│   │   ├── HybridSearchEngine.ts
│   │   ├── LineageEngine.ts
│   │   └── EvolutionEngine.ts
│   └── types/         # TypeScript definitions
├── docker-compose.yml
├── Dockerfile
└── package.json
```

## Documentation

- [Graphiti Integration](docs/GRAPHITI-INTEGRATION.md) - Detailed graph features
- [API Reference](docs/API.md) - Full MCP tool documentation (coming soon)

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test src/mcp/__tests__/PingMemServer.test.ts

# Run with coverage
bun test --coverage
```

## Docker

### Build Image

```bash
docker build -t ping-mem:latest .
```

### Run Container

```bash
docker run -d \
  -v ping-mem-data:/data \
  -e PING_MEM_DB_PATH=/data/ping-mem.db \
  ping-mem:latest
```

### Docker Compose

```bash
# Start all services (ping-mem, Neo4j, Qdrant)
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

## License

MIT License - See [LICENSE](LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `bun test`
5. Submit a pull request

## Related Projects

- [rad-engineer-v3](https://github.com/ping-gadgets/rad-engineer-v3) - Autonomous engineering platform
- [MCP Specification](https://modelcontextprotocol.io) - Model Context Protocol
