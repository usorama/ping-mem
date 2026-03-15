#!/bin/bash
# ping-mem backup script
# Backs up all three data stores: SQLite, Qdrant, Neo4j
# Usage: ./backup.sh [backup-directory]
# Make executable: chmod +x backup.sh
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# --- Helpers ---
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

# --- Prerequisites ---
check_prereqs() {
  local missing=0
  for cmd in docker curl tar; do
    if ! command -v "$cmd" &>/dev/null; then
      error "Required command not found: $cmd"
      missing=1
    fi
  done
  if [[ $missing -ne 0 ]]; then
    error "Install missing prerequisites and try again."
    exit 1
  fi
}

# --- Container helpers ---
container_running() {
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true
}

# Detect the ping-mem app container
detect_app_container() {
  if container_running "ping-mem"; then
    echo "ping-mem"
  else
    echo ""
  fi
}

# --- Main ---
main() {
  local BACKUP_DIR="${1:-/tmp/ping-mem-backup-$(date +%Y%m%d-%H%M%S)}"
  local TIMESTAMP
  TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
  local ARCHIVE="${BACKUP_DIR}.tar.gz"

  echo ""
  echo -e "${CYAN}========================================${NC}"
  echo -e "${CYAN}  ping-mem Backup${NC}"
  echo -e "${CYAN}  $(date)${NC}"
  echo -e "${CYAN}========================================${NC}"
  echo ""

  check_prereqs

  # Create backup directory structure
  mkdir -p "${BACKUP_DIR}/sqlite"
  mkdir -p "${BACKUP_DIR}/qdrant"
  mkdir -p "${BACKUP_DIR}/neo4j"

  # Write metadata
  cat > "${BACKUP_DIR}/backup-metadata.json" <<METAEOF
{
  "timestamp": "${TIMESTAMP}",
  "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": "$(hostname)",
  "components": {}
}
METAEOF

  local components_ok=0
  local components_skipped=0

  # -------------------------------------------------------
  # 1. SQLite databases
  # -------------------------------------------------------
  info "Backing up SQLite databases..."
  local APP_CONTAINER
  APP_CONTAINER="$(detect_app_container)"

  if [[ -n "$APP_CONTAINER" ]]; then
    local sqlite_ok=true
    for db in ping-mem.db ping-mem-diagnostics.db ping-mem-admin.db; do
      # Check if the file exists inside the container
      if docker exec "$APP_CONTAINER" test -f "/data/${db}" 2>/dev/null; then
        if docker cp "${APP_CONTAINER}:/data/${db}" "${BACKUP_DIR}/sqlite/${db}" 2>/dev/null; then
          success "  Copied ${db}"
        else
          warn "  Failed to copy ${db}"
          sqlite_ok=false
        fi
        # Also grab WAL and SHM files if they exist (SQLite journal)
        for suffix in "-wal" "-shm"; do
          if docker exec "$APP_CONTAINER" test -f "/data/${db}${suffix}" 2>/dev/null; then
            docker cp "${APP_CONTAINER}:/data/${db}${suffix}" "${BACKUP_DIR}/sqlite/${db}${suffix}" 2>/dev/null || true
          fi
        done
      else
        warn "  ${db} not found in container (may not exist yet)"
      fi
    done
    if $sqlite_ok; then
      components_ok=$((components_ok + 1))
      success "SQLite backup complete."
    else
      components_skipped=$((components_skipped + 1))
      warn "SQLite backup completed with warnings."
    fi
  else
    # Fallback: try copying from Docker volume directly
    warn "No ping-mem app container running. Attempting direct volume copy..."
    local vol_mount
    vol_mount="$(docker volume inspect ping-mem-data --format '{{.Mountpoint}}' 2>/dev/null || true)"
    if [[ -n "$vol_mount" ]]; then
      # Use a temporary container to access the volume
      for db in ping-mem.db ping-mem-diagnostics.db ping-mem-admin.db; do
        if docker run --rm -v ping-mem-data:/data alpine test -f "/data/${db}" 2>/dev/null; then
          docker run --rm -v ping-mem-data:/data -v "${BACKUP_DIR}/sqlite":/backup alpine cp "/data/${db}" "/backup/${db}" 2>/dev/null && \
            success "  Copied ${db} (via volume)" || warn "  Failed to copy ${db}"
          # WAL/SHM files
          for suffix in "-wal" "-shm"; do
            docker run --rm -v ping-mem-data:/data -v "${BACKUP_DIR}/sqlite":/backup alpine cp "/data/${db}${suffix}" "/backup/${db}${suffix}" 2>/dev/null || true
          done
        else
          warn "  ${db} not found in volume"
        fi
      done
      components_ok=$((components_ok + 1))
      success "SQLite backup complete (via volume)."
    else
      components_skipped=$((components_skipped + 1))
      warn "SQLite backup skipped: no running container and volume not found."
    fi
  fi

  # -------------------------------------------------------
  # 2. Qdrant snapshots
  # -------------------------------------------------------
  info "Backing up Qdrant vectors..."
  if container_running "ping-mem-qdrant"; then
    # Check if Qdrant is responsive
    if curl -sf "http://localhost:6333/healthz" >/dev/null 2>&1 || curl -sf "http://localhost:6333/" >/dev/null 2>&1; then
      # Check if collection exists
      local collection_check
      collection_check="$(curl -sf "http://localhost:6333/collections/ping-mem-vectors" 2>/dev/null || echo "")"
      if [[ -n "$collection_check" ]] && echo "$collection_check" | grep -q '"status":"ok"'; then
        # Create snapshot
        info "  Creating Qdrant snapshot..."
        local snapshot_response
        snapshot_response="$(curl -sf -X POST "http://localhost:6333/collections/ping-mem-vectors/snapshots" 2>/dev/null || echo "")"
        if [[ -n "$snapshot_response" ]]; then
          # Extract snapshot name from response
          local snapshot_name
          snapshot_name="$(echo "$snapshot_response" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)"
          if [[ -n "$snapshot_name" ]]; then
            info "  Downloading snapshot: ${snapshot_name}..."
            # Download the snapshot file
            if curl -sf "http://localhost:6333/collections/ping-mem-vectors/snapshots/${snapshot_name}" \
                -o "${BACKUP_DIR}/qdrant/${snapshot_name}" 2>/dev/null; then
              # Save the snapshot name for restore
              echo "$snapshot_name" > "${BACKUP_DIR}/qdrant/snapshot-name.txt"
              components_ok=$((components_ok + 1))
              success "Qdrant backup complete: ${snapshot_name}"
            else
              components_skipped=$((components_skipped + 1))
              warn "Qdrant snapshot download failed."
            fi
          else
            components_skipped=$((components_skipped + 1))
            warn "Could not extract snapshot name from response: ${snapshot_response}"
          fi
        else
          components_skipped=$((components_skipped + 1))
          warn "Qdrant snapshot creation returned empty response."
        fi
      else
        components_skipped=$((components_skipped + 1))
        warn "Qdrant collection 'ping-mem-vectors' not found. Skipping."
      fi
    else
      components_skipped=$((components_skipped + 1))
      warn "Qdrant is not responding on port 6333. Skipping."
    fi
  else
    components_skipped=$((components_skipped + 1))
    warn "Qdrant container (ping-mem-qdrant) not running. Skipping."
  fi

  # -------------------------------------------------------
  # 3. Neo4j database dump
  # -------------------------------------------------------
  info "Backing up Neo4j graph database..."
  if container_running "ping-mem-neo4j"; then
    # Neo4j 5.x community: use neo4j-admin database dump
    # The database must be stopped for dump, or we use --expand-commands
    # For community edition, we dump the 'neo4j' database
    info "  Running neo4j-admin database dump..."

    # First stop the database to ensure consistent dump
    # Using cypher to stop is not available in community, so we use dump with backup approach
    if docker exec ping-mem-neo4j neo4j-admin database dump \
        --to-path=/tmp/ neo4j 2>/dev/null; then
      # Copy the dump file out
      if docker cp "ping-mem-neo4j:/tmp/neo4j.dump" "${BACKUP_DIR}/neo4j/neo4j.dump" 2>/dev/null; then
        # Clean up inside container
        docker exec ping-mem-neo4j rm -f /tmp/neo4j.dump 2>/dev/null || true
        components_ok=$((components_ok + 1))
        success "Neo4j backup complete."
      else
        components_skipped=$((components_skipped + 1))
        warn "Failed to copy Neo4j dump from container."
      fi
    else
      # Dump may fail if database is running (community edition limitation)
      # Try alternative: export via cypher-shell
      warn "  neo4j-admin dump failed (database may be running)."
      info "  Attempting Cypher export as fallback..."
      local cypher_export
      cypher_export="$(docker exec ping-mem-neo4j cypher-shell \
        -u neo4j -p neo4j_password \
        --format plain \
        "CALL apoc.export.cypher.all(null, {stream: true}) YIELD cypherStatements RETURN cypherStatements" \
        2>/dev/null || echo "")"
      if [[ -n "$cypher_export" ]]; then
        echo "$cypher_export" > "${BACKUP_DIR}/neo4j/neo4j-export.cypher"
        components_ok=$((components_ok + 1))
        success "Neo4j backup complete (Cypher export)."
      else
        # Final fallback: dump all nodes and relationships as JSON
        info "  Attempting JSON node/rel export as final fallback..."
        local nodes_json rels_json
        nodes_json="$(docker exec ping-mem-neo4j cypher-shell \
          -u neo4j -p neo4j_password \
          --format plain \
          "MATCH (n) RETURN collect(properties(n)) AS nodes" 2>/dev/null || echo "")"
        rels_json="$(docker exec ping-mem-neo4j cypher-shell \
          -u neo4j -p neo4j_password \
          --format plain \
          "MATCH ()-[r]->() RETURN collect({type: type(r), props: properties(r)}) AS rels" 2>/dev/null || echo "")"
        if [[ -n "$nodes_json" || -n "$rels_json" ]]; then
          echo "$nodes_json" > "${BACKUP_DIR}/neo4j/nodes.json"
          echo "$rels_json" > "${BACKUP_DIR}/neo4j/rels.json"
          components_ok=$((components_ok + 1))
          warn "Neo4j backup: JSON export only (no binary dump). Restore will be limited."
        else
          components_skipped=$((components_skipped + 1))
          warn "Neo4j backup failed: all export methods unsuccessful."
        fi
      fi
    fi
  else
    components_skipped=$((components_skipped + 1))
    warn "Neo4j container (ping-mem-neo4j) not running. Skipping."
  fi

  # -------------------------------------------------------
  # Create compressed archive
  # -------------------------------------------------------
  info "Compressing backup..."
  # If BACKUP_DIR is an absolute path, we need to handle tar correctly
  local backup_parent backup_name
  backup_parent="$(dirname "$BACKUP_DIR")"
  backup_name="$(basename "$BACKUP_DIR")"
  tar -czf "${ARCHIVE}" -C "${backup_parent}" "${backup_name}"

  # Remove uncompressed directory
  rm -rf "${BACKUP_DIR}"

  # -------------------------------------------------------
  # Summary
  # -------------------------------------------------------
  local archive_size
  archive_size="$(du -h "${ARCHIVE}" | cut -f1)"

  echo ""
  echo -e "${CYAN}========================================${NC}"
  echo -e "${CYAN}  Backup Summary${NC}"
  echo -e "${CYAN}========================================${NC}"
  echo ""
  success "Archive:    ${ARCHIVE}"
  success "Size:       ${archive_size}"
  success "Components: ${components_ok} backed up, ${components_skipped} skipped"
  echo ""

  if [[ $components_ok -eq 0 ]]; then
    error "No components were backed up. Check that containers are running."
    rm -f "${ARCHIVE}"
    exit 1
  fi

  if [[ $components_skipped -gt 0 ]]; then
    warn "Some components were skipped. Check warnings above."
  fi

  success "Backup complete."
}

main "$@"
