#!/usr/bin/env bash
#
# Rotate ping-mem API key and update local + VPS configs.
#
# Required env:
#   PING_MEM_API_KEY       Current API key
#   PING_MEM_API_URL       API base URL (default: https://mem.ping-gadgets.com)
# Optional env:
#   PING_MEM_ENV_FILE      Local .env file to update
#   PING_MEM_VPS_SSH       SSH target (e.g., root@1.2.3.4)
#   PING_MEM_VPS_ENV_FILE  .env path on VPS (default: /opt/ping-mem/.env)
#   PING_MEM_VPS_COMPOSE   docker compose file on VPS (default: /opt/ping-mem/docker-compose.prod.yml)

set -euo pipefail

API_URL="${PING_MEM_API_URL:-https://mem.ping-gadgets.com}"
CURRENT_KEY="${PING_MEM_API_KEY:-}"

if [[ -z "$CURRENT_KEY" ]]; then
  echo "PING_MEM_API_KEY is required" >&2
  exit 1
fi

response=$(curl -sf -X POST "$API_URL/api/admin/keys/rotate" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $CURRENT_KEY" \
  -d '{"deactivateOld":true}')

new_key=$(python3 - <<'PY'
import json, sys
data = json.loads(sys.stdin.read())
print(data.get("data", {}).get("key", ""))
PY
<<< "$response")

if [[ -z "$new_key" ]]; then
  echo "Failed to rotate key" >&2
  exit 1
fi

echo "New API key: $new_key"

update_env_file() {
  local env_file="$1"
  if [[ -f "$env_file" ]]; then
    if grep -q "^PING_MEM_API_KEY=" "$env_file"; then
      sed -i.bak "s/^PING_MEM_API_KEY=.*/PING_MEM_API_KEY=$new_key/" "$env_file"
    else
      echo "PING_MEM_API_KEY=$new_key" >> "$env_file"
    fi
    rm -f "$env_file.bak"
    echo "Updated $env_file"
  fi
}

update_mcp_json() {
  local json_path="$1"
  if [[ ! -f "$json_path" ]]; then
    return
  fi
  python3 - <<PY
import json
from pathlib import Path

path = Path("$json_path")
data = json.loads(path.read_text())
servers = data.get("mcpServers", {})
server = servers.get("ping-mem")
if not server:
    path.write_text(json.dumps(data, indent=2))
    raise SystemExit(0)
env = server.get("env", {})
env["PING_MEM_API_KEY"] = "$new_key"
server["env"] = env
servers["ping-mem"] = server
data["mcpServers"] = servers
path.write_text(json.dumps(data, indent=2))
PY
  echo "Updated $json_path"
}

update_env_file "${PING_MEM_ENV_FILE:-.env}"
update_mcp_json "$HOME/.claude/mcp.json"
update_mcp_json "$HOME/.cursor/mcp.json"
update_mcp_json "$PWD/.cursor/mcp.json"

if [[ -n "${PING_MEM_VPS_SSH:-}" ]]; then
  VPS_ENV_FILE="${PING_MEM_VPS_ENV_FILE:-/opt/ping-mem/.env}"
  VPS_COMPOSE="${PING_MEM_VPS_COMPOSE:-/opt/ping-mem/docker-compose.prod.yml}"
  ssh "$PING_MEM_VPS_SSH" "
    set -e
    if [[ -f '$VPS_ENV_FILE' ]]; then
      if grep -q '^PING_MEM_API_KEY=' '$VPS_ENV_FILE'; then
        sed -i 's/^PING_MEM_API_KEY=.*/PING_MEM_API_KEY=$new_key/' '$VPS_ENV_FILE'
      else
        echo 'PING_MEM_API_KEY=$new_key' >> '$VPS_ENV_FILE'
      fi
    else
      echo 'PING_MEM_API_KEY=$new_key' > '$VPS_ENV_FILE'
    fi
    docker compose -f '$VPS_COMPOSE' up -d --build
  "
  echo "Updated VPS and restarted ping-mem"
fi
