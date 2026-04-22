#!/bin/bash
set -euo pipefail

PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"
ADMIN_USER="${PING_MEM_ADMIN_USER:-admin}"
ADMIN_PASS="${PING_MEM_ADMIN_PASS:?PING_MEM_ADMIN_PASS must be set}"
REGISTERED_FILE="${PING_MEM_REGISTERED_PROJECTS_PATH:-$HOME/.ping-mem/registered-projects.txt}"
HOST_PROJECTS_ROOT="${PING_MEM_HOST_PROJECTS_ROOT:-$HOME/Projects}"
CONTAINER_PROJECTS_ROOT="${PING_MEM_CONTAINER_PROJECTS_ROOT:-/projects}"
DELETE_MODE="${1:-}"

command -v curl >/dev/null 2>&1 || { echo "curl not found" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 2; }

if [ ! -f "$REGISTERED_FILE" ]; then
  echo "Registered-projects file not found: $REGISTERED_FILE" >&2
  exit 2
fi

PROJECTS_JSON="$(curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" "${PING_MEM_URL}/api/v1/codebase/projects?scope=all&limit=1000")"

TMP_REGISTERED="$(mktemp -t ping-mem-registered-XXXXXX)"
TMP_STALE="$(mktemp -t ping-mem-stale-XXXXXX)"
trap 'rm -f "$TMP_REGISTERED" "$TMP_STALE"' EXIT

while IFS= read -r line; do
  trimmed="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -z "$trimmed" ] && continue
  case "$trimmed" in
    \#*) continue ;;
  esac

  printf '%s\n' "$trimmed" >> "$TMP_REGISTERED"
  case "$trimmed" in
    "$HOST_PROJECTS_ROOT"/*)
      rel="${trimmed#"$HOST_PROJECTS_ROOT"/}"
      printf '%s/%s\n' "$CONTAINER_PROJECTS_ROOT" "$rel" >> "$TMP_REGISTERED"
      ;;
    "$HOST_PROJECTS_ROOT")
      printf '%s\n' "$CONTAINER_PROJECTS_ROOT" >> "$TMP_REGISTERED"
      ;;
  esac
done < "$REGISTERED_FILE"

jq -r '.data.projects[] | [.projectId, .rootPath, (.commitsCount|tostring), (.filesCount|tostring)] | @tsv' <<<"$PROJECTS_JSON" |
while IFS=$'\t' read -r project_id root_path commits_count files_count; do
  if ! grep -Fxq "$root_path" "$TMP_REGISTERED"; then
    printf '%s\t%s\t%s\t%s\n' "$project_id" "$root_path" "$commits_count" "$files_count" >> "$TMP_STALE"
  fi
done

if [ ! -s "$TMP_STALE" ]; then
  echo "No stale project rows found."
  exit 0
fi

echo "Stale/unregistered project rows:"
while IFS=$'\t' read -r project_id root_path commits_count files_count; do
  printf '  %s  commits=%s files=%s  id=%s\n' "$root_path" "$commits_count" "$files_count" "$project_id"
done < "$TMP_STALE"

if [ "$DELETE_MODE" != "--delete" ]; then
  echo ""
  echo "Run with --delete to remove these rows from graph/vector/admin state."
  exit 0
fi

while IFS=$'\t' read -r project_id _root_path _commits_count _files_count; do
  curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" -X DELETE "${PING_MEM_URL}/api/v1/codebase/projects/${project_id}" >/dev/null
done < "$TMP_STALE"

echo ""
echo "Deleted stale project rows."
