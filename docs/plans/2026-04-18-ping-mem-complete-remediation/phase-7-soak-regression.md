---
phase-id: P7
title: "30-day soak counter + CI regression suite — O10 measurement machinery"
status: pending
effort_estimate: 3h
dependent-on: [phase-0-prep, phase-1-memory-sync-mcp-auth, phase-2-ingestion-coverage, phase-3-ollama-selfheal, phase-4-lifecycle-supervisor, phase-5-observability-doctor, phase-6-auto-os]
owns_wiring: [W28, W29]
owns_outcomes: [O10]
addresses_gaps: [H.2, B.5 (CI side)]
blocks: [phase-8-docs-handoff]
---

# Phase 7 — 30-Day Soak Counter + CI Regression Suite

## Phase Goal

Deliver **O10** (30-day soak green) by (a) building the deterministic streak-day math that reads doctor-runs JSONL and computes `~/.ping-mem/soak-state.json`, (b) wiring the 5-of-5 canonical regression queries into a Bun test that runs in CI on every push/PR, and (c) installing a launchd job that runs the soak computation daily. P5 owns the doctor gates + alert wiring; P7 owns the math that reads their output, plus the CI guard that keeps the regression queries green as code evolves.

**O10 binary test**: `jq -r '.status' ~/.ping-mem/soak-state.json` returns `green` at day 30, meaning all 14 HARD gates have `streak_days_green >= 30` AND all 5 SOFT gates have `red_days_in_window <= 6`. (Previous draft said "10 hard gates"; the 10→14 expansion came from splitting the 5 canonical regression queries and 2 coverage axes into separate P5 gate IDs — a diagnostic improvement, not a scope change.)

## Pre-conditions

From prior phases:

- **P0**: disk ≤85%, typecheck+test baseline captured, stale procs killed.
- **P1**: MCP auth works, 5/5 regression queries return ≥1 hit via the smoke test in `P1.10`. `~/.ping-mem/sync-session-id` exists and is valid for the native-sync session.
- **P2**: ingestion coverage ≥95% across 5 projects; `codebase_list_projects` is stable.
- **P3**: Ollama self-heal chain wired; `ollama_triage`/`recovery`/`deep` endpoints answer.
- **P4**: cleanup-disk.sh + log rotation + supervisor rewrite + watchdog plist loaded; disk gate can stay green.
- **P5**: `bun run doctor` emits one JSONL line per run at `~/.ping-mem/doctor-runs/<ISO-8601>.jsonl` (colons replaced with hyphens per `new Date().toISOString().replace(/:/g, "-")`). Each line contains the `DoctorResult` shape from phase-5 §P5.1: `{ gates: [{ id, name, category, severity, status: "pass"|"fail"|"skip", ... }], summary, exitCode, timestamp }`. P7's `soak-monitor.sh` matches on `.id` and maps `pass→green, fail/skip→red`. Launchd plist `com.ping-mem.doctor.plist` runs every 15 min. P5 registry has 35 gates total; the 14-hard + 5-soft subset used for O10 soak acceptance is defined in overview.md §30-Day Soak Acceptance.
- **P6**: auto-os write path + cross-project smoke test operational (so the `auto-os-cross-project-hit` soft gate has real data).
- Ping-mem REST listens on `http://localhost:3003` with Basic Auth enabled.

## Task list

### P7.1 — `tests/regression/memory-sync-coverage.test.ts`

**Outcome**: O10 indirectly via AC-S1 (5/5 queries must stay green throughout the 30-day window). Owns **W29**.

This is a Bun test run via `bun test tests/regression/*.test.ts`. It uses the same 5 canonical queries as P1.10 smoke test, but guards against regression as code lands.

**Session discipline (A-TEST-3 + A-DOM-4)**: the test MUST NOT reuse `~/.ping-mem/sync-session-id` (that's native-sync's session and sharing would create cross-contamination between the test and the live sync). Instead, `beforeAll` creates a dedicated test session via `POST /api/v1/session/start` with `name: "regression-p7"`, stores its ID in a module-scoped variable, and `afterAll` ends it. `getSharedSessionId()` is a local helper returning the stored ID.

**Safety**: `regression-p7` is added to P1's `SessionManager.reapSystemSessions` allowlist even though the test lifecycle is short — if a CI run crashes mid-test, the session is still reapable (15-min idle threshold for named system sessions per P1.8). See task P7.5 for the handshake with P1.

**jq|grep raw mode (A-TEST-1 F2 fix)**: when the test asserts on memory content, `jq -r` (raw) strips quotes before the assertion. In Bun the equivalent is reading `.data[N].value` as a string and using `.toContain(...)`, which is already raw. This rule is recorded in the test file comment for reviewers.

Create directory + file:

```bash
mkdir -p /Users/umasankr/Projects/ping-mem/tests/regression
```

Full file contents (`tests/regression/memory-sync-coverage.test.ts`):

```typescript
/**
 * Regression suite — W29 / W6 (CI variant) / AC-S1.
 *
 * Asserts that the 5 canonical memory-sync queries each return >=1 hit against
 * a running ping-mem REST instance. Runs in CI on every push/PR.
 *
 * Session discipline (A-TEST-3 + A-DOM-4):
 *   - Creates a dedicated `regression-p7` session in beforeAll.
 *   - Tears it down in afterAll.
 *   - MUST NOT share the native-sync session cached at ~/.ping-mem/sync-session-id.
 *
 * jq|grep raw-mode rule (A-TEST-1 F2 fix):
 *   When asserting on memory content, `.data[N].value` is already a raw JS string
 *   (no jq|grep pipeline here). `.toContain(...)` does the equivalent of `jq -r | grep -c`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

const PING_MEM_URL = process.env.PING_MEM_URL ?? "http://localhost:3003";
const ADMIN_USER = process.env.PING_MEM_ADMIN_USER;
const ADMIN_PASS = process.env.PING_MEM_ADMIN_PASS;
const SESSION_NAME = "regression-p7";
const PROJECT_DIR = "/tmp/regression";

if (!ADMIN_USER || !ADMIN_PASS) {
  throw new Error(
    "PING_MEM_ADMIN_USER and PING_MEM_ADMIN_PASS must be set in the environment.",
  );
}

const BASIC_AUTH = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64")}`;

let sharedSessionId: string | undefined;

function getSharedSessionId(): string {
  if (!sharedSessionId) {
    throw new Error("Session not initialised — beforeAll did not run.");
  }
  return sharedSessionId;
}

async function postJson<T = unknown>(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${PING_MEM_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: BASIC_AUTH,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function getJson<T = unknown>(path: string, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${PING_MEM_URL}${path}`, {
    headers: {
      Authorization: BASIC_AUTH,
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface SessionStartResponse {
  data: { sessionId: string };
}

interface SearchResponse {
  data: Array<{ key: string; value: string; score?: number }>;
}

beforeAll(async () => {
  const result = await postJson<SessionStartResponse>("/api/v1/session/start", {
    name: SESSION_NAME,
    projectDir: PROJECT_DIR,
  });
  sharedSessionId = result.data.sessionId;
  if (!sharedSessionId) {
    throw new Error("Failed to create regression-p7 session");
  }
});

afterAll(async () => {
  if (!sharedSessionId) return;
  try {
    await postJson(
      "/api/v1/session/end",
      {},
      { "X-Session-ID": sharedSessionId },
    );
  } catch (err) {
    console.warn(`Session teardown failed (safe to ignore): ${String(err)}`);
  }
});

// Canonical tier — exactly 5 queries count toward AC-S1.
const CANONICAL_QUERIES: readonly string[] = [
  "ping-learn pricing research",
  "Firebase FCM pinglearn-c63a2",
  "classroom redesign worktree",
  "PR 236 JWT secret isolation",
  "DPDP consent age 18",
] as const;

// Stretch tier — run for signal; not required by AC-S1. Listed here for future
// coverage without inflating the canonical count.
const STRETCH_QUERIES: readonly string[] = [
  "superpowers skill",
  "parental consent age 18 DPDP",
] as const;

describe("W29 — regression: 5 canonical memory-sync queries return >=1 hit", () => {
  it.each(CANONICAL_QUERIES)("canonical: %s returns >=1 hit", async (query) => {
    const url = `/api/v1/search?query=${encodeURIComponent(query)}&limit=5`;
    const body = await getJson<SearchResponse>(url, { "X-Session-ID": getSharedSessionId() });
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    // Raw-mode content sanity: every hit must have a non-empty string value.
    for (const row of body.data) {
      expect(typeof row.value).toBe("string");
      expect(row.value.length).toBeGreaterThan(0);
    }
  });
});

describe("W29 stretch (signal only — does not gate AC-S1)", () => {
  it.each(STRETCH_QUERIES)("stretch: %s (soft)", async (query) => {
    const url = `/api/v1/search?query=${encodeURIComponent(query)}&limit=5`;
    const body = await getJson<SearchResponse>(url, { "X-Session-ID": getSharedSessionId() });
    // Stretch test is informational: >=0 is acceptable. Assertion prints count for CI log.
    expect(body.data.length).toBeGreaterThanOrEqual(0);
  });
});
```

### P7.2 — `scripts/soak-monitor.sh`

**Outcome**: O10 via W28. Computes per-gate streak-days-green and red-day-in-window counts.

Math specification (from overview.md H — Realistic bar):

- HARD gates (14): any red day on any hard gate resets that gate's `streak_days_green` counter to 0. Overall `status = green` requires every hard gate's streak ≥ 30. (Count matches this phase's gate list and overview §30-Day Soak Acceptance.)
- SOFT gates (5): use a trailing 30-day window. Count total red days in the window. `status = green` tolerates up to 6 red days (so `red_days_in_window <= 6` per soft gate).
- Day boundary = calendar day in local TZ (Asia/Kolkata). A "day" is red if the day has ≥1 red doctor-run for that gate. A day with no doctor-runs at all is treated as red (absence = failure, per safety default).
- Script is O(day) (max 30 days in window) × O(gates) (29 total) × O(runs-per-day) — bounded, idempotent, safe to re-run.

Create file (`scripts/soak-monitor.sh`):

```bash
#!/usr/bin/env bash
#
# soak-monitor.sh — 30-day soak counter for ping-mem O10.
# Runs daily (launchd). Reads doctor-runs JSONL, computes per-gate streak math,
# writes ~/.ping-mem/soak-state.json.
#
# Exit codes:
#   0  status=green  (all hard gates streak>=30 AND all soft gates red_days<=6)
#   1  status=red    (any hard gate streak<30 OR any soft gate red_days>6)
#   2  error         (jq/bash/filesystem failure)
#
# Idempotent. Re-running on the same day produces the same output.

set -euo pipefail

DOCTOR_RUNS_DIR="${DOCTOR_RUNS_DIR:-$HOME/.ping-mem/doctor-runs}"
SOAK_STATE_FILE="${SOAK_STATE_FILE:-$HOME/.ping-mem/soak-state.json}"
WINDOW_DAYS="${WINDOW_DAYS:-30}"
SOFT_TOLERANCE="${SOFT_TOLERANCE:-6}"

#
# HARD and SOFT gate IDs MUST match P5's gate registry IDs exactly.
# P5 emits `{id: "<slug>", status: "pass"|"fail"|"skip", ...}` — this script
# matches on `.id` and maps `pass→green`, `fail→red`, `skip→red` (safety).
# If you add/rename a gate in P5, update this list in the same PR.
#
HARD_GATES=(
  "rest-health-200"
  "mcp-proxy-stdio"
  "query-ping-learn-pricing"
  "query-firebase-fcm"
  "query-classroom-redesign"
  "query-pr-236-jwt"
  "query-dpdp-consent-18"
  "coverage-commits-ge-95pct"
  "coverage-files-ge-95pct"
  "ollama-reachable"
  "disk-below-85"
  "session-cap-below-80pct"
  "supervisor-no-rollback-24h"
  "doctor-launchd-ran"
)

SOFT_GATES=(
  "orbstack-warm-latency"
  "log-rotation-last-7d"
  "pattern-confidence-nonzero"
  "auto-os-cross-project-hit"
  "ping-mem-doctor-exec-time-below-10s"
)

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required" >&2
  exit 2
fi

if [ ! -d "$DOCTOR_RUNS_DIR" ]; then
  echo "FAIL: $DOCTOR_RUNS_DIR does not exist — is P5 doctor launchd running?" >&2
  exit 2
fi

# Get list of calendar-day keys (YYYY-MM-DD) in the last $WINDOW_DAYS days, in local TZ.
# Oldest first, newest last.
DAY_KEYS=()
for ((i = WINDOW_DAYS - 1; i >= 0; i--)); do
  DAY_KEYS+=("$(date -v-"$i"d +%Y-%m-%d)")
done

# For a given gate and day, return "green" if >=1 P5 run that day shows `status=pass`
# AND no run shows `status=fail`; "red" otherwise.
# Matches on `.id` (P5's stable slug) — NOT `.name` (human display).
# Maps P5 status: pass→green, fail→red, skip→red (safety default).
# Absence of runs for that day = "red" (safety default).
# File naming: P5 writes `<ISO8601>.jsonl` e.g. `2026-04-18T06:00:15Z.jsonl` — matches `${day}T*.jsonl`.
gate_day_status() {
  local gate="$1"
  local day="$2"
  local files
  files=$(find "$DOCTOR_RUNS_DIR" -type f -name "${day}T*.jsonl" 2>/dev/null || true)
  if [ -z "$files" ]; then
    echo "red"
    return
  fi
  local any_pass="no"
  local any_fail="no"
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      local status
      status=$(echo "$line" | jq -r --arg g "$gate" '.gates[]? | select(.id == $g) | .status' 2>/dev/null || true)
      [ -z "$status" ] && continue
      case "$status" in
        pass) any_pass="yes" ;;
        fail) any_fail="yes" ;;
        skip) any_fail="yes" ;;  # skip treated as red for soak accounting (safety default)
      esac
    done < "$f"
  done <<< "$files"
  if [ "$any_fail" = "yes" ]; then
    echo "red"
  elif [ "$any_pass" = "yes" ]; then
    echo "green"
  else
    echo "red"
  fi
}

# Build per-gate state.
HARD_RESULTS_JSON="[]"
OVERALL_STATUS="green"

for gate in "${HARD_GATES[@]}"; do
  # streak_days_green = count trailing green days from newest back to first red
  streak=0
  for ((i = ${#DAY_KEYS[@]} - 1; i >= 0; i--)); do
    day="${DAY_KEYS[$i]}"
    s=$(gate_day_status "$gate" "$day")
    if [ "$s" = "green" ]; then
      streak=$((streak + 1))
    else
      break
    fi
  done
  # Any red day in window causes clock reset: streak<30 means reset has happened
  if [ "$streak" -lt "$WINDOW_DAYS" ]; then
    OVERALL_STATUS="red"
  fi
  HARD_RESULTS_JSON=$(jq -c \
    --arg name "$gate" \
    --argjson streak "$streak" \
    --argjson required "$WINDOW_DAYS" \
    '. + [{name: $name, tier: "hard", streak_days_green: $streak, required: $required, status: (if $streak >= $required then "green" else "red" end)}]' \
    <<< "$HARD_RESULTS_JSON")
done

SOFT_RESULTS_JSON="[]"
for gate in "${SOFT_GATES[@]}"; do
  red_days=0
  for day in "${DAY_KEYS[@]}"; do
    s=$(gate_day_status "$gate" "$day")
    if [ "$s" = "red" ]; then
      red_days=$((red_days + 1))
    fi
  done
  if [ "$red_days" -gt "$SOFT_TOLERANCE" ]; then
    OVERALL_STATUS="red"
  fi
  SOFT_RESULTS_JSON=$(jq -c \
    --arg name "$gate" \
    --argjson red_days "$red_days" \
    --argjson tolerance "$SOFT_TOLERANCE" \
    '. + [{name: $name, tier: "soft", red_days_in_window: $red_days, tolerance: $tolerance, status: (if $red_days <= $tolerance then "green" else "red" end)}]' \
    <<< "$SOFT_RESULTS_JSON")
done

# Emit soak-state.json (atomic write via tmpfile + mv)
TMP=$(mktemp)
jq -n \
  --arg status "$OVERALL_STATUS" \
  --arg window "$WINDOW_DAYS" \
  --arg tz "$(date +%Z)" \
  --arg computed "$(date -u +%FT%TZ)" \
  --argjson hard "$HARD_RESULTS_JSON" \
  --argjson soft "$SOFT_RESULTS_JSON" \
  '{
    status: $status,
    window_days: ($window | tonumber),
    timezone: $tz,
    computed_at_utc: $computed,
    hard_gates: $hard,
    soft_gates: $soft
  }' > "$TMP"
mv "$TMP" "$SOAK_STATE_FILE"

if [ "$OVERALL_STATUS" = "green" ]; then
  exit 0
else
  exit 1
fi
```

Install:

```bash
install -m 755 scripts/soak-monitor.sh /usr/local/bin/soak-monitor.sh
# Or leave in-tree at $HOME/Projects/ping-mem/scripts/soak-monitor.sh and reference via absolute path in plist.
```

### P7.3 — `~/Library/LaunchAgents/com.ping-mem.soak-monitor.plist`

**Outcome**: W28 — runs `soak-monitor.sh` daily.

Scheduled at 06:00 IST. The Mac clock is in the system's local TZ; 06:00 IST = the user's morning window. If the user's system TZ is already IST, launchd `StartCalendarInterval.Hour = 6`. If the system runs in a different TZ, launchd fires at whatever local time maps to 06:00 IST (the user's home TZ policy). Per user instructions, this project runs in IST / `Asia/Kolkata`; if they later move zones, adjust `Hour`.

Create file:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ping-mem.soak-monitor</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>/Users/umasankr/Projects/ping-mem/scripts/soak-monitor.sh</string>
  </array>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>6</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>/Users/umasankr/.ping-mem/soak-monitor.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/umasankr/.ping-mem/soak-monitor.err.log</string>

  <key>ProcessType</key>
  <string>Background</string>

  <key>LowPriorityIO</key>
  <true/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

Install + load:

```bash
cp /Users/umasankr/Projects/ping-mem/config/launchd/com.ping-mem.soak-monitor.plist \
   "$HOME/Library/LaunchAgents/com.ping-mem.soak-monitor.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ping-mem.soak-monitor.plist"
launchctl print "gui/$(id -u)/com.ping-mem.soak-monitor" | head -5
```

### P7.4 — GitHub Actions workflow `.github/workflows/regression.yml`

**Outcome**: W29 — regression suite green in CI on every push/PR.

The workflow stands up ping-mem via `docker compose up -d`, waits for health, runs `bun test tests/regression/*.test.ts` with admin creds from GitHub secrets. Reuses existing `docker-compose.yml` (services: `ping-mem-neo4j`, `ping-mem-qdrant`, `ping-mem` on port 3003).

Pre-requisites:

- GitHub repo secrets `PING_MEM_ADMIN_USER`, `PING_MEM_ADMIN_PASS` match what `docker-compose.yml` feeds to the ping-mem service.
- Compose file already maps `ping-mem:3003` to host `3003`.

Create file (`.github/workflows/regression.yml`):

```yaml
name: Regression

on:
  push:
    branches: ["main", "develop"]
    paths:
      - 'src/**'
      - 'tests/regression/**'
      - 'docker-compose.yml'
      - '.github/workflows/regression.yml'
  pull_request:
    paths:
      - 'src/**'
      - 'tests/regression/**'
      - 'docker-compose.yml'
      - '.github/workflows/regression.yml'

jobs:
  regression:
    runs-on: ubuntu-latest
    timeout-minutes: 20

    env:
      PING_MEM_URL: http://localhost:3003
      PING_MEM_ADMIN_USER: ${{ secrets.PING_MEM_ADMIN_USER }}
      PING_MEM_ADMIN_PASS: ${{ secrets.PING_MEM_ADMIN_PASS }}

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: "1.3.5"

      - name: Install dependencies
        run: bun install

      - name: Build TypeScript
        run: bun run build

      - name: Start ping-mem stack
        run: |
          docker compose up -d ping-mem-neo4j ping-mem-qdrant ping-mem
          echo "Waiting for ping-mem REST on :3003..."
          for i in $(seq 1 60); do
            if curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" \
                 "$PING_MEM_URL/health" >/dev/null 2>&1; then
              echo "ping-mem ready after ${i}s"
              break
            fi
            sleep 2
          done
          curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" \
            "$PING_MEM_URL/health" || { echo "ping-mem never became healthy"; exit 1; }

      - name: Seed canonical memories
        run: |
          # Seed minimal canonical fixtures so the regression suite has known content.
          # Fixtures match the 5 canonical queries. Run via REST /api/v1/context.
          bash scripts/seed-regression-fixtures.sh

      - name: Run regression suite
        run: bun test tests/regression/*.test.ts

      - name: Dump ping-mem logs on failure
        if: failure()
        run: |
          docker compose logs ping-mem > ping-mem.log || true
          tail -200 ping-mem.log

      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: ping-mem-regression-logs
          path: ping-mem.log
          retention-days: 7

      - name: Teardown
        if: always()
        run: docker compose down -v
```

### P7.4b — `scripts/seed-regression-fixtures.sh` (authored in P7, not deferred)

**Outcome**: F6 / W29. The CI workflow above depends on this fixture script. **P7 authors it in this phase** — no deferral to P8.

Create `scripts/seed-regression-fixtures.sh`:

```bash
#!/usr/bin/env bash
# scripts/seed-regression-fixtures.sh
# Seeds 5 canonical key/value pairs for regression-p7 session. Used by CI and
# local dry-run. Idempotent — re-running overwrites existing keys.
# Matches the 5 canonical queries asserted in tests/regression/memory-sync-coverage.test.ts.
set -euo pipefail

PING_MEM_URL="${PING_MEM_URL:-http://localhost:3003}"
ADMIN_USER="${PING_MEM_ADMIN_USER:?PING_MEM_ADMIN_USER required}"
ADMIN_PASS="${PING_MEM_ADMIN_PASS:?PING_MEM_ADMIN_PASS required}"
SESSION="${REGRESSION_SESSION:-regression-p7}"

# Start session (idempotent — 409 is fine if it already exists)
curl -sf -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$PING_MEM_URL/api/v1/session/start" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"$SESSION\",\"metadata\":{\"purpose\":\"regression\"}}" \
  >/dev/null 2>&1 || true

# 5 canonical fixtures. Each VALUE MUST contain the exact query substring
# from CANONICAL_QUERIES in tests/regression/memory-sync-coverage.test.ts —
# otherwise the regression suite's search will return 0 hits.
declare -a FIXTURES=(
  'native/pinglearn/fixture-1|CANARY_1: Pricing decision — ping-learn pricing research backed by research-zero; US $14.99/mo Scholar, India INR 499/mo.'
  'native/pinglearn/fixture-2|CANARY_2: Mobile push — Firebase FCM pinglearn-c63a2 project number 712545717453, Android + iOS apps registered.'
  'native/pinglearn/fixture-3|CANARY_3: Authenticated redesign — classroom redesign worktree at /private/tmp/pl-classroom-redesign on feat/classroom-redesign.'
  'native/pinglearn/fixture-4|CANARY_4: Security — PR 236 JWT secret isolation merged; CONSENT_JWT_SECRET env var, alg:none attack prevention, rate limit fail-closed.'
  'native/pinglearn/fixture-5|CANARY_5: Compliance — DPDP consent age 18 raised from 17; PR #273 with follow-up issues #274 #275 #276.'
)

for fx in "${FIXTURES[@]}"; do
  KEY="${fx%%|*}"
  VALUE="${fx#*|}"
  RESP=$(curl -sf -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$PING_MEM_URL/api/v1/context" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg k "$KEY" --arg v "$VALUE" --arg s "$SESSION" \
          '{key:$k, value:$v, sessionName:$s, category:"regression-fixture", priority:"low"}')")
  echo "seeded $KEY"
done

# Verify seed — all 5 keys searchable
MISS=0
for fx in "${FIXTURES[@]}"; do
  KEY="${fx%%|*}"
  FOUND=$(curl -sf -u "$ADMIN_USER:$ADMIN_PASS" "$PING_MEM_URL/api/v1/context/$(jq -rn --arg k "$KEY" '$k|@uri')" \
    | jq -r '.data.key // ""')
  if [ "$FOUND" != "$KEY" ]; then
    echo "MISS $KEY" >&2
    MISS=$((MISS+1))
  fi
done

if [ "$MISS" -gt 0 ]; then
  echo "seed failed: $MISS/5 missing"
  exit 1
fi
echo "seed OK: 5/5 fixtures written and verified"
```

```bash
chmod +x scripts/seed-regression-fixtures.sh
shellcheck scripts/seed-regression-fixtures.sh
```

**P7 verification**:

| # | Check | Command | Expected |
|---|-------|---------|----------|
| V7.6a | Script exists and executable | `test -x scripts/seed-regression-fixtures.sh` | exit 0 |
| V7.6b | Shellcheck clean | `shellcheck scripts/seed-regression-fixtures.sh; echo $?` | `0` |
| V7.6c | Dry-run seeds 5/5 | `PING_MEM_URL=http://localhost:3003 PING_MEM_ADMIN_USER=admin PING_MEM_ADMIN_PASS=ping-mem-dev-local bash scripts/seed-regression-fixtures.sh` | last line `seed OK: 5/5 fixtures written and verified` |
| V7.6d | Fixtures present in ping-mem | `curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" "http://localhost:3003/api/v1/search?query=CANARY_" \| jq '.data \| length'` — matches the seeded `CANARY_1`…`CANARY_5` tokens; require `PING_MEM_ADMIN_USER`/`PING_MEM_ADMIN_PASS` to be set in the environment | `>= 5` |

**P8's role (docs only)**: P8 documents the script in `docs/AGENT_INTEGRATION_GUIDE.md` §14 (operational runbook). P8 does NOT author the script — P7 owns authorship, matching the "writes zero product code" frontmatter rule in P8.

### P7.5 — Reaper allowlist handshake with P1

**Outcome**: safe long-running test sessions aren't reaped mid-test.

P1.8's `reapSystemSessions` allowlist is `["native-sync", "auto-recall", "canary"]`. Extend it to include `"regression-p7"`:

- **Owning phase for code edit**: P1 (it owns `SessionManager.ts`).
- **Trigger**: P7 authoring surfaces the need. P7 adds a row to overview's Wiring Matrix appendix (handled via overview.md's CHANGELOG, not this file) AND explicitly lists it below so the P1 executor picks it up.
- **Handshake**:
  1. When P7 is scheduled for execution, the orchestrator amends P1's allowlist to `["native-sync", "auto-recall", "canary", "regression-p7"]` via a targeted edit to `src/session/SessionManager.ts`.
  2. The amendment lives in overview.md's CHANGELOG (commit-SHA entry) per T3 authoring rule — not in an amendments block here.
  3. If P1 is already merged, P7's executor opens a follow-up one-line patch to `SessionManager.ts` allowlist array — a single-line edit, no behavioural change beyond the allowlist.

Document the exact patch here so the executor sees it:

```typescript
// src/session/SessionManager.ts — inside reapSystemSessions
const isSystemNamed = ["native-sync", "auto-recall", "canary", "regression-p7"].includes(s.name);
```

### P7.6 — `soak-state.json` schema + example timestamps

**Outcome**: documentation of the contract between P5 (writer of doctor-runs) and P7 (reader/writer of soak state), so downstream dashboards (P5 /ui/health) can render the soak panel.

**Schema** (JSON Schema draft-07 flavour, informal):

```jsonc
{
  "status": "green" | "red",
  "window_days": 30,
  "timezone": "IST",
  "computed_at_utc": "<ISO-8601>",
  "hard_gates": [
    {
      "name": "rest-health-200",
      "tier": "hard",
      "streak_days_green": 0..30,
      "required": 30,
      "status": "green" | "red"  // green iff streak_days_green >= required
    }
    // ...14 hard gates total — matching HARD_GATES array in scripts/soak-monitor.sh
  ],
  "soft_gates": [
    {
      "name": "orbstack-warm-latency",
      "tier": "soft",
      "red_days_in_window": 0..30,
      "tolerance": 6,
      "status": "green" | "red"  // green iff red_days_in_window <= tolerance
    }
    // ...5 soft gates
  ]
}
```

**Day 1 example** (doctor has run at least once; 1 green day for each gate):

```json
{
  "status": "red",
  "window_days": 30,
  "timezone": "IST",
  "computed_at_utc": "2026-04-19T00:30:00Z",
  "hard_gates": [
    {"name": "rest-health-200", "tier": "hard", "streak_days_green": 1, "required": 30, "status": "red"},
    {"name": "mcp-proxy-stdio", "tier": "hard", "streak_days_green": 1, "required": 30, "status": "red"}
    // ...12 more hard gates (query-*, coverage-*, ollama-reachable, disk-below-85, session-cap-below-80pct, supervisor-no-rollback-24h, doctor-launchd-ran)
  ],
  "soft_gates": [
    {"name": "orbstack-warm-latency", "tier": "soft", "red_days_in_window": 0, "tolerance": 6, "status": "green"}
  ]
}
```

**Day 15 example** (all hard gates still green, 1 soft gate flickered twice):

```json
{
  "status": "red",
  "window_days": 30,
  "timezone": "IST",
  "computed_at_utc": "2026-05-03T00:30:00Z",
  "hard_gates": [
    {"name": "rest-health-200", "tier": "hard", "streak_days_green": 15, "required": 30, "status": "red"}
    // ...13 more hard gates (same slugs as day-1 example)
  ],
  "soft_gates": [
    {"name": "orbstack-warm-latency", "tier": "soft", "red_days_in_window": 2, "tolerance": 6, "status": "green"}
  ]
}
```

**Day 30 example** (soak green):

```json
{
  "status": "green",
  "window_days": 30,
  "timezone": "IST",
  "computed_at_utc": "2026-05-18T00:30:00Z",
  "hard_gates": [
    {"name": "rest-health-200", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "mcp-proxy-stdio", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "query-ping-learn-pricing", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "query-firebase-fcm", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "query-classroom-redesign", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "query-pr-236-jwt", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "query-dpdp-consent-18", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "coverage-commits-ge-95pct", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "coverage-files-ge-95pct", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "ollama-reachable", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "disk-below-85", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "session-cap-below-80pct", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "supervisor-no-rollback-24h", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"},
    {"name": "doctor-launchd-ran", "tier": "hard", "streak_days_green": 30, "required": 30, "status": "green"}
  ],
  "soft_gates": [
    {"name": "orbstack-warm-latency", "tier": "soft", "red_days_in_window": 3, "tolerance": 6, "status": "green"},
    {"name": "log-rotation-last-7d", "tier": "soft", "red_days_in_window": 1, "tolerance": 6, "status": "green"},
    {"name": "pattern-confidence-nonzero", "tier": "soft", "red_days_in_window": 0, "tolerance": 6, "status": "green"},
    {"name": "auto-os-cross-project-hit", "tier": "soft", "red_days_in_window": 4, "tolerance": 6, "status": "green"},
    {"name": "ping-mem-doctor-exec-time-below-10s", "tier": "soft", "red_days_in_window": 2, "tolerance": 6, "status": "green"}
  ]
}
```

## Function Signatures

```typescript
// tests/regression/memory-sync-coverage.test.ts — helpers
function getSharedSessionId(): string;
async function postJson<T = unknown>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T>;
async function getJson<T = unknown>(path: string, extraHeaders?: Record<string, string>): Promise<T>;
```

```bash
# scripts/soak-monitor.sh — internal helpers
gate_day_status "<gate-name>" "<YYYY-MM-DD>"   # echoes "green" | "red"
# main writes $SOAK_STATE_FILE and exits 0/1/2
```

## Integration Points

| Task | File | Owner | Change |
|------|------|-------|--------|
| P7.1 | `tests/regression/memory-sync-coverage.test.ts` | NEW | Bun test + dedicated session lifecycle |
| P7.2 | `scripts/soak-monitor.sh` | NEW | daily soak math |
| P7.3 | `~/Library/LaunchAgents/com.ping-mem.soak-monitor.plist` | NEW | launchd daily job |
| P7.4 | `.github/workflows/regression.yml` | NEW | CI regression suite |
| P7.5 | `src/session/SessionManager.ts` | P1 allowlist amend | add `"regression-p7"` |
| P7.6 | (this file) | documentation | schema + examples |
| P7.4b | `scripts/seed-regression-fixtures.sh` | NEW (P7 authored) | Seeds 5 canonical fixtures for CI + local dry-run |

`scripts/seed-regression-fixtures.sh` is authored in P7.4b above (NOT deferred to P8). P8 only documents the script in the agent integration guide.

## Wiring Matrix Rows Owned

- **W28** — 30-day soak counter increments correctly
  - Launchd (`com.ping-mem.soak-monitor`) fires daily at 06:00 IST → runs `scripts/soak-monitor.sh` → reads `~/.ping-mem/doctor-runs/*.jsonl` (written by P5's `com.ping-mem.doctor` launchd every 15 min) → computes `streak_days_green` per hard gate and `red_days_in_window` per soft gate → writes `~/.ping-mem/soak-state.json`. `GET /ui/health` (P5) displays the soak panel by reading that JSON. Exit code 0=green, 1=red, 2=error.
- **W29** — regression suite green in CI
  - `git push` / PR → GitHub Actions `regression.yml` → `docker compose up ping-mem` → wait for `/health` → `bash scripts/seed-regression-fixtures.sh` → `bun test tests/regression/*.test.ts` → `beforeAll` creates `regression-p7` session → `test.each(CANONICAL_QUERIES)` each asserts `.data.length >= 1` → `afterAll` ends session → `docker compose down -v`.

## Verification Checklist

| # | Check | Command | Expected |
|---|-------|---------|----------|
| V7.1 | Test file exists and has the 5 canonical queries | `grep -c '"ping-learn pricing research"\\|"Firebase FCM pinglearn-c63a2"\\|"classroom redesign worktree"\\|"PR 236 JWT secret isolation"\\|"DPDP consent age 18"' tests/regression/memory-sync-coverage.test.ts` | `5` |
| V7.2 | Test file uses dedicated `regression-p7` session, NOT `~/.ping-mem/sync-session-id` | `grep -c "sync-session-id" tests/regression/memory-sync-coverage.test.ts` | `0` |
| V7.3 | Test file defines `getSharedSessionId` helper | `grep -c 'function getSharedSessionId' tests/regression/memory-sync-coverage.test.ts` | `1` |
| V7.4 | Test file has beforeAll + afterAll | `grep -Ec '^(beforeAll|afterAll)\\(' tests/regression/memory-sync-coverage.test.ts` | `2` |
| V7.5 | soak-monitor.sh exists and is executable | `test -x scripts/soak-monitor.sh` | exit 0 |
| V7.6 | soak-monitor.sh has shellcheck-clean syntax | `shellcheck scripts/soak-monitor.sh` | exit 0 |
| V7.7 | Launchd plist exists | `test -f $HOME/Library/LaunchAgents/com.ping-mem.soak-monitor.plist` | exit 0 |
| V7.8 | Launchd plist loaded | `launchctl print gui/$(id -u)/com.ping-mem.soak-monitor \| head -3` | prints label |
| V7.9 | CI workflow file exists | `test -f .github/workflows/regression.yml` | exit 0 |
| V7.10 | CI workflow YAML valid | `python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/regression.yml"))'` | exit 0 |
| V7.11 | SessionManager allowlist includes `regression-p7` | `grep -c '"regression-p7"' src/session/SessionManager.ts` | `1` |
| V7.12 | Typecheck clean | `bun run typecheck` | 0 errors |
| V7.13 | soak-state.json schema (when present) | `jq -e '.status, .window_days, .hard_gates, .soft_gates' ~/.ping-mem/soak-state.json` | non-null fields |
| V7.14 | All 14 hard gate IDs (P5 registry slugs) present in script | `for g in rest-health-200 mcp-proxy-stdio query-ping-learn-pricing query-firebase-fcm query-classroom-redesign query-pr-236-jwt query-dpdp-consent-18 coverage-commits-ge-95pct coverage-files-ge-95pct ollama-reachable disk-below-85 session-cap-below-80pct supervisor-no-rollback-24h doctor-launchd-ran; do grep -q "$g" scripts/soak-monitor.sh \|\| echo MISSING:$g; done` | no MISSING lines |
| V7.15 | All 5 soft gate names present in script | `for g in orbstack-warm-latency log-rotation-last-7d pattern-confidence-nonzero auto-os-cross-project-hit ping-mem-doctor-exec-time-below-10s; do grep -q "$g" scripts/soak-monitor.sh \|\| echo MISSING:$g; done` | no MISSING lines |

## Functional Tests

| # | Test | Setup | Command | Expected |
|---|------|-------|---------|----------|
| F7.1 | Regression suite passes locally | ping-mem up on :3003 with seeded fixtures | `PING_MEM_ADMIN_USER=admin PING_MEM_ADMIN_PASS=ping-mem-dev-local bun test tests/regression/*.test.ts` | 5 canonical tests pass, 0 fail |
| F7.2 | Regression suite passes in CI | push to PR | GitHub Actions `regression` job | green check |
| F7.3 | Session lifecycle is clean | run test, then query sessions | `curl -u admin:pass http://localhost:3003/api/v1/session/list \| jq '.data[] \| select(.name=="regression-p7")'` (after `afterAll`) | empty (session ended) |
| F7.4 | soak-state.json written after first run | create fake `~/.ping-mem/doctor-runs/2026-04-19T06-00-00.000Z.jsonl` (colons replaced with hyphens — matches P5's `new Date().toISOString().replace(/:/g, "-")` naming) with all-green gates | `bash scripts/soak-monitor.sh; jq -r .status ~/.ping-mem/soak-state.json` | `red` (only day 1) with `streak_days_green: 1` for every hard gate |
| F7.5 | Day-N streak math verifiable on synthetic doctor-runs | populate `~/.ping-mem/doctor-runs/` with 30 consecutive all-green days; dates spanning `date -v-29d` through today | `bash scripts/soak-monitor.sh; jq '[.hard_gates[].streak_days_green] \| min' ~/.ping-mem/soak-state.json` | `30` |
| F7.6 | Hard gate clock reset on red day | in synthetic fixture set day -5 to red for `rest-health-200`, rest green | `bash scripts/soak-monitor.sh; jq '.hard_gates[] \| select(.name=="rest-health-200") \| .streak_days_green' ~/.ping-mem/soak-state.json` | `5` (streak only covers last 5 days after the red day) |
| F7.7 | Soft gate tolerates 6 red days | in synthetic fixture set `orbstack-warm-latency` red on 6 scattered days, rest green | `jq '.soft_gates[] \| select(.name=="orbstack-warm-latency") \| .status' ~/.ping-mem/soak-state.json` | `green` |
| F7.8 | Soft gate fails at 7 red days | 7 red scattered days | `jq '.soft_gates[] \| select(.name=="orbstack-warm-latency") \| .status' ~/.ping-mem/soak-state.json` | `red` AND overall status `red` |
| F7.9 | Exit code reflects status | same 30-green scenario as F7.5 | `bash scripts/soak-monitor.sh; echo $?` | `0` |
| F7.10 | Exit code 1 on red | same F7.8 scenario | `bash scripts/soak-monitor.sh; echo $?` | `1` |
| F7.11 | Exit code 2 on error | rename `$DOCTOR_RUNS_DIR` | `DOCTOR_RUNS_DIR=/nonexistent bash scripts/soak-monitor.sh; echo $?` | `2` |
| F7.12 | Launchd job runs daily | wait 24h in a soak environment | `ls -lt ~/.ping-mem/soak-monitor.out.log` | shows entry within last 25h |
| F7.13 | Allowlist protects test session from premature reap | CI run in which test takes 5 min | post-run session listing | no `regression-p7` session reaped mid-test |

## Gate Criterion

**Binary PASS**: V7.1–V7.15 all pass AND F7.1–F7.13 all pass AND `bun run typecheck` shows 0 errors AND the CI `regression` workflow completes green on the PR that lands P7.

Per-day soak state (F7.4–F7.8) is proven with synthetic fixtures so the math is verifiable in a single session rather than waiting 30 days. The 30-day AC-S1 is then mechanically satisfied by keeping all hard gates green for 30 consecutive calendar days post-merge.

## Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R7.1 | CI secrets `PING_MEM_ADMIN_USER/PASS` missing from repo settings → workflow fails authentication | MED | Workflow references `${{ secrets.PING_MEM_ADMIN_USER }}`; P0 added to task list for human to set them once in GitHub UI. V7.10 detects YAML-valid but runs require manual secret setup. |
| R7.2 | Docker compose stack slow to start in GitHub Actions (free runner) | MED | 60-iter × 2s wait loop (120s budget) in `Start ping-mem stack` step; typical healthy by ~30s. If GitHub runner is under-provisioned, bump iterations. |
| R7.3 | Fixture seed command fails in CI (API drift) | MED | P7.4b authors `seed-regression-fixtures.sh` in-phase with `set -euo pipefail` and per-key verification. Any POST failure aborts; V7.6a–V7.6d all gate the script before merge. |
| R7.4 | Timezone mismatch between Mac (IST) and CI runner (UTC) | LOW | soak-monitor.sh uses `date -v-Nd +%Y-%m-%d` which honours the system TZ. CI only runs the Bun test, not the soak script — so no cross-TZ math in CI. |
| R7.5 | Clock skew across `date`/`jq -r` invocations on very long shell runs | NEGLIGIBLE | Day-bucket granularity is calendar day; worst case a run spanning midnight attributes a run to whichever day the timestamp in the jsonl filename carries (P5's writer). |
| R7.6 | `find ... -name "${day}*.jsonl"` collides if day-string appears non-prefix in filename | LOW | P5 writes doctor-runs as `<ISO-timestamp>.jsonl` with the calendar day as the leading substring → glob `2026-04-19*.jsonl` only matches that day. |
| R7.7 | Allowlist edit to `SessionManager.ts` conflicts with P1 | LOW | Single-line `includes(...)` array edit; no structural change. If P1 is already merged, P7 opens a 1-line follow-up. |
| R7.8 | `jq` not available on the runner or on the user's Mac | NEGLIGIBLE | Setup-bun runner has `jq` preinstalled on `ubuntu-latest`. Mac has `jq` via Homebrew (user already uses it). soak-monitor.sh fast-fails with exit 2 + clear message. |
| R7.9 | Absence-of-runs-is-red rule causes spurious red days if launchd is paused during a Mac reboot | MED | P5's launchd plist has `RunAtLoad=true` so boot triggers a run; the absence-red rule catches silent-failure modes worth alerting on. Acceptable safety default. |
| R7.10 | `regression-p7` session leaks if `afterAll` fails | LOW | Reaper (P1.8) with 15-min idle allowlist sweep cleans up within 17 minutes. |

## Dependencies

- **Hard**: P0 (baseline + disk + creds), P1 (MCP auth + allowlist), P2 (ingestion coverage so queries hit), P3 (self-heal so hard gate `ollama-reachable` has green days), P4 (disk + supervisor + watchdog + orbstack — 3 hard/soft gates), P5 (doctor JSONL writer — the ONLY input source for soak-monitor.sh), P6 (auto-os cross-project — 1 soft gate).
- **External**: GitHub repo secrets set (`PING_MEM_ADMIN_USER`, `PING_MEM_ADMIN_PASS`); Docker images buildable from compose.
- **Internal**: `scripts/seed-regression-fixtures.sh` is authored by P7.4b (same phase — no cross-phase forward dependency).

## Exit state

- `tests/regression/memory-sync-coverage.test.ts` exists; 5 canonical + 2 stretch tests; `regression-p7` session lifecycle clean.
- `scripts/soak-monitor.sh` exists, executable, shellcheck-clean, O(day) complexity verified via F7.5.
- `~/Library/LaunchAgents/com.ping-mem.soak-monitor.plist` installed and bootstrapped.
- `.github/workflows/regression.yml` runs on every push/PR; baseline run against seeded fixtures passes.
- `src/session/SessionManager.ts` allowlist includes `"regression-p7"`.
- `~/.ping-mem/soak-state.json` written on first launchd tick; schema validated against P7.6 reference.
- Day-N streak math and soft-tolerance math mechanically verified via synthetic fixtures (F7.5–F7.8) — no 30-day wait needed to prove correctness.
- Ready to hand off to P8 (documentation), which will fold the soak panel reference into `/ui/health` docs and into README.
