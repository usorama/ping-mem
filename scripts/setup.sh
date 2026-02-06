#!/usr/bin/env bash
#
# ping-mem Setup Script
#
# One-script installation for ping-mem Universal Memory Layer.
# Validates prerequisites, configures environment, builds, and starts services.
#
# Usage: ./scripts/setup.sh [--docker-only] [--skip-docker]
#
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
DOCKER_ONLY=false
SKIP_DOCKER=false

for arg in "$@"; do
  case $arg in
    --docker-only)
      DOCKER_ONLY=true
      shift
      ;;
    --skip-docker)
      SKIP_DOCKER=true
      shift
      ;;
  esac
done

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}ping-mem Setup Script${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# ============================================================================
# Step 1: Validate Prerequisites
# ============================================================================

echo -e "${YELLOW}[1/6] Validating prerequisites...${NC}"

# Check Bun
if ! command -v bun &> /dev/null; then
  echo -e "${RED}ERROR: bun is required but not installed.${NC}"
  echo "Install bun: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
BUN_VERSION=$(bun --version)
echo -e "  ${GREEN}✓${NC} bun $BUN_VERSION"

# Check Docker
if ! command -v docker &> /dev/null; then
  echo -e "${RED}ERROR: docker is required but not installed.${NC}"
  echo "Install Docker Desktop or OrbStack"
  exit 1
fi
DOCKER_VERSION=$(docker --version | cut -d ' ' -f3 | tr -d ',')
echo -e "  ${GREEN}✓${NC} Docker $DOCKER_VERSION"

# Check Docker Compose
if ! docker compose version &> /dev/null; then
  echo -e "${RED}ERROR: docker compose is required but not available.${NC}"
  echo "Ensure Docker Desktop or docker-compose-plugin is installed"
  exit 1
fi
COMPOSE_VERSION=$(docker compose version --short)
echo -e "  ${GREEN}✓${NC} Docker Compose $COMPOSE_VERSION"

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
  echo -e "${RED}ERROR: Docker daemon is not running.${NC}"
  echo "Start Docker Desktop or OrbStack"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Docker daemon running"

echo ""

# ============================================================================
# Step 2: Configure Environment
# ============================================================================

echo -e "${YELLOW}[2/6] Configuring environment...${NC}"

cd "$PROJECT_DIR"

if [ -f .env ]; then
  echo -e "  ${GREEN}✓${NC} .env already exists"
else
  if [ -f .env.example ]; then
    cp .env.example .env
    echo -e "  ${GREEN}✓${NC} Created .env from .env.example"
    echo -e "  ${YELLOW}⚠${NC} Review .env and update passwords/API keys as needed"
  else
    echo -e "  ${YELLOW}⚠${NC} No .env.example found, skipping .env creation"
  fi
fi

echo ""

API_KEY="${PING_MEM_API_KEY:-}"
AUTH_HEADER=()
if [[ -n "$API_KEY" ]]; then
  AUTH_HEADER=("-H" "X-API-Key: $API_KEY")
fi

# ============================================================================
# Step 3: Install Dependencies
# ============================================================================

if [ "$DOCKER_ONLY" = false ]; then
  echo -e "${YELLOW}[3/6] Installing dependencies...${NC}"
  
  bun install
  echo -e "  ${GREEN}✓${NC} Dependencies installed"
  echo ""

  # ============================================================================
  # Step 4: Build TypeScript
  # ============================================================================

  echo -e "${YELLOW}[4/6] Building TypeScript...${NC}"
  
  bun run build
  echo -e "  ${GREEN}✓${NC} Build completed"
  echo ""
else
  echo -e "${YELLOW}[3/6] Skipping dependency install (--docker-only)${NC}"
  echo ""
  echo -e "${YELLOW}[4/6] Skipping build (--docker-only)${NC}"
  echo ""
fi

# ============================================================================
# Step 5: Start Docker Services
# ============================================================================

if [ "$SKIP_DOCKER" = false ]; then
  echo -e "${YELLOW}[5/6] Starting Docker services...${NC}"
  
  docker compose up -d
  echo -e "  ${GREEN}✓${NC} Docker services started"
  echo ""

  # ============================================================================
  # Step 6: Health Checks
  # ============================================================================

  echo -e "${YELLOW}[6/6] Running health checks...${NC}"
  
  echo "  Waiting for services to initialize (15s)..."
  sleep 15

  # Check Qdrant
  if curl -sf http://localhost:6333/health > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Qdrant: healthy (http://localhost:6333)"
  else
    echo -e "  ${RED}✗${NC} Qdrant: not responding"
  fi

  # Check Neo4j
  if curl -sf http://localhost:7474 > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Neo4j: healthy (http://localhost:7474)"
  else
    echo -e "  ${RED}✗${NC} Neo4j: not responding (may still be initializing)"
  fi

  # Check ping-mem
  if curl -sf "${AUTH_HEADER[@]}" http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} ping-mem: healthy (http://localhost:3000)"
  else
    echo -e "  ${YELLOW}⚠${NC} ping-mem: not responding yet (check: docker compose logs ping-mem)"
  fi
else
  echo -e "${YELLOW}[5/6] Skipping Docker start (--skip-docker)${NC}"
  echo ""
  echo -e "${YELLOW}[6/6] Skipping health checks (--skip-docker)${NC}"
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Setup complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Review and update .env with your configuration"
echo ""
echo "  2. Start MCP server (for Claude Code):"
echo "     bun run dist/mcp/cli.js"
echo ""
echo "  3. Or use HTTP API:"
echo "     curl http://localhost:3000/health"
echo ""
echo "  4. Configure your AI agent (see AGENT_INSTRUCTIONS.md)"
echo ""
echo "Service endpoints:"
echo "  - ping-mem (SSE):  http://localhost:3000"
echo "  - Neo4j Browser:   http://localhost:7474"
echo "  - Qdrant Console:  http://localhost:6333/dashboard"
echo ""
