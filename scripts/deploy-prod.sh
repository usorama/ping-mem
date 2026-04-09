#!/bin/bash
# Deploys ping-mem to production VPS.
# Handles the port 3003->3000 rewrite that docker-compose.prod.yml requires on VPS
# (Nginx proxies external traffic to internal port 3000).
set -euo pipefail

VPS_HOST="72.62.117.123"
VPS_PATH="/opt/ping-mem"

echo "Syncing to VPS..."
rsync -av \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.data-backup' \
  --exclude='.worktrees' \
  --exclude='dist' \
  --exclude='.claude' \
  /Users/umasankr/Projects/ping-mem/ \
  root@${VPS_HOST}:${VPS_PATH}/

echo "Patching port for VPS (3003 -> 3000)..."
ssh root@${VPS_HOST} "sed -i 's/127.0.0.1:3003:3003/127.0.0.1:3000:3000/g; s/PING_MEM_PORT=3003/PING_MEM_PORT=3000/g' ${VPS_PATH}/docker-compose.prod.yml"

echo "Restarting containers..."
ssh root@${VPS_HOST} "cd ${VPS_PATH} && docker compose -f docker-compose.prod.yml up -d --build"

echo "Deploy complete."
