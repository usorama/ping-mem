#!/bin/bash
# Phase 2 remediation (2026-04-18): Deterministic coverage check.
#
# For each project, compute:
#
#   FILES denominator  = files the scanner considers ingest-eligible.
#                        The scanner filters by extension (DEFAULT_EXCLUDE_EXTENSIONS),
#                        by max-file-size (1MB), and by ignore-dirs. Using raw
#                        `git ls-files | wc -l` would compare ingested vs untrackable
#                        binaries/PDFs and always fail.
#
#   COMMITS denominator = `git log --all --format=%H | wc -l`. The scanner reads
#                         all branches via `git log --all` (SafeGit.getLog), so the
#                         denominator must match. `git rev-list --count HEAD` only
#                         counts HEAD-reachable commits, which undercounts.
#
#   PM_COMMITS, PM_FILES = values reported by /api/v1/codebase/projects
#
# Prints one line per project:
#   name: commits N/M (P%), files N/M (P%)
#
# Exit codes:
#   0 — all 5 projects ≥THRESHOLD_PCT% on BOTH commits and files
#   1 — gate failed (at least one project below threshold)
#   2 — health/infra error (ping-mem unreachable, jq missing, etc.)

set -euo pipefail

PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"
ADMIN_USER="${PING_MEM_ADMIN_USER:-admin}"
ADMIN_PASS="${PING_MEM_ADMIN_PASS:-ping-mem-dev-local}"
HOST_PROJECTS_ROOT="${HOST_PROJECTS_ROOT:-$HOME/Projects}"
CONTAINER_PROJECTS_ROOT="${CONTAINER_PROJECTS_ROOT:-/projects}"
THRESHOLD_PCT="${THRESHOLD_PCT:-95}"
MAX_FILE_SIZE_BYTES="${MAX_FILE_SIZE_BYTES:-1048576}"  # must match scanner default

PROJECTS=(ping-learn ping-mem auto-os ping-guard thrivetree)

# Scanner's DEFAULT_EXCLUDE_EXTENSIONS — kept in sync with src/ingest/ProjectScanner.ts.
# If the scanner's list changes, update this array.
EXCLUDE_EXTENSIONS=(
  png jpg jpeg gif bmp tiff webp ico svg
  mp4 webm mp3 wav ogg
  pdf doc docx xls xlsx ppt pptx
  zip tar gz bz2 7z rar
  woff woff2 ttf eot otf
  exe dll so dylib pyc pyo class
  db sqlite sqlite3
  lock
  "d.ts" map "min.js" "min.css" snap
  log wasm
  pbxproj xcworkspacedata xcscheme tsbuildinfo
)

# Scanner's DEFAULT_IGNORE_DIRS — kept in sync with src/ingest/ProjectScanner.ts.
# A file with any path segment matching one of these is filtered by the scanner,
# so the verify denominator must also exclude them.
IGNORE_DIRS=(
  .git .svn .hg
  node_modules dist build .next .cache
  .venv venv __pycache__
  .ping-mem .worktrees .claude .vscode .idea
  .overstory coverage tmp temp out
  .turbo .parcel-cache .swc vendor
  .terraform .serverless e2e-tests
  .autoresearch .beads .mulch .playwright-mcp .deployments snapshots
)

# Build a grep pattern that matches any excluded extension at end of filename.
# Anchored to match "$" and handles compound extensions (.d.ts, .min.js) correctly.
build_exclude_regex() {
  local parts=()
  for ext in "${EXCLUDE_EXTENSIONS[@]}"; do
    parts+=( "\.${ext}\$" )
  done
  (IFS='|'; echo "${parts[*]}")
}

EXCLUDE_REGEX=$(build_exclude_regex)

has_ignored_segment() {
  local rel="$1"
  local OLD_IFS="$IFS"
  IFS='/'
  # shellcheck disable=SC2086
  set -- $rel
  IFS="$OLD_IFS"
  for seg in "$@"; do
    for ign in "${EXTRA_IGNORE_DIRS[@]:-${IGNORE_DIRS[@]}}"; do
      [ "$seg" = "$ign" ] && return 0
    done
    for ign in "${IGNORE_DIRS[@]}"; do
      [ "$seg" = "$ign" ] && return 0
    done
  done
  return 1
}

# has_ignored_prefix REL PROJECT_DIR — true if rel matches a path-prefix pattern
# read from .gitignore/.pingmemignore (entries containing '/').
has_ignored_prefix() {
  local rel="$1"
  for prefix in "${EXTRA_IGNORE_PREFIXES[@]:-}"; do
    [ -z "$prefix" ] && continue
    case "$rel" in
      "$prefix"|"$prefix"/*) return 0 ;;
    esac
  done
  return 1
}

# load_project_ignores DIR — populates EXTRA_IGNORE_DIRS and EXTRA_IGNORE_PREFIXES
# from .gitignore + .pingmemignore in DIR (matching scanner logic).
load_project_ignores() {
  local DIR="$1"
  EXTRA_IGNORE_DIRS=()
  EXTRA_IGNORE_PREFIXES=()
  for f in .gitignore .pingmemignore; do
    local path="$DIR/$f"
    [ -f "$path" ] || continue
    while IFS= read -r line; do
      local trimmed
      trimmed=$(echo "$line" | sed 's/[[:space:]]*$//;s/^[[:space:]]*//')
      [ -z "$trimmed" ] && continue
      case "$trimmed" in
        \#*|\!*) continue ;;
      esac
      # Strip leading /, trailing /
      local cleaned="${trimmed#/}"
      cleaned="${cleaned%/}"
      [ -z "$cleaned" ] && continue
      # Skip globs
      case "$cleaned" in
        *\**|*\?*) continue ;;
      esac
      if [ "${cleaned#*/}" != "$cleaned" ]; then
        # has slash → path prefix
        EXTRA_IGNORE_PREFIXES+=("$cleaned")
      else
        # dir name
        EXTRA_IGNORE_DIRS+=("$cleaned")
      fi
    done < "$path"
  done
}

# count_eligible_files HOST_DIR → prints count
count_eligible_files() {
  local DIR="$1"
  # Load project-specific ignores (.gitignore + .pingmemignore) — scanner does this.
  load_project_ignores "$DIR"
  local COUNT=0
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    # Dir ignore filter — scanner skips any file whose path contains an ignored segment.
    if has_ignored_segment "$rel"; then
      continue
    fi
    # Path-prefix filter (from .gitignore entries with slashes)
    if has_ignored_prefix "$rel"; then
      continue
    fi
    local path="$DIR/$rel"
    [ -e "$path" ] || continue
    # Mirror ProjectScanner.hashAndValidateFile: skip non-regular files (gitlinks,
    # submodules, directories registered as files), dotenv files, and binaries.
    [ -f "$path" ] || continue
    local base
    base="$(basename "$rel")"
    if [ "$base" = ".env" ] || [[ "$base" == .env.* ]]; then
      continue
    fi
    # Extension filter
    if echo "$rel" | grep -Eqi "$EXCLUDE_REGEX"; then
      continue
    fi
    # Size filter
    local size
    size=$(stat -f '%z' "$path" 2>/dev/null || stat -c '%s' "$path" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_FILE_SIZE_BYTES" ] 2>/dev/null; then
      continue
    fi
    # Binary filter — scanner rejects files with NUL bytes in the first 8KB.
    if head -c 8192 "$path" 2>/dev/null | LC_ALL=C grep -q $'\x00'; then
      continue
    fi
    COUNT=$((COUNT + 1))
  done < <(git -C "$DIR" ls-files 2>/dev/null)
  echo "$COUNT"
}

# count_all_branch_commits HOST_DIR → prints count across all branches
count_all_branch_commits() {
  local DIR="$1"
  git -C "$DIR" log --all --format=%H 2>/dev/null | wc -l | tr -d ' '
}

command -v jq >/dev/null || { echo "ERROR: jq required on host" >&2; exit 2; }
command -v bc >/dev/null || { echo "ERROR: bc required on host" >&2; exit 2; }

if ! curl -sf --max-time 5 "${PING_MEM_URL}/health" >/dev/null; then
  echo "ERROR: ping-mem not reachable at ${PING_MEM_URL}" >&2
  exit 2
fi

# Under `set -e`, a failing curl would exit with curl's status and hide the
# documented infra-failure code 2. Capture exit explicitly and map any failure
# to exit 2.
set +e
PROJECTS_JSON=$(curl -sf --max-time 30 -u "${ADMIN_USER}:${ADMIN_PASS}" \
  "${PING_MEM_URL}/api/v1/codebase/projects" 2>&1)
CURL_EXIT=$?
set -e
if [ "$CURL_EXIT" -ne 0 ]; then
  echo "ERROR: /api/v1/codebase/projects failed (curl=${CURL_EXIT}): ${PROJECTS_JSON}" >&2
  exit 2
fi
if [ -z "$PROJECTS_JSON" ]; then
  echo "ERROR: /api/v1/codebase/projects returned empty" >&2
  exit 2
fi

FAIL=0
echo "Coverage gate threshold: ${THRESHOLD_PCT}% (commits AND files)"
echo "Denominators: commits = git log --all | wc -l; files = ingest-eligible (post-filter, ≤1MB)"
echo "-----------------------------------------------------------"

printf "%-14s %-28s %-28s %s\n" "project" "commits N/M (P%)" "files N/M (P%)" "status"

for P in "${PROJECTS[@]}"; do
  HOST_DIR="${HOST_PROJECTS_ROOT}/${P}"
  CONTAINER_DIR="${CONTAINER_PROJECTS_ROOT}/${P}"

  if [ ! -d "$HOST_DIR" ]; then
    printf "%-14s %-28s %-28s %s\n" "$P" "-" "-" "SKIP (no dir)"
    continue
  fi

  ACTUAL_COMMITS=$(count_all_branch_commits "$HOST_DIR")
  ACTUAL_FILES=$(count_eligible_files "$HOST_DIR")

  # Most-recent entry for this rootPath (Neo4j may have historical duplicates).
  PM=$(echo "$PROJECTS_JSON" | jq -c --arg rp "$CONTAINER_DIR" \
    '[.data.projects[] | select(.rootPath == $rp)] | sort_by(.lastIngestedAt) | last' 2>/dev/null || echo "null")

  if [ "$PM" = "null" ] || [ -z "$PM" ]; then
    printf "%-14s %-28s %-28s %s\n" "$P" "?/$ACTUAL_COMMITS" "?/$ACTUAL_FILES" "NOT INGESTED"
    FAIL=$((FAIL + 1))
    continue
  fi

  PM_COMMITS=$(echo "$PM" | jq -r '.commitsCount // 0')
  PM_FILES=$(echo "$PM" | jq -r '.filesCount // 0')

  if [ "$ACTUAL_COMMITS" = "0" ]; then
    C_PCT="0.00"
  else
    C_PCT=$(echo "scale=2; ${PM_COMMITS}*100/${ACTUAL_COMMITS}" | bc)
  fi
  if [ "$ACTUAL_FILES" = "0" ]; then
    F_PCT="0.00"
  else
    F_PCT=$(echo "scale=2; ${PM_FILES}*100/${ACTUAL_FILES}" | bc)
  fi

  C_PASS=$(echo "$C_PCT >= $THRESHOLD_PCT" | bc)
  F_PASS=$(echo "$F_PCT >= $THRESHOLD_PCT" | bc)

  STATUS="PASS"
  if [ "$C_PASS" != "1" ] || [ "$F_PASS" != "1" ]; then
    STATUS="FAIL"
    FAIL=$((FAIL + 1))
  fi

  printf "%-14s %-28s %-28s %s\n" \
    "$P" \
    "${PM_COMMITS}/${ACTUAL_COMMITS} (${C_PCT}%)" \
    "${PM_FILES}/${ACTUAL_FILES} (${F_PCT}%)" \
    "$STATUS"

  echo "$P: commits ${PM_COMMITS}/${ACTUAL_COMMITS} (${C_PCT}%), files ${PM_FILES}/${ACTUAL_FILES} (${F_PCT}%)" >&2
done

echo "-----------------------------------------------------------"
if [ "$FAIL" -gt 0 ]; then
  echo "GATE FAILED: ${FAIL} project(s) below ${THRESHOLD_PCT}% threshold"
  exit 1
fi

echo "GATE PASSED: all ${#PROJECTS[@]} projects ≥${THRESHOLD_PCT}% on commits AND files"
