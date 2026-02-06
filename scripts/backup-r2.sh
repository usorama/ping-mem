#!/usr/bin/env bash
#
# Create a rolling backup of ping-mem volumes and upload to Cloudflare R2.
#
# Required env:
#   R2_REMOTE            rclone remote name (e.g., r2)
#   R2_BUCKET            bucket name
# Optional env:
#   R2_PREFIX            prefix path (default: ping-mem)
#   BACKUP_DIR           local temp dir (default: /tmp/ping-mem-backup)

set -euo pipefail

R2_REMOTE="${R2_REMOTE:-}"
R2_BUCKET="${R2_BUCKET:-}"
R2_PREFIX="${R2_PREFIX:-ping-mem}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/ping-mem-backup}"

if [[ -z "$R2_REMOTE" || -z "$R2_BUCKET" ]]; then
  echo "R2_REMOTE and R2_BUCKET are required" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

backup_volume() {
  local volume="$1"
  local output="$2"
  docker run --rm -v "$volume":/data -v "$BACKUP_DIR":/backup alpine \
    tar czf "/backup/$output" -C /data .
}

backup_volume "ping-mem-data" "ping-mem-data.tar.gz"
backup_volume "ping-mem-neo4j-data" "ping-mem-neo4j-data.tar.gz"
backup_volume "ping-mem-qdrant-data" "ping-mem-qdrant-data.tar.gz"

tar czf "$BACKUP_DIR/ping-mem-backup.tar.gz" -C "$BACKUP_DIR" \
  ping-mem-data.tar.gz ping-mem-neo4j-data.tar.gz ping-mem-qdrant-data.tar.gz

rclone copyto "$BACKUP_DIR/ping-mem-backup.tar.gz" \
  "$R2_REMOTE:$R2_BUCKET/$R2_PREFIX/latest.tar.gz"

echo "Backup uploaded to $R2_REMOTE:$R2_BUCKET/$R2_PREFIX/latest.tar.gz"
