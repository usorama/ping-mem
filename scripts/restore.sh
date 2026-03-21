#!/bin/bash
# ping-mem restore script
# Restores all three data stores from a backup archive: SQLite, Qdrant, Neo4j
# Usage: ./restore.sh <path-to-backup.tar.gz>
# Make executable: chmod +x restore.sh
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

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

# Detect the docker-compose file to use
detect_compose_file() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local project_dir
  project_dir="$(dirname "$script_dir")"

  if [[ -f "${project_dir}/docker-compose.prod.yml" ]] && \
     docker compose -f "${project_dir}/docker-compose.prod.yml" config >/dev/null 2>&1; then
    # Check if prod containers are the ones in use
    if container_exists "ping-mem" && \
       docker inspect ping-mem 2>/dev/null | grep -q "docker-compose.prod.yml"; then
      echo "${project_dir}/docker-compose.prod.yml"
      return
    fi
  fi

  if [[ -f "${project_dir}/docker-compose.yml" ]]; then
    echo "${project_dir}/docker-compose.yml"
  else
    echo ""
  fi
}

# Detect which ping-mem app container name to use
detect_app_container() {
  if container_exists "ping-mem"; then
    echo "ping-mem"
  else
    echo "ping-mem"
  fi
}

# --- Main ---
main() {
  if [[ $# -lt 1 ]]; then
    error "Usage: $0 <path-to-backup.tar.gz>"
    exit 1
  fi

  local ARCHIVE="$1"

  echo ""
  echo -e "${CYAN}========================================${NC}"
  echo -e "${CYAN}  ping-mem Restore${NC}"
  echo -e "${CYAN}  $(date)${NC}"
  echo -e "${CYAN}========================================${NC}"
  echo ""

  check_prereqs

  # -------------------------------------------------------
  # Validate backup archive
  # -------------------------------------------------------
  if [[ ! -f "$ARCHIVE" ]]; then
    error "Backup file not found: ${ARCHIVE}"
    exit 1
  fi

  if [[ ! "$ARCHIVE" == *.tar.gz ]] && [[ ! "$ARCHIVE" == *.tgz ]]; then
    error "Expected a .tar.gz or .tgz archive, got: ${ARCHIVE}"
    exit 1
  fi

  info "Validating backup archive..."

  # List contents and verify expected structure
  local archive_contents
  archive_contents="$(tar -tzf "$ARCHIVE" 2>/dev/null || true)"
  if [[ -z "$archive_contents" ]]; then
    error "Cannot read archive or archive is empty: ${ARCHIVE}"
    exit 1
  fi

  # Check for expected directories
  local has_sqlite=false has_qdrant=false has_neo4j=false
  if echo "$archive_contents" | grep -q "sqlite/"; then
    has_sqlite=true
  fi
  if echo "$archive_contents" | grep -q "qdrant/"; then
    has_qdrant=true
  fi
  if echo "$archive_contents" | grep -q "neo4j/"; then
    has_neo4j=true
  fi

  if ! $has_sqlite && ! $has_qdrant && ! $has_neo4j; then
    error "Archive does not contain expected backup structure (sqlite/, qdrant/, neo4j/ directories)."
    error "Contents:"
    echo "$archive_contents" | head -20
    exit 1
  fi

  info "Archive contains:"
  $has_sqlite && info "  - SQLite databases"
  $has_qdrant && info "  - Qdrant snapshots"
  $has_neo4j  && info "  - Neo4j database dump"

  # -------------------------------------------------------
  # User confirmation
  # -------------------------------------------------------
  echo ""
  echo -e "${RED}========================================${NC}"
  echo -e "${RED}  WARNING: DESTRUCTIVE OPERATION${NC}"
  echo -e "${RED}========================================${NC}"
  echo ""
  echo -e "${YELLOW}This will OVERWRITE all existing ping-mem data:${NC}"
  $has_sqlite && echo -e "${YELLOW}  - All SQLite databases (memory, diagnostics, admin)${NC}"
  $has_qdrant && echo -e "${YELLOW}  - All Qdrant vector embeddings${NC}"
  $has_neo4j  && echo -e "${YELLOW}  - All Neo4j graph data${NC}"
  echo ""
  echo -e "${YELLOW}Containers will be stopped during restore.${NC}"
  echo ""

  read -rp "Are you sure you want to continue? Type 'yes' to confirm: " confirmation
  if [[ "$confirmation" != "yes" ]]; then
    info "Restore cancelled."
    exit 0
  fi
  echo ""

  # -------------------------------------------------------
  # Extract backup
  # -------------------------------------------------------
  local TEMP_DIR
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT

  info "Extracting backup archive..."
  tar -xzf "$ARCHIVE" -C "$TEMP_DIR"

  # Find the extracted directory (could be nested one level)
  local BACKUP_DIR
  BACKUP_DIR="$(find "$TEMP_DIR" -maxdepth 1 -mindepth 1 -type d | head -1)"
  if [[ -z "$BACKUP_DIR" ]]; then
    BACKUP_DIR="$TEMP_DIR"
  fi

  success "Extracted to temporary directory."

  # -------------------------------------------------------
  # Detect compose file and container names
  # -------------------------------------------------------
  local COMPOSE_FILE
  COMPOSE_FILE="$(detect_compose_file)"
  local APP_CONTAINER
  APP_CONTAINER="$(detect_app_container)"
  local COMPOSE_PROJECT_DIR
  COMPOSE_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  # -------------------------------------------------------
  # Stop ping-mem containers
  # -------------------------------------------------------
  info "Stopping ping-mem containers..."
  if [[ -n "$COMPOSE_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" --project-directory "$COMPOSE_PROJECT_DIR" stop 2>/dev/null || true
  else
    # Stop containers individually
    for c in ping-mem ping-mem-neo4j ping-mem-qdrant; do
      if container_exists "$c"; then
        docker stop "$c" 2>/dev/null || true
      fi
    done
  fi

  # Give containers time to shutdown cleanly
  sleep 2
  success "Containers stopped."

  local components_ok=0
  local components_skipped=0

  # -------------------------------------------------------
  # 1. Restore SQLite databases
  # -------------------------------------------------------
  if $has_sqlite && [[ -d "${BACKUP_DIR}/sqlite" ]]; then
    info "Restoring SQLite databases..."
    local sqlite_restored=false
    for db in ping-mem.db ping-mem-diagnostics.db ping-mem-admin.db; do
      if [[ -f "${BACKUP_DIR}/sqlite/${db}" ]]; then
        # Copy into the Docker volume using a temporary alpine container
        if docker run --rm \
            -v ping-mem-data:/data \
            -v "${BACKUP_DIR}/sqlite":/backup:ro \
            alpine sh -c "cp /backup/${db} /data/${db}" 2>/dev/null; then
          success "  Restored ${db}"
          sqlite_restored=true
          # Also restore WAL/SHM if present
          for suffix in "-wal" "-shm"; do
            if [[ -f "${BACKUP_DIR}/sqlite/${db}${suffix}" ]]; then
              docker run --rm \
                -v ping-mem-data:/data \
                -v "${BACKUP_DIR}/sqlite":/backup:ro \
                alpine sh -c "cp /backup/${db}${suffix} /data/${db}${suffix}" 2>/dev/null || true
            else
              # Remove stale WAL/SHM from volume to avoid corruption
              docker run --rm \
                -v ping-mem-data:/data \
                alpine sh -c "rm -f /data/${db}${suffix}" 2>/dev/null || true
            fi
          done
        else
          warn "  Failed to restore ${db}"
        fi
      else
        warn "  ${db} not found in backup"
      fi
    done
    if $sqlite_restored; then
      components_ok=$((components_ok + 1))
      success "SQLite restore complete."
    else
      components_skipped=$((components_skipped + 1))
      warn "SQLite restore: no databases were restored."
    fi
  else
    if $has_sqlite; then
      warn "SQLite backup directory not found in extracted archive."
    fi
  fi

  # -------------------------------------------------------
  # 2. Restore Qdrant
  # -------------------------------------------------------
  if $has_qdrant && [[ -d "${BACKUP_DIR}/qdrant" ]]; then
    info "Restoring Qdrant vectors..."

    # Start only Qdrant container for restore
    info "  Starting Qdrant container..."
    if container_exists "ping-mem-qdrant"; then
      docker start ping-mem-qdrant 2>/dev/null || true
    elif [[ -n "$COMPOSE_FILE" ]]; then
      docker compose -f "$COMPOSE_FILE" --project-directory "$COMPOSE_PROJECT_DIR" start ping-mem-qdrant 2>/dev/null || true
    fi

    # Wait for Qdrant to be ready
    local qdrant_ready=false
    for i in $(seq 1 30); do
      if curl -sf "http://localhost:6333/" >/dev/null 2>&1 || \
         curl -sf "http://localhost:6333/healthz" >/dev/null 2>&1; then
        qdrant_ready=true
        break
      fi
      sleep 1
    done

    if $qdrant_ready; then
      # Find snapshot file
      local snapshot_file
      snapshot_file="$(find "${BACKUP_DIR}/qdrant" -name "*.snapshot" -o -name "*.snap" | head -1)"
      if [[ -z "$snapshot_file" ]]; then
        # Try any non-txt file in qdrant directory
        snapshot_file="$(find "${BACKUP_DIR}/qdrant" -type f ! -name "*.txt" | head -1)"
      fi

      if [[ -n "$snapshot_file" ]] && [[ -f "$snapshot_file" ]]; then
        info "  Uploading snapshot: $(basename "$snapshot_file")..."

        # Delete existing collection first (if it exists) to allow clean restore
        curl -sf -X DELETE "http://localhost:6333/collections/ping-mem-vectors" >/dev/null 2>&1 || true
        sleep 1

        # Restore from snapshot using the recovery endpoint
        # Upload the snapshot file
        local restore_response
        restore_response="$(curl -sf -X POST \
          "http://localhost:6333/collections/ping-mem-vectors/snapshots/upload?priority=snapshot" \
          -H "Content-Type: multipart/form-data" \
          -F "snapshot=@${snapshot_file}" 2>/dev/null || echo "")"

        if [[ -n "$restore_response" ]] && echo "$restore_response" | grep -q '"status"'; then
          if echo "$restore_response" | grep -q '"status":"ok"'; then
            components_ok=$((components_ok + 1))
            success "Qdrant restore complete."
          else
            # Try alternative: PUT recover from local path
            warn "  Upload restore returned unexpected status. Trying file-based recovery..."
            # Copy snapshot into the Qdrant container
            local snap_name
            snap_name="$(basename "$snapshot_file")"
            docker cp "$snapshot_file" "ping-mem-qdrant:/qdrant/storage/snapshots/${snap_name}" 2>/dev/null || true

            local recover_response
            recover_response="$(curl -sf -X PUT \
              "http://localhost:6333/collections/ping-mem-vectors/snapshots/recover" \
              -H "Content-Type: application/json" \
              -d "{\"location\": \"/qdrant/storage/snapshots/${snap_name}\", \"priority\": \"snapshot\"}" 2>/dev/null || echo "")"

            if [[ -n "$recover_response" ]] && echo "$recover_response" | grep -q '"ok"'; then
              components_ok=$((components_ok + 1))
              success "Qdrant restore complete (file-based recovery)."
            else
              components_skipped=$((components_skipped + 1))
              warn "Qdrant restore failed. Response: ${recover_response}"
            fi
          fi
        else
          components_skipped=$((components_skipped + 1))
          warn "Qdrant snapshot upload failed. Response: ${restore_response}"
        fi
      else
        components_skipped=$((components_skipped + 1))
        warn "No Qdrant snapshot file found in backup."
      fi
    else
      components_skipped=$((components_skipped + 1))
      warn "Qdrant did not become ready after 30 seconds. Skipping restore."
    fi

    # Stop Qdrant again (will be restarted with everything else)
    docker stop ping-mem-qdrant 2>/dev/null || true
  fi

  # -------------------------------------------------------
  # 3. Restore Neo4j
  # -------------------------------------------------------
  if $has_neo4j && [[ -d "${BACKUP_DIR}/neo4j" ]]; then
    info "Restoring Neo4j graph database..."

    if [[ -f "${BACKUP_DIR}/neo4j/neo4j.dump" ]]; then
      # Binary dump restore using neo4j-admin
      info "  Loading Neo4j binary dump..."

      # Ensure Neo4j container exists but is stopped
      if container_exists "ping-mem-neo4j"; then
        docker stop ping-mem-neo4j 2>/dev/null || true
        sleep 2
      fi

      # Copy dump file into the container
      # Start container briefly to copy, then stop
      docker start ping-mem-neo4j 2>/dev/null || true
      sleep 3
      docker cp "${BACKUP_DIR}/neo4j/neo4j.dump" "ping-mem-neo4j:/tmp/neo4j.dump" 2>/dev/null
      docker stop ping-mem-neo4j 2>/dev/null || true
      sleep 2

      # Load the dump (database must be stopped)
      # Neo4j 5.x: neo4j-admin database load --from-path=/tmp/ --overwrite-destination=true neo4j
      if docker start ping-mem-neo4j 2>/dev/null && sleep 3 && \
         docker exec ping-mem-neo4j bash -c "neo4j stop 2>/dev/null; sleep 2; neo4j-admin database load --from-path=/tmp/ --overwrite-destination=true neo4j" 2>/dev/null; then
        docker exec ping-mem-neo4j rm -f /tmp/neo4j.dump 2>/dev/null || true
        docker stop ping-mem-neo4j 2>/dev/null || true
        components_ok=$((components_ok + 1))
        success "Neo4j restore complete (binary dump)."
      else
        # Fallback: try older syntax
        warn "  Neo4j 5.x load failed, trying alternative syntax..."
        if docker exec ping-mem-neo4j bash -c "neo4j stop 2>/dev/null; sleep 2; neo4j-admin load --from=/tmp/neo4j.dump --force" 2>/dev/null; then
          docker exec ping-mem-neo4j rm -f /tmp/neo4j.dump 2>/dev/null || true
          docker stop ping-mem-neo4j 2>/dev/null || true
          components_ok=$((components_ok + 1))
          success "Neo4j restore complete (binary dump, legacy syntax)."
        else
          docker stop ping-mem-neo4j 2>/dev/null || true
          components_skipped=$((components_skipped + 1))
          warn "Neo4j binary restore failed."
        fi
      fi
    elif [[ -f "${BACKUP_DIR}/neo4j/neo4j-export.cypher" ]]; then
      # Cypher export restore
      info "  Restoring from Cypher export..."

      # Start Neo4j for cypher import
      if container_exists "ping-mem-neo4j"; then
        docker start ping-mem-neo4j 2>/dev/null || true
      elif [[ -n "$COMPOSE_FILE" ]]; then
        docker compose -f "$COMPOSE_FILE" --project-directory "$COMPOSE_PROJECT_DIR" start ping-mem-neo4j 2>/dev/null || true
      fi

      # Wait for Neo4j to be ready
      local neo4j_ready=false
      for i in $(seq 1 60); do
        if docker exec ping-mem-neo4j cypher-shell -u neo4j -p neo4j_password "RETURN 1" >/dev/null 2>&1; then
          neo4j_ready=true
          break
        fi
        sleep 2
      done

      if $neo4j_ready; then
        # Clear existing data
        info "  Clearing existing graph data..."
        docker exec ping-mem-neo4j cypher-shell -u neo4j -p neo4j_password \
          "MATCH (n) DETACH DELETE n" 2>/dev/null || true

        # Import cypher statements
        docker cp "${BACKUP_DIR}/neo4j/neo4j-export.cypher" "ping-mem-neo4j:/tmp/import.cypher"
        if docker exec ping-mem-neo4j cypher-shell -u neo4j -p neo4j_password \
            --file /tmp/import.cypher 2>/dev/null; then
          docker exec ping-mem-neo4j rm -f /tmp/import.cypher 2>/dev/null || true
          components_ok=$((components_ok + 1))
          success "Neo4j restore complete (Cypher import)."
        else
          components_skipped=$((components_skipped + 1))
          warn "Neo4j Cypher import failed."
        fi
      else
        components_skipped=$((components_skipped + 1))
        warn "Neo4j did not become ready after 120 seconds. Skipping restore."
      fi
      docker stop ping-mem-neo4j 2>/dev/null || true
    elif [[ -f "${BACKUP_DIR}/neo4j/nodes.json" ]]; then
      components_skipped=$((components_skipped + 1))
      warn "Neo4j backup contains only JSON export. Automatic restore is not supported for this format."
      warn "  Files preserved at: ${BACKUP_DIR}/neo4j/nodes.json and rels.json"
      warn "  Manual import required."
    else
      components_skipped=$((components_skipped + 1))
      warn "No recognized Neo4j backup format found."
    fi
  fi

  # -------------------------------------------------------
  # Restart all containers
  # -------------------------------------------------------
  echo ""
  info "Restarting all ping-mem containers..."
  if [[ -n "$COMPOSE_FILE" ]]; then
    docker compose -f "$COMPOSE_FILE" --project-directory "$COMPOSE_PROJECT_DIR" up -d 2>/dev/null || true
  else
    for c in ping-mem-neo4j ping-mem-qdrant ping-mem; do
      if container_exists "$c"; then
        docker start "$c" 2>/dev/null || true
      fi
    done
  fi

  success "Containers restarted."

  # -------------------------------------------------------
  # Health check
  # -------------------------------------------------------
  info "Running health checks..."
  echo ""

  # Wait a bit for services to initialize
  sleep 5

  # Check Neo4j
  local neo4j_healthy=false
  for i in $(seq 1 30); do
    if docker exec ping-mem-neo4j cypher-shell -u neo4j -p neo4j_password "RETURN 1" >/dev/null 2>&1; then
      neo4j_healthy=true
      break
    fi
    sleep 2
  done
  if $neo4j_healthy; then
    success "  Neo4j:  healthy"
  else
    warn "  Neo4j:  not ready (may still be starting)"
  fi

  # Check Qdrant
  if curl -sf "http://localhost:6333/" >/dev/null 2>&1 || \
     curl -sf "http://localhost:6333/healthz" >/dev/null 2>&1; then
    # Check collection exists
    local coll_check
    coll_check="$(curl -sf "http://localhost:6333/collections/ping-mem-vectors" 2>/dev/null || echo "")"
    if echo "$coll_check" | grep -q '"status":"ok"' 2>/dev/null; then
      local point_count
      point_count="$(echo "$coll_check" | grep -o '"points_count":[0-9]*' | cut -d: -f2)"
      success "  Qdrant: healthy (${point_count:-0} vectors)"
    else
      warn "  Qdrant: running but collection not found"
    fi
  else
    warn "  Qdrant: not ready (may still be starting)"
  fi

  # Check ping-mem app
  local app_healthy=false
  for i in $(seq 1 20); do
    if curl -sf "http://localhost:3003/health" >/dev/null 2>&1; then
      app_healthy=true
      break
    fi
    # Also check REST port
    if curl -sf "http://localhost:3003/health" >/dev/null 2>&1; then
      app_healthy=true
      break
    fi
    sleep 2
  done
  if $app_healthy; then
    success "  App:    healthy"
  else
    warn "  App:    not ready (may still be starting, or depends on Neo4j/Qdrant)"
  fi

  # -------------------------------------------------------
  # Summary
  # -------------------------------------------------------
  echo ""
  echo -e "${CYAN}========================================${NC}"
  echo -e "${CYAN}  Restore Summary${NC}"
  echo -e "${CYAN}========================================${NC}"
  echo ""
  success "Source:     ${ARCHIVE}"
  success "Components: ${components_ok} restored, ${components_skipped} skipped"
  echo ""

  if [[ $components_ok -eq 0 ]]; then
    error "No components were restored. Check warnings above."
    exit 1
  fi

  if [[ $components_skipped -gt 0 ]]; then
    warn "Some components were skipped. Check warnings above."
  fi

  success "Restore complete."
}

main "$@"
