#!/usr/bin/env bash
#
# ping-mem Client Installer
#
# Installs ping-mem client tools for a specific project or IDE.
# Detects IDE/CLI environment and configures appropriately.
#
# Usage:
#   ./scripts/install-client.sh [PROJECT_DIR]
#   ./scripts/install-client.sh --global  # Install for all projects
#
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Determine target directory
if [[ "${1:-}" == "--global" ]]; then
  TARGET_DIR="$HOME"
  SCOPE="global"
else
  TARGET_DIR="${1:-$(pwd)}"
  SCOPE="project"
fi

PING_MEM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_KEY="${PING_MEM_API_KEY:-}"

AUTH_HEADER=()
if [[ -n "$API_KEY" ]]; then
  AUTH_HEADER=("-H" "X-API-Key: $API_KEY")
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}ping-mem Client Installer${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Target: $TARGET_DIR"
echo "Scope: $SCOPE"
echo ""

# ============================================================================
# Step 1: Verify ping-mem is Running
# ============================================================================

echo -e "${YELLOW}[1/5] Verifying ping-mem service...${NC}"

if curl -sf "${AUTH_HEADER[@]}" http://localhost:3000/health > /dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} ping-mem service is running"
else
  echo -e "  ${RED}✗${NC} ping-mem service not responding"
  echo ""
  echo "Start ping-mem first:"
  echo "  cd $PING_MEM_ROOT"
  echo "  ./scripts/setup.sh"
  exit 1
fi

echo ""

# ============================================================================
# Step 2: Detect IDE/CLI Environment + Ask User to Choose
# ============================================================================

echo -e "${YELLOW}[2/5] Detecting IDE/CLI environment...${NC}"

DETECTED_IDES=()

# Check for Cursor
if [[ -d "$TARGET_DIR/.cursor" ]] || command -v cursor &> /dev/null; then
  DETECTED_IDES+=("cursor")
  echo -e "  ${GREEN}✓${NC} Cursor IDE detected"
fi

# Check for VS Code
if [[ -d "$TARGET_DIR/.vscode" ]] || command -v code &> /dev/null; then
  DETECTED_IDES+=("vscode")
  echo -e "  ${GREEN}✓${NC} VS Code detected"
fi

# Check for Claude Code
if [[ -f "$HOME/.claude/mcp.json" ]]; then
  DETECTED_IDES+=("claude")
  echo -e "  ${GREEN}✓${NC} Claude Code detected"
fi

# Check for Cline (VS Code extension)
if [[ -d "$HOME/.vscode/extensions" ]] && ls "$HOME/.vscode/extensions" | grep -q "cline"; then
  DETECTED_IDES+=("cline")
  echo -e "  ${GREEN}✓${NC} Cline extension detected"
fi

if [[ ${#DETECTED_IDES[@]} -eq 0 ]]; then
  echo -e "  ${YELLOW}⚠${NC} No known IDE detected"
fi

echo ""
echo -e "${YELLOW}Select environments to configure:${NC}"
echo "  1) Cursor"
echo "  2) VS Code"
echo "  3) Claude Code (global installs only)"
echo "  4) Cline"
echo "  5) Generic (basic config only)"
echo "  A) All detected"

SELECTED_IDES=()
while true; do
  read -r -p "Enter choices (comma/space separated, or A): " IDE_CHOICES
  IDE_CHOICES="$(echo "$IDE_CHOICES" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$IDE_CHOICES" ]]; then
    echo -e "  ${YELLOW}⚠${NC} Please select at least one option."
    continue
  fi

  if [[ "$IDE_CHOICES" == "a" || "$IDE_CHOICES" == "all" ]]; then
    if [[ ${#DETECTED_IDES[@]} -eq 0 ]]; then
      SELECTED_IDES=("generic")
    else
      SELECTED_IDES=("${DETECTED_IDES[@]}")
    fi
    break
  fi

  INVALID_CHOICE=false
  SELECTED_IDES=()
  IDE_CHOICES="${IDE_CHOICES//,/ }"
  for choice in $IDE_CHOICES; do
    case "$choice" in
      1) SELECTED_IDES+=("cursor") ;;
      2) SELECTED_IDES+=("vscode") ;;
      3) SELECTED_IDES+=("claude") ;;
      4) SELECTED_IDES+=("cline") ;;
      5) SELECTED_IDES+=("generic") ;;
      *) INVALID_CHOICE=true ;;
    esac
  done

  if [[ "$INVALID_CHOICE" == true ]] || [[ ${#SELECTED_IDES[@]} -eq 0 ]]; then
    echo -e "  ${YELLOW}⚠${NC} Invalid selection. Try again."
    continue
  fi

  # De-duplicate selections
  UNIQUE_IDES=()
  for env in "${SELECTED_IDES[@]}"; do
    if [[ " ${UNIQUE_IDES[*]} " != *" $env "* ]]; then
      UNIQUE_IDES+=("$env")
    fi
  done
  SELECTED_IDES=("${UNIQUE_IDES[@]}")
  break
done

echo ""
echo "Selected: ${SELECTED_IDES[*]}"
echo ""

# ============================================================================
# Step 3: Install MCP Configuration
# ============================================================================

echo -e "${YELLOW}[3/5] Installing MCP configuration...${NC}"

# Cursor MCP config
if [[ " ${SELECTED_IDES[*]} " =~ " cursor " ]]; then
  mkdir -p "$TARGET_DIR/.cursor"
  cat > "$TARGET_DIR/.cursor/mcp.json" <<EOF
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "$PING_MEM_ROOT/dist/mcp/cli.js"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "neo4j_password",
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_COLLECTION_NAME": "ping-mem-vectors",
        "PING_MEM_DB_PATH": "$HOME/.ping-mem/shared.db"
      }
    }
  }
}
EOF
  echo -e "  ${GREEN}✓${NC} Created .cursor/mcp.json"
fi

# Claude Code MCP config (global only)
if [[ " ${SELECTED_IDES[*]} " =~ " claude " ]] && [[ "$SCOPE" == "global" ]]; then
  mkdir -p "$HOME/.claude"
  
  # Merge with existing config if present
  if [[ -f "$HOME/.claude/mcp.json" ]]; then
    echo -e "  ${YELLOW}⚠${NC} ~/.claude/mcp.json exists, manual merge required"
    echo "  Add this to your mcpServers:"
    cat <<EOF
    "ping-mem": {
      "command": "bun",
      "args": ["run", "$PING_MEM_ROOT/dist/mcp/cli.js"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "neo4j_password",
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_COLLECTION_NAME": "ping-mem-vectors"
      }
    }
EOF
  else
    cat > "$HOME/.claude/mcp.json" <<EOF
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "$PING_MEM_ROOT/dist/mcp/cli.js"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "neo4j_password",
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_COLLECTION_NAME": "ping-mem-vectors"
      }
    }
  }
}
EOF
    echo -e "  ${GREEN}✓${NC} Created ~/.claude/mcp.json"
  fi
elif [[ " ${SELECTED_IDES[*]} " =~ " claude " ]]; then
  echo -e "  ${YELLOW}⚠${NC} Claude Code config is global-only; skipping for project install"
fi

if [[ " ${SELECTED_IDES[*]} " =~ " vscode " ]]; then
  echo -e "  ${GREEN}✓${NC} VS Code selected (no MCP config required)"
fi

if [[ " ${SELECTED_IDES[*]} " =~ " cline " ]]; then
  echo -e "  ${GREEN}✓${NC} Cline selected (no MCP config required)"
fi

if [[ " ${SELECTED_IDES[*]} " =~ " generic " ]]; then
  echo -e "  ${GREEN}✓${NC} Generic selected (basic config only)"
fi

# Copy .cursorrules for IDE agent instructions
if [[ "$SCOPE" == "project" ]]; then
  cp "$PING_MEM_ROOT/.cursorrules" "$TARGET_DIR/.cursorrules"
  echo -e "  ${GREEN}✓${NC} Copied .cursorrules"
fi

echo ""

# ============================================================================
# Step 4: Create Project-Specific Directory
# ============================================================================

if [[ "$SCOPE" == "project" ]]; then
  echo -e "${YELLOW}[4/5] Creating project-specific directory...${NC}"
  
  mkdir -p "$TARGET_DIR/.ping-mem"
  echo -e "  ${GREEN}✓${NC} Created .ping-mem/ directory"
  
  # Create project config
  cat > "$TARGET_DIR/.ping-mem/config.json" <<EOF
{
  "projectDir": "$TARGET_DIR",
  "pingMemUrl": "http://localhost:3000",
  "autoIngest": false,
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
  echo -e "  ${GREEN}✓${NC} Created .ping-mem/config.json"
  
  echo ""
else
  echo -e "${YELLOW}[4/5] Skipping project directory (global install)${NC}"
  echo ""
fi

# ============================================================================
# Step 5: Optional Ingestion
# ============================================================================

if [[ "$SCOPE" == "project" ]]; then
  echo -e "${YELLOW}[5/5] Project ingestion...${NC}"
  echo "Running ingestion..."
  "$PING_MEM_ROOT/scripts/ingest-project.sh" "$TARGET_DIR"
else
  echo -e "${YELLOW}[5/5] Skipping ingestion (global install)${NC}"
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Client installation complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Restart your IDE to load MCP configuration"
echo ""
echo "  2. Verify connection:"
echo "     - In Cursor: Check MCP tools are available"
echo "     - In Claude Code: Run a ping-mem tool"
echo ""
echo "  3. Ingest your project (if not done):"
echo "     $PING_MEM_ROOT/scripts/ingest-project.sh \"$TARGET_DIR\""
echo ""
echo "  4. Start using ping-mem tools instead of grep!"
echo ""
