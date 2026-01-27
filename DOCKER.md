# Docker Deployment Guide for ping-mem

This guide covers deploying ping-mem using Docker and Docker Compose.

## Prerequisites

- Docker Engine 20.10+
- Docker Compose 2.0+

## Quick Start

1. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env and update passwords/API keys
   ```

2. **Start all services:**
   ```bash
   docker-compose up -d
   ```

3. **Check service status:**
   ```bash
   docker-compose ps
   docker-compose logs -f
   ```

4. **Access services:**
   - SSE Server: http://localhost:3000
   - REST API: http://localhost:3001
   - Neo4j Browser: http://localhost:7474
   - Qdrant Console: http://localhost:6333/dashboard

## Services

| Service | Port | Description |
|---------|------|-------------|
| ping-mem-sse | 3000 | SSE transport server |
| ping-mem-rest | 3001 | REST API server |
| ping-mem-neo4j | 7474, 7687 | Neo4j knowledge graph |
| ping-mem-qdrant | 6333, 6334 | Qdrant vector database |

## Docker Commands

### Build and Start
```bash
# Build images
docker-compose build

# Start all services
docker-compose up -d

# Start specific service
docker-compose up -d ping-mem-sse
```

### Stop and Cleanup
```bash
# Stop services
docker-compose stop

# Stop and remove containers
docker-compose down

# Stop and remove containers + volumes
docker-compose down -v
```

### Logs and Monitoring
```bash
# View all logs
docker-compose logs

# Follow logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f ping-mem-sse

# Check health status
docker-compose ps
```

### Exec into Container
```bash
# Access ping-mem container
docker-compose exec ping-mem-sse sh

# Access Neo4j
docker-compose exec ping-mem-neo4j cypher-shell -u neo4j -p your_password
```

## Configuration

### Environment Variables

Key variables in `.env`:

- `PING_MEM_TRANSPORT`: `sse` (default) or `rest`
- `PING_MEM_PORT`: Server port (default: 3000)
- `NEO4J_URI`: Neo4j connection URI
- `NEO4J_PASSWORD`: Neo4j password
- `QDRANT_URL`: Qdrant connection URL

See `.env.example` for complete list.

### Transport Selection

Run SSE transport:
```bash
PING_MEM_TRANSPORT=sse docker-compose up ping-mem-sse
```

Run REST transport:
```bash
PING_MEM_TRANSPORT=rest docker-compose up ping-mem-rest
```

Both transports simultaneously:
```bash
docker-compose up ping-mem-sse ping-mem-rest
```

## Data Persistence

Data is stored in named Docker volumes:

- `ping-mem-neo4j-data`: Neo4j graph data
- `ping-mem-neo4j-logs`: Neo4j logs
- `ping-mem-qdrant-data`: Qdrant vector data
- `ping-mem-data`: ping-mem SQLite storage

Backup volumes:
```bash
docker run --rm -v ping-mem-neo4j-data:/data -v $(pwd):/backup \
  alpine tar czf /backup/neo4j-backup.tar.gz -C /data .
```

## Health Checks

All services include health checks:

```bash
# Check health status
docker-compose ps

# Manual health check
curl http://localhost:3000/health
curl http://localhost:3001/health
curl http://localhost:6333/health
```

## Troubleshooting

### Services won't start

1. Check logs: `docker-compose logs`
2. Verify ports are available: `netstat -an | grep LISTEN`
3. Check Docker resources: `docker system df`

### Connection errors

1. Verify network: `docker network ls | grep ping-mem`
2. Check service health: `docker-compose ps`
3. Test connectivity: `docker-compose exec ping-mem-sse ping ping-mem-neo4j`

### Database initialization

Neo4j and Qdrant may take 30-60 seconds to initialize. Monitor with:
```bash
docker-compose logs -f ping-mem-neo4j
docker-compose logs -f ping-mem-qdrant
```

## Production Considerations

1. **Security**: Change default passwords in `.env`
2. **Resources**: Adjust Neo4j memory settings in docker-compose.yml
3. **Backups**: Implement regular volume backups
4. **Monitoring**: Add monitoring for health checks and logs
5. **TLS**: Enable HTTPS for production deployments
6. **API Keys**: Set `PING_MEM_API_KEY` for authentication

## See Also

- [Main README](./README.md)
- [Architecture Documentation](./docs/ping-mem/ARCHITECTURE.md)
- [API Documentation](./docs/ping-mem/SPECIFICATION.md)
