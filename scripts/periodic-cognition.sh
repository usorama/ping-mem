#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PING_MEM_ENV_FILE:-$PROJECT_ROOT/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BASE_URL="${PING_MEM_REST_URL:-http://localhost:3003}"
ADMIN_USER="${PING_MEM_ADMIN_USER:-}"
ADMIN_PASS="${PING_MEM_ADMIN_PASS:-}"
AUTO_MINE="${PING_MEM_AUTO_MINE:-false}"
AUTO_DREAM="${PING_MEM_AUTO_DREAM:-false}"
MINE_LIMIT="${PING_MEM_AUTO_MINE_LIMIT:-10}"
SESSION_NAME="${PING_MEM_AUTO_DREAM_SESSION_NAME:-periodic-cognition}"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*"
}

if [[ "$AUTO_MINE" != "true" && "$AUTO_DREAM" != "true" ]]; then
  log "periodic cognition disabled (set PING_MEM_AUTO_MINE=true and/or PING_MEM_AUTO_DREAM=true)"
  exit 0
fi

if [[ -z "$ADMIN_USER" || -z "$ADMIN_PASS" ]]; then
  log "admin credentials missing; cannot run periodic cognition"
  exit 1
fi

AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$ADMIN_USER" "$ADMIN_PASS" | base64)"

curl_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if (($# > 3)); then
    shift 3
    if [[ -n "$body" ]]; then
      curl -fsS -X "$method" "$BASE_URL$path" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        "$@" \
        -d "$body"
    else
      curl -fsS -X "$method" "$BASE_URL$path" \
        -H "$AUTH_HEADER" \
        "$@"
    fi
  else
    if [[ -n "$body" ]]; then
      curl -fsS -X "$method" "$BASE_URL$path" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        -d "$body"
    else
      curl -fsS -X "$method" "$BASE_URL$path" \
        -H "$AUTH_HEADER"
    fi
  fi
}

SESSION_ID=""

cleanup() {
  if [[ -n "$SESSION_ID" ]]; then
    curl -fsS -X POST "$BASE_URL/api/v1/session/end" \
      -H "$AUTH_HEADER" \
      -H "X-Session-ID: $SESSION_ID" \
      -H "Content-Type: application/json" \
      -d '{}' >/dev/null || true
  fi
}

trap cleanup EXIT

if [[ "$AUTO_MINE" == "true" ]]; then
  log "starting transcript mining"
  curl_json POST "/api/v1/mining/start" "{\"limit\":$MINE_LIMIT}" >/dev/null
  log "transcript mining complete"
fi

if [[ "$AUTO_DREAM" == "true" ]]; then
  log "starting dreaming cycle"
  SESSION_ID="$(
    curl_json POST "/api/v1/session/start" "{\"name\":\"$SESSION_NAME\",\"defaultChannel\":\"automation\"}" \
      | bun -e 'const data = JSON.parse(await Bun.stdin.text()); process.stdout.write(data.data?.sessionId ?? data.sessionId ?? "");'
  )"

  if [[ -z "$SESSION_ID" ]]; then
    log "failed to create service session for dreaming"
    exit 1
  fi

  curl_json POST "/api/v1/tools/dreaming_run/invoke" "{\"args\":{\"dream\":true}}" \
    -H "X-Session-ID: $SESSION_ID" >/dev/null
  log "dreaming cycle complete"
fi

log "periodic cognition finished"
