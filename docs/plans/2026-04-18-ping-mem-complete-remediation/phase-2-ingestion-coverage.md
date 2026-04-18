---
phase-id: P2
title: "Ingestion coverage — ≥95% commit + file coverage across 5 active projects"
status: pending
effort_estimate: 4h
dependent-on: phase-0-prep
owns_wiring: [W7, W8, W9]
owns_outcomes: [O4]
blocks:
  - P5 doctor coverage gates (W23)
  - P7 soak regression on ingestion gate (W28)
date: 2026-04-18
eval_iteration: 0
review_iteration: 0
verification_iteration: 0
---

# Phase 2 — Ingestion Coverage

**Owns**: Gap rows C.1, C.2, C.3 (overview.md §Gap Coverage Matrix).
**Delivers**: Outcome **O4** (≥95% commit + ≥95% file coverage for 5 active projects).
**Wiring rows**: **W7** (ping-learn ≥95%), **W8** (5 projects ≥95%), **W9** (idempotent re-ingest).
**C.4 note**: The coverage canary itself is owned by P5 (W23). This phase only guarantees the upstream signal — the schema shape returned by `GET /api/v1/codebase/projects` — which P5's doctor gate depends on.

---

## 1. Phase Goal

Raise ingestion coverage from the 2026-04-18 baseline (ping-learn: 133/653 commits = 20.4 %, 1360/2314 files = 58.8 %) to ≥95 % on both axes across the five active projects (**ping-learn, ping-mem, auto-os, ping-guard, thrivetree**), and make re-ingest idempotent (second run finishes <30 s when tree hash is unchanged).

**Root causes attacked** (overview.md §Problem Statement row 6):

1. `GitHistoryReader.ts:61` hard-caps commits at 200 — caller-supplied `maxCommits` never reaches here when the API caller omits it.
2. `IngestionService.ts:129` defaults `maxCommitAgeDays=30` and emits an info log even when caller omits the field — silently drops all commits older than 30 days.
3. `ProjectScanner.ts:48,74-76` excludes `docs` directory and `.md`, `.jsonl`, `.csv`, `.log`, `.sh`, `.bat` extensions — for an app with heavy docs/scripts (ping-learn), this alone accounts for most of the 41 % file gap.
4. `scripts/reingest-active-projects.sh` does not yet exist — there is no single-command way to force-reingest all five projects.
5. `scripts/verify-ingestion-coverage.sh` does not yet exist — there is no deterministic verifier of coverage %.

**Non-goals** (explicitly not in Phase 2):

- Coverage canary gate in doctor — P5 owns W23.
- launchd plist creation — P0 owns the prep; this phase only verifies that the existing `com.ping-mem.periodic-ingest` plist (if present) covers the 5 projects. If missing, flag to P0/P4 — do not create here.
- Changes to the ingestion chunker, Neo4j graph, Qdrant schema — out of scope.

---

## 2. Pre-conditions (must be true before P2.1 runs)

| # | Condition | Verification command | Required result |
|---|-----------|----------------------|-----------------|
| pre.1 | Phase 0 completed | `cat /tmp/ping-mem-remediation-baseline.json \| jq '.phase0.complete'` | `true` |
| pre.2 | Baseline coverage snapshot captured by P0 | `jq '.baseline.coverage \| keys' /tmp/ping-mem-remediation-baseline.json` | includes `ping-learn`, `ping-mem`, `auto-os`, `ping-guard`, `thrivetree` |
| pre.3 | Disk <85 % | `df -P /System/Volumes/Data \| awk 'NR==2 {sub(/%/,"",$5); exit ($5<85?0:1)}'` | exit 0 |
| pre.4 | ping-mem typecheck clean | `cd ~/Projects/ping-mem && bun run typecheck 2>&1 \| tail -1` | `Found 0 errors` |
| pre.5 | ping-mem REST reachable | `curl -sf http://localhost:3003/health \| jq -r '.status'` | `ok` |
| pre.6 | Neo4j + Qdrant up | `curl -sf http://localhost:7474 >/dev/null && curl -sf http://localhost:6333/collections >/dev/null` | exit 0 |
| pre.7 | Ingestion queue configured | `curl -sf -u admin:ping-mem-dev-local http://localhost:3003/api/v1/ingestion/queue \| jq '.maxConcurrent'` | non-null integer |

If any pre-condition fails → do **not** start Phase 2; escalate to orchestrator.

---

## 3. Tasks

### P2.1 — Patch ingestion defaults (BOTH files, NOT just the comment)

**Judge finding A-HIGH-2 (3-judge consensus)**: `IngestionService.ts:46` is a COMMENT only. The runtime default lives in `GitHistoryReader.ts:61`. Patching only one leaves runtime unchanged. All three files below must be touched.

#### P2.1.a — `src/ingest/GitHistoryReader.ts:61` (runtime default for commits)

Old (line 61):

```ts
const maxCommits = options?.maxCommits ?? 200;
```

New (lines 61-66):

```ts
// When caller omits maxCommits we default to 10_000 (effectively "all commits" for every
// active project on 2026-04-18; largest is ping-learn at 653). Override via env
// PING_MEM_MAX_COMMITS for one-off narrow runs. `undefined`/`0` is treated as unset.
const envCap = process.env.PING_MEM_MAX_COMMITS
  ? parseInt(process.env.PING_MEM_MAX_COMMITS, 10)
  : undefined;
const maxCommits = options?.maxCommits ?? (Number.isFinite(envCap) && (envCap as number) > 0 ? (envCap as number) : 10_000);
```

Rationale: the HTTP handler at `rest-server.ts:1286-1288` already propagates caller-supplied `maxCommits` when provided; the fix here is the default when the caller omits it.

#### P2.1.b — `src/ingest/IngestionService.ts:46` (comment — keep docs and code honest)

Old:

```ts
  maxCommits?: number; // Max git commits to ingest (default 200)
```

New:

```ts
  maxCommits?: number; // Max git commits to ingest (default: env PING_MEM_MAX_COMMITS || 10000 — effectively "all commits" for active projects)
```

#### P2.1.c — `src/ingest/IngestionService.ts:129-132` (age default)

Old (lines 129-132):

```ts
    ingestOptions.maxCommitAgeDays = options.maxCommitAgeDays ?? 30;
    if (options.maxCommitAgeDays === undefined) {
      log.info("maxCommitAgeDays not specified — defaulting to 30 days (older commits will not be ingested)");
    }
```

New (lines 129-137):

```ts
    // When caller omits maxCommitAgeDays we ingest the full history (no date cut-off).
    // Override via env PING_MEM_MAX_COMMIT_AGE_DAYS for date-bounded runs. 0/undefined
    // env => unbounded (undefined passed through to GitHistoryReader so `since` is not set).
    const envAge = process.env.PING_MEM_MAX_COMMIT_AGE_DAYS
      ? parseInt(process.env.PING_MEM_MAX_COMMIT_AGE_DAYS, 10)
      : undefined;
    const effectiveAge = options.maxCommitAgeDays ?? (Number.isFinite(envAge) && (envAge as number) > 0 ? (envAge as number) : undefined);
    if (effectiveAge !== undefined) {
      ingestOptions.maxCommitAgeDays = effectiveAge;
    }
    // else: leave undefined → GitHistoryReader.ts:62-64 omits `since` → full history
```

**Verification that Reader handles undefined correctly** — `GitHistoryReader.ts:62-64` already has:

```ts
const since = options?.maxCommitAgeDays
  ? `${options.maxCommitAgeDays} days ago`
  : undefined;
```

So passing `undefined` through is safe and produces `git log` without `--since`.

#### P2.1.d — Env var docs

Append to `README.md` under **Configuration** (append-only — do not rewrite existing config docs):

```
| PING_MEM_MAX_COMMITS         | 10000    | Per-run commit cap when the ingestion API caller omits `maxCommits`. |
| PING_MEM_MAX_COMMIT_AGE_DAYS | (unset)  | Commit age cut-off in days when the caller omits `maxCommitAgeDays`. Unset = full history. |
```

#### P2.1.e — Quality gate after patch

```bash
cd ~/Projects/ping-mem && bun run typecheck && bun run lint && bun test src/ingest/ 2>&1 | tail -5
```

All three must pass (0 errors, 0 warnings, green tests). Restart the REST daemon so the new defaults take effect:

```bash
launchctl kickstart -k gui/"$(id -u)"/com.ping-mem.rest
```

---

### P2.2 — `scripts/reingest-active-projects.sh` (force re-ingest all 5 projects, async enqueue + poll)

**Judge finding SS4 (GPT-5.4 MEDIUM)**: `POST /api/v1/ingestion/enqueue` returns HTTP 202 `{runId}` (`rest-server.ts:1292-1293`). The verify script must NOT fire coverage checks against a queue that has not drained. Capture `runId`, poll `GET /api/v1/ingestion/run/:runId` until `status ∈ {completed, failed}` or timeout, THEN run verification.

Write to `scripts/reingest-active-projects.sh` (new file, `chmod +x`):

```bash
#!/usr/bin/env bash
# Re-ingest the 5 active projects into ping-mem.
# Uses async enqueue (POST /ingestion/enqueue → 202 {runId}) + poll (GET /ingestion/run/:runId)
# until status ∈ {completed, failed}. Timeout: 1500 s (25 min) per project.
# Idempotent: caller controls --force (default: do not force).
set -euo pipefail

REST_URL="${PING_MEM_REST_URL:-http://localhost:3003}"
AUTH="${PING_MEM_ADMIN_USER:-admin}:${PING_MEM_ADMIN_PASS:-ping-mem-dev-local}"
FORCE="${FORCE:-true}"  # this script's default is force=true — full re-ingest
TIMEOUT_S="${TIMEOUT_S:-1500}"
POLL_S=5

PROJECTS=(
  "$HOME/Projects/ping-learn"
  "$HOME/Projects/ping-mem"
  "$HOME/Projects/auto-os"
  "$HOME/Projects/ping-guard"
  "$HOME/Projects/thrivetree"
)

OUT_DIR="${OUT_DIR:-/tmp/ping-mem-reingest-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"
RUN_LOG="$OUT_DIR/run-log.jsonl"

enqueue() {
  local dir="$1"
  curl -sfS -u "$AUTH" -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"projectDir\":\"${dir}\",\"forceReingest\":${FORCE}}" \
    "$REST_URL/api/v1/ingestion/enqueue"
}

poll() {
  local run_id="$1"
  local started_at
  started_at="$(date +%s)"
  while true; do
    local body status
    body="$(curl -sfS -u "$AUTH" "$REST_URL/api/v1/ingestion/run/${run_id}")"
    status="$(echo "$body" | jq -r '.status // "unknown"')"
    case "$status" in
      completed) echo "$body"; return 0 ;;
      failed)    echo "$body"; return 2 ;;
    esac
    local now elapsed
    now="$(date +%s)"
    elapsed=$((now - started_at))
    if (( elapsed > TIMEOUT_S )); then
      echo "{\"status\":\"timeout\",\"runId\":\"${run_id}\",\"elapsedS\":${elapsed}}"
      return 3
    fi
    sleep "$POLL_S"
  done
}

overall_rc=0
for dir in "${PROJECTS[@]}"; do
  if [[ ! -d "$dir/.git" ]]; then
    echo "SKIP $dir (not a git repo)" | tee -a "$RUN_LOG"
    continue
  fi
  echo "ENQUEUE $dir" | tee -a "$RUN_LOG"
  enq="$(enqueue "$dir")"
  run_id="$(echo "$enq" | jq -r '.runId // empty')"
  if [[ -z "$run_id" ]]; then
    echo "{\"projectDir\":\"$dir\",\"enqueue\":$enq,\"result\":\"enqueue-failed\"}" | tee -a "$RUN_LOG"
    overall_rc=1
    continue
  fi
  echo "POLL $run_id ($dir)" | tee -a "$RUN_LOG"
  t0="$(date +%s)"
  if result="$(poll "$run_id")"; then
    t1="$(date +%s)"
    dur=$((t1 - t0))
    echo "{\"projectDir\":\"$dir\",\"runId\":\"$run_id\",\"durationS\":$dur,\"result\":$result}" | tee -a "$RUN_LOG"
  else
    rc=$?
    echo "{\"projectDir\":\"$dir\",\"runId\":\"$run_id\",\"poll_rc\":$rc,\"result\":\"failed-or-timeout\"}" | tee -a "$RUN_LOG"
    overall_rc=1
  fi
done

echo "Run log: $RUN_LOG"
exit "$overall_rc"
```

Runtime expectation (time budget dry-run — see P2.3):
- ping-learn: 15-25 min (largest; 653 commits + 2314 files)
- ping-mem, auto-os, ping-guard, thrivetree: 2-8 min each
- Total for first (forced) run: ~35-55 min sequential. Acceptable given this only runs once per remediation; doctor periodic ingest is per-project and capped by the launchd cadence (P0/P4-owned).

---

### P2.3 — `scripts/verify-ingestion-coverage.sh` (baseline vs current, per-project + overall)

Write to `scripts/verify-ingestion-coverage.sh` (new file, `chmod +x`):

```bash
#!/usr/bin/env bash
# Verify ≥95% commit and ≥95% file coverage for the 5 active projects.
# Requires P0 baseline at /tmp/ping-mem-remediation-baseline.json with shape:
#   { "baseline": { "coverage": { "<projectKey>": {"gitCommits": N, "gitFiles": M, "projectId": "..."}}}}
# Reports per-project and overall; exits non-zero on any <95% axis.
set -euo pipefail

REST_URL="${PING_MEM_REST_URL:-http://localhost:3003}"
AUTH="${PING_MEM_ADMIN_USER:-admin}:${PING_MEM_ADMIN_PASS:-ping-mem-dev-local}"
BASELINE="${BASELINE:-/tmp/ping-mem-remediation-baseline.json}"
THRESHOLD="${THRESHOLD:-95}"
OUT_JSON="${OUT_JSON:-/tmp/ping-mem-coverage-$(date +%Y%m%d-%H%M%S).json}"

[[ -f "$BASELINE" ]] || { echo "ERROR: baseline file missing at $BASELINE (P0 must run first)" >&2; exit 2; }

projects_json="$(curl -sfS -u "$AUTH" "$REST_URL/api/v1/codebase/projects?limit=100")"

fail=0
echo "[" > "$OUT_JSON.tmp"
first=1
for key in ping-learn ping-mem auto-os ping-guard thrivetree; do
  b_commits="$(jq -r ".baseline.coverage[\"$key\"].gitCommits // 0" "$BASELINE")"
  b_files="$(jq -r   ".baseline.coverage[\"$key\"].gitFiles   // 0" "$BASELINE")"
  b_projectId="$(jq -r ".baseline.coverage[\"$key\"].projectId // empty" "$BASELINE")"
  # Prefer match by projectId; fall back to rootPath basename if projectId is absent
  if [[ -n "$b_projectId" ]]; then
    row="$(echo "$projects_json" | jq --arg pid "$b_projectId" '.data.projects[] | select(.projectId==$pid)')"
  else
    row="$(echo "$projects_json" | jq --arg name "$key" '.data.projects[] | select(.rootPath | test("/" + $name + "$"))')"
  fi
  c_commits="$(echo "${row:-null}" | jq -r '.commitsCount // 0')"
  c_files="$(echo   "${row:-null}" | jq -r '.filesCount   // 0')"
  pct_commits="$(awk -v c="$c_commits" -v b="$b_commits" 'BEGIN{ printf "%.2f", (b>0?(c/b)*100:0) }')"
  pct_files="$(awk   -v c="$c_files"   -v b="$b_files"   'BEGIN{ printf "%.2f", (b>0?(c/b)*100:0) }')"
  ok_c=$(awk -v p="$pct_commits" -v t="$THRESHOLD" 'BEGIN{exit !(p+0>=t+0)}' && echo 1 || echo 0)
  ok_f=$(awk -v p="$pct_files"   -v t="$THRESHOLD" 'BEGIN{exit !(p+0>=t+0)}' && echo 1 || echo 0)
  if [[ "$ok_c" = "0" || "$ok_f" = "0" ]]; then fail=1; fi
  [[ $first -eq 0 ]] && echo "," >> "$OUT_JSON.tmp"; first=0
  cat >> "$OUT_JSON.tmp" <<JSON
  {"project":"$key","baselineCommits":$b_commits,"currentCommits":$c_commits,"pctCommits":$pct_commits,
   "baselineFiles":$b_files,"currentFiles":$c_files,"pctFiles":$pct_files,
   "okCommits":$ok_c,"okFiles":$ok_f}
JSON
  printf '%-12s commits: %5d/%5d (%6s%%) files: %5d/%5d (%6s%%) %s\n' \
    "$key" "$c_commits" "$b_commits" "$pct_commits" "$c_files" "$b_files" "$pct_files" \
    "$([[ $ok_c = 1 && $ok_f = 1 ]] && echo OK || echo FAIL)"
done
echo "]" >> "$OUT_JSON.tmp"
mv "$OUT_JSON.tmp" "$OUT_JSON"
echo "Coverage report: $OUT_JSON"
exit "$fail"
```

**Gate**: script must exit 0 (all 5 projects ≥95 % on both axes). Exit 1 → P2.6 investigation.

---

### P2.4 — Schema shape assertion (doctor dependency)

**Judge finding C-MEDIUM (EVAL)**: P5's doctor coverage gate (W23) will read the same `GET /api/v1/codebase/projects` payload that P2.3 uses. If the key names diverge from what the doctor expects, the P5 gate will silently return 0% coverage for every project. This task asserts the current schema ships the keys P5 will depend on.

**Expected schema** (from `rest-server.ts:3399-3409`): each item in `data.projects[]` exposes `projectId, rootPath, treeHash, filesCount, chunksCount, commitsCount, lastIngestedAt`.

**Assertion command** (run after ping-mem is up; part of P2.4 acceptance):

```bash
curl -sfS -u "${PING_MEM_ADMIN_USER:-admin}:${PING_MEM_ADMIN_PASS:-ping-mem-dev-local}" \
  http://localhost:3003/api/v1/codebase/projects \
  | jq -e '.data.projects[0] | has("commitsCount") and has("filesCount") and has("projectId") and has("rootPath")'
```

- Exit 0 + `true` → schema matches P5's dependency; no further action.
- Exit 1 or `false` → record the actual keys via `jq '.data.projects[0] | keys'`, then file a GH issue labeled `ping-mem`, `phase-2`, `schema-drift` titled "Align /api/v1/codebase/projects payload with doctor coverage gate (W23)". Do NOT silently rename here — coupling lives in overview.md and P5; orchestrator must coordinate.

---

### P2.5 — Verify existing periodic-ingest launchd plist covers 5 projects

Check whether the existing plist references all 5 project paths (do not create new plist here — P0 owns creation; this phase only audits).

```bash
PLIST=~/Library/LaunchAgents/com.ping-mem.periodic-ingest.plist
if [[ -f "$PLIST" ]]; then
  # Extract ProgramArguments that contain project directories
  /usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$PLIST" 2>/dev/null \
    | grep -Ec '/ping-learn|/ping-mem|/auto-os|/ping-guard|/thrivetree' \
    || echo "plist exists but project coverage not detectable via ProgramArguments"
else
  echo "MISSING: $PLIST — flag to orchestrator (P0 owns creation)"
fi
launchctl print "gui/$(id -u)/com.ping-mem.periodic-ingest" 2>/dev/null | grep -E 'state|last exit code' || echo "plist not loaded"
```

- If plist absent → write a one-line status file `/tmp/ping-mem-p2-plist-missing.flag` and surface to orchestrator. Do not block the Phase 2 gate on this.
- If plist present but only 1 project → file GH issue `ping-mem`, `phase-2`, `launchd-scope` titled "periodic-ingest plist covers only <N> projects — extend to 5".
- If plist present and project coverage detectable ≥ 5 → record pass in the task ledger.

---

### P2.6 — Scanner-defaults override (in-scope; NOT deferred)

**Outcome**: O4 file-coverage target ≥95% for the 5 active projects. Prior scoping note deferred this to a "future ADR" — that was the exact anti-pattern #46 shape overview.md committed to eliminate, and `ProjectScanner.ts` exclusions dominate the 41% file-coverage gap (verified: baseline 17–30% across 5 projects vs ≥95% target). The scanner's global defaults stay safe; per-project overrides land in-phase.

#### P2.6.a — Add `ignoreDirs` / `excludeExtensions` to `IngestProjectOptions`

`src/ingest/IngestionService.ts:43-48`:

```ts
// New:
export interface IngestProjectOptions {
  projectDir: string;
  forceReingest?: boolean;
  maxCommits?: number;
  maxCommitAgeDays?: number;
  ignoreDirs?: string[] | undefined;          // NEW — overrides DEFAULT_IGNORE_DIRS subset when provided
  excludeExtensions?: string[] | undefined;   // NEW — overrides DEFAULT_EXCLUDE_EXTENSIONS subset when provided
}
```

#### P2.6.b — Thread overrides through `ProjectScanner.scanProject`

`src/ingest/ProjectScanner.ts` gains optional `options.ignoreDirs` and `options.excludeExtensions`. When provided, they are **subtracted** from the global defaults (inclusion overrides) — they are *not* a full replacement, so a mis-scoped override can't widen the scanner unexpectedly:

```ts
function resolveIgnoreDirs(override?: string[]): Set<string> {
  const base = new Set(DEFAULT_IGNORE_DIRS);
  if (override) for (const d of override) base.delete(d);
  return base;
}
// Same pattern for extensions.
```

This way, passing `ignoreDirs: ["docs"]` RE-INCLUDES `docs/` for that project only, and passing `excludeExtensions: [".md", ".jsonl", ".sh", ".bat", ".csv", ".log"]` RE-INCLUDES those extensions.

#### P2.6.c — Extend `IngestionEnqueueSchema` in `src/validation/api-schemas.ts`

Add two fields so `POST /api/v1/ingestion/enqueue` accepts the overrides without a breaking schema change. Both are optional arrays of short strings, each bounded to prevent DoS:

```ts
ignoreDirs: z.array(z.string().min(1).max(100)).max(50).optional(),
excludeExtensions: z.array(z.string().regex(/^\.[a-z0-9]+$/i).max(20)).max(50).optional(),
```

#### P2.6.d — Update `scripts/reingest-active-projects.sh`

Pass the 5-project override set so each project's specific ingest request re-includes the relevant dirs/extensions:

```bash
# Shared override — re-include docs directory and documentation-like extensions
# for every active project. This is the concrete scanner-default correction
# that brings files-coverage from ~18-30% to ≥95%.
IGNORE_DIRS_OVERRIDE='["docs"]'
EXCLUDE_EXT_OVERRIDE='[".md",".jsonl",".csv",".log",".sh",".bat"]'

for project in ping-learn ping-mem auto-os ping-guard thrivetree; do
  curl -sf -u "$PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS" -X POST \
    "$PING_MEM_URL/api/v1/ingestion/enqueue" \
    -H 'content-type: application/json' \
    -d "$(jq -n \
          --arg root "$HOME/Projects/$project" \
          --argjson dirs "$IGNORE_DIRS_OVERRIDE" \
          --argjson exts "$EXCLUDE_EXT_OVERRIDE" \
          '{projectDir:$root, forceReingest:true, ignoreDirs:$dirs, excludeExtensions:$exts}')" \
    | jq -r '.data.runId'
  # ...poll run until completed (same loop as P2.2)
done
```

#### P2.6.e — Measurement: denominator = `git ls-files` including overrides

`scripts/verify-ingestion-coverage.sh` computes the denominator from the SAME inclusion set the overrides apply, so the 95% target is internally consistent:

```bash
# Per project:
git -C "$HOME/Projects/$project" ls-files \
  | grep -vE '(^node_modules/|^\.next/|^dist/|^build/|\.(png|jpg|jpeg|gif|pdf|zip|tar|gz)$)' \
  | wc -l
# vs /api/v1/codebase/projects filesCount for that project.
# Ratio must be ≥ 0.95.
```

Global exclusions that do NOT change in P2: lock files, compiled binaries, media, archives. Only documentation dirs and text-like extensions return via the override.

#### P2.6.f — Verification

| # | Check | Command | Expected |
|---|-------|---------|----------|
| V2.10 | Overrides accepted by schema | `echo '{"projectDir":"/tmp/x","ignoreDirs":["docs"],"excludeExtensions":[".md"]}' \| curl -sf -u admin:ping-mem-dev-local -X POST http://localhost:3003/api/v1/ingestion/enqueue -H 'content-type: application/json' --data-binary @-` | HTTP 202 with `runId` |
| V2.11 | Files-coverage ≥95% per project after reingest | `bash scripts/verify-ingestion-coverage.sh \| jq '.[].pctFiles \| . >= 0.95'` | `true` for all 5 projects |
| V2.12 | Commits-coverage ≥95% per project after reingest | same script, `.pctCommits >= 0.95` | `true` for all 5 |

#### P2.6.g — Diagnosis fallback (only if V2.11 still fails)

Reserved for genuinely unexpected situations:

| # | Candidate | Diagnosis command | Fire when | Fix path |
|---|-----------|-------------------|-----------|----------|
| d | `.gitignore` vs scanner divergence | `cd <project> && git check-ignore -v $(git ls-files \| head -50) \| grep -c :`  vs  `jq '.data.projects[] \| select(.rootPath \| endswith("<project>")) \| .filesCount' <projects.json>` | many tracked files flagged as ignored (rare) | escalate to orchestrator — likely global `.pingmemignore` mis-write |
| e | Override rejected but schema claims accepted | `grep -c 'ignoreDirs\|excludeExtensions' src/validation/api-schemas.ts src/ingest/IngestionService.ts src/ingest/ProjectScanner.ts` | count <3 files | missed a plumbing step — re-apply P2.6.a/b/c |

Any diagnosis output appends to `/tmp/ping-mem-p2-investigation.log` and is referenced in `overview.md`'s CHANGELOG.

---

## 4. Function / Schema Signatures (old vs new)

### `IngestProjectOptions` (`src/ingest/IngestionService.ts:43-48`)

**Old (comment only)**:

```ts
export interface IngestProjectOptions {
  projectDir: string;
  forceReingest?: boolean;
  maxCommits?: number; // Max git commits to ingest (default 200)
  maxCommitAgeDays?: number; // Only include commits from last N days (default: 30)
}
```

**New** (canonical — single source of truth for §P2.6.a):

```ts
export interface IngestProjectOptions {
  projectDir: string;
  forceReingest?: boolean;
  maxCommits?: number;              // Max git commits to ingest (default: env PING_MEM_MAX_COMMITS || 10000)
  maxCommitAgeDays?: number;        // Only include commits from last N days (default: env PING_MEM_MAX_COMMIT_AGE_DAYS || unset → full history)
  ignoreDirs?: string[] | undefined;        // P2.6.a — override: subtracts from DEFAULT_IGNORE_DIRS (e.g. ["docs"] re-includes docs/)
  excludeExtensions?: string[] | undefined; // P2.6.a — override: subtracts from DEFAULT_EXCLUDE_EXTENSIONS (e.g. [".md", ".sh"])
}
```

### `GitHistoryReader.readHistory` (`src/ingest/GitHistoryReader.ts:55`)

Signature unchanged:

```ts
async readHistory(
  projectDir: string,
  options?: { maxCommits?: number; maxCommitAgeDays?: number }
): Promise<GitHistoryResult>
```

Behavior change: default `maxCommits` raised from `200` to `10_000` (or env `PING_MEM_MAX_COMMITS`); `maxCommitAgeDays` already respects `undefined` → no `since` (GitHistoryReader.ts:62-64).

### Project list response (`rest-server.ts:3399-3409`)

Response schema **unchanged** and MUST remain:

```ts
{
  data: {
    count: number,
    sortBy: "lastIngestedAt" | "filesCount" | "rootPath",
    projects: Array<{
      projectId: string,
      rootPath: string,
      treeHash: string,
      filesCount: number,
      chunksCount: number,
      commitsCount: number,
      lastIngestedAt: string,
    }>
  }
}
```

P2.4 asserts this shape. P5 (W23) depends on `commitsCount` + `filesCount`.

---

## 5. Integration Points (grep-verified 2026-04-18)

| File:line | Current symbol | Patched by | grep verification |
|-----------|----------------|-----------|-------------------|
| `src/ingest/IngestionService.ts:46` | `// Max git commits to ingest (default 200)` | P2.1.b | `grep -n 'default 200' src/ingest/IngestionService.ts` → `46:` |
| `src/ingest/IngestionService.ts:129` | `ingestOptions.maxCommitAgeDays = options.maxCommitAgeDays ?? 30;` | P2.1.c | `grep -n 'maxCommitAgeDays ?? 30' src/ingest/IngestionService.ts` → `129:` |
| `src/ingest/GitHistoryReader.ts:61` | `const maxCommits = options?.maxCommits ?? 200;` | P2.1.a | `grep -n '\\?\\? 200' src/ingest/GitHistoryReader.ts` → `61:` |
| `src/http/rest-server.ts:1292-1293` | `const runId = await this.ingestionQueue.enqueue(...); return c.json({ runId }, 202);` | consumed by P2.2 (no patch — contract confirmed) | `grep -n 'runId }, 202' src/http/rest-server.ts` → `1293:` |
| `src/http/rest-server.ts:1317-1335` | `this.app.get("/api/v1/ingestion/run/:runId", ...)` returning `{...run}` including `status` | consumed by P2.2 poll loop (no patch) | `grep -n 'api/v1/ingestion/run/:runId' src/http/rest-server.ts` → `1317:` |
| `src/http/rest-server.ts:3399-3409` | `projects.map((p) => ({ ... filesCount, chunksCount, commitsCount ... }))` | consumed by P2.3 + P2.4 (no patch) | `grep -nE 'filesCount|commitsCount' src/http/rest-server.ts` → `3405:` |
| `src/ingest/ProjectScanner.ts:48` | `"docs",` in `DEFAULT_IGNORE_DIRS` | **P2.6.b** (global default kept; per-request override added so `docs/` ingests for 5 active projects) | `grep -n '"docs"' src/ingest/ProjectScanner.ts` → `48:` |
| `src/ingest/ProjectScanner.ts:51-76` | `DEFAULT_EXCLUDE_EXTENSIONS` contains `.md, .jsonl, .csv, .log, .sh, .bat` | **P2.6.b** (global default kept; per-request override accepts these extensions for active projects) | `grep -nE '"\\.md"\|"\\.jsonl"\|"\\.sh"' src/ingest/ProjectScanner.ts` |
| `src/ingest/IngestionService.ts:43-48` (`IngestProjectOptions`) | 4-field interface (no overrides) | **P2.6.a** (adds `ignoreDirs?`, `excludeExtensions?`) | `grep -n 'ignoreDirs?: string\[\]' src/ingest/IngestionService.ts` → expect match |
| `src/validation/api-schemas.ts` (`IngestionEnqueueSchema`) | pre-P2.6: no scanner overrides | **P2.6.c** (adds `ignoreDirs`, `excludeExtensions` optional arrays) | `grep -n 'ignoreDirs\|excludeExtensions' src/validation/api-schemas.ts` → ≥2 hits |
| `scripts/reingest-active-projects.sh` | pre-P2.6: no override JSON | **P2.6.d** (passes per-project override JSON for 5 active projects) | `grep -c 'IGNORE_DIRS_OVERRIDE\|EXCLUDE_EXT_OVERRIDE' scripts/reingest-active-projects.sh` → ≥2 |
| `scripts/verify-ingestion-coverage.sh` | pre-P2.6: no canonical denominator | **P2.6.e** (computes `git ls-files` denominator consistent with overrides) | `test -x scripts/verify-ingestion-coverage.sh` → exit 0 |

---

## 6. Wiring Matrix (rows owned by P2)

| # | Capability | User trigger | Call chain | Owned files | Functional test |
|---|-----------|-------------|-----------|------------|-----------------|
| **W7** | ping-learn coverage ≥95 % (commits + files) | `bash scripts/reingest-active-projects.sh` (or launchd periodic tick) | `POST /api/v1/ingestion/enqueue` (`rest-server.ts:1257-1301`) → `IngestionQueue.enqueue` → `IngestionService.ingestProject` (`IngestionService.ts:119-256`) → `IngestionOrchestrator.ingest` → `GitHistoryReader.readHistory` (`GitHistoryReader.ts:55-90`, defaults patched in P2.1.a) + `ProjectScanner.scanProject` → Neo4j + Qdrant writes | `src/ingest/GitHistoryReader.ts`, `src/ingest/IngestionService.ts`, `scripts/reingest-active-projects.sh` | **F7** |
| **W8** | 5 projects (ping-learn, ping-mem, auto-os, ping-guard, thrivetree) all ≥95 % on both axes | `bash scripts/reingest-active-projects.sh` then `bash scripts/verify-ingestion-coverage.sh` | Same as W7, iterated over 5 project dirs, then `GET /api/v1/codebase/projects` (`rest-server.ts:3378-3413`) → `IngestionService.listProjects` → `TemporalCodeGraph.listProjects` | `scripts/verify-ingestion-coverage.sh`, baseline file `/tmp/ping-mem-remediation-baseline.json` (P0-owned input) | **F8** |
| **W9** | Idempotent re-ingest — second run with unchanged tree finishes <30 s | Re-run `bash scripts/reingest-active-projects.sh` without changing any file | `IngestionOrchestrator.ingest` returns `null` when tree hash matches manifest (`IngestionService.ts:151-153`) → handler still returns 202 but ingestion service short-circuits; per-run latency dominated by scan + hash (target <30 s per project) | `scripts/reingest-active-projects.sh` (same script, second run) | **F9** |

---

## 7. Verification Checklist (V2.x — evidence-based, grep-verifiable)

| # | Assertion | Evidence command | Required |
|---|-----------|-----------------|----------|
| V2.1 | Comment updated | `grep -n 'PING_MEM_MAX_COMMITS' src/ingest/IngestionService.ts` | line 46 matches new text |
| V2.2 | Runtime default patched in Reader | `grep -n 'PING_MEM_MAX_COMMITS' src/ingest/GitHistoryReader.ts` | ≥1 hit near line 61 |
| V2.3 | Age default patched | `grep -n 'PING_MEM_MAX_COMMIT_AGE_DAYS' src/ingest/IngestionService.ts` | ≥1 hit in 125-140 range |
| V2.4 | `?? 200` no longer present as a commit cap | `grep -n '\\?\\? 200' src/ingest/GitHistoryReader.ts` | 0 hits |
| V2.5 | Old 30-day default string gone | `grep -n 'maxCommitAgeDays ?? 30' src/ingest/IngestionService.ts` | 0 hits |
| V2.6 | `scripts/reingest-active-projects.sh` exists and executable | `[[ -x scripts/reingest-active-projects.sh ]] && shellcheck scripts/reingest-active-projects.sh` | exit 0, 0 findings |
| V2.7 | `scripts/verify-ingestion-coverage.sh` exists and executable | `[[ -x scripts/verify-ingestion-coverage.sh ]] && shellcheck scripts/verify-ingestion-coverage.sh` | exit 0, 0 findings |
| V2.8 | typecheck clean | `bun run typecheck 2>&1 \| tail -1` | `Found 0 errors` |
| V2.9 | ingest unit tests green | `bun test src/ingest/` | 0 failures |
| V2.10 | Schema assertion command set in P2.4 returns `true` | see P2.4 curl+jq | jq `true` |
| V2.11 | README env-var table updated | `grep -c 'PING_MEM_MAX_COMMITS\\|PING_MEM_MAX_COMMIT_AGE_DAYS' README.md` | ≥2 |

Any V2.x failure → the phase gate is RED.

---

## 8. Functional Tests (F2.x — binary)

| # | Test | Command | Pass |
|---|------|---------|------|
| **F7** | ping-learn coverage ≥95 % both axes | `bash scripts/verify-ingestion-coverage.sh \| grep '^ping-learn'` | line ends with `OK` and both %s ≥ 95 |
| **F8** | All 5 projects ≥95 % | `bash scripts/verify-ingestion-coverage.sh; echo $?` | exit 0 |
| **F9** | Idempotent re-ingest — second run <30 s per project | `FORCE=false TIMEOUT_S=60 bash scripts/reingest-active-projects.sh && jq '[.[].durationS] \| max' $OUT_DIR/*.json` | max durationS ≤ 30 (per project) |
| F2.4 | Async enqueue+poll contract works | `bash scripts/reingest-active-projects.sh 2>&1 \| grep -E 'ENQUEUE\|POLL' \| wc -l` | ≥10 lines (5 enqueue + 5 poll) |
| F2.5 | 202 status honored (no premature success) | `jq '[.[].result.status] \| group_by(.) \| map({(.[0]):length})' $OUT_DIR/run-log.jsonl` | all "completed"; 0 "timeout"; 0 "failed" |
| F2.6 | Schema shape matches doctor (P5) contract | P2.4 assertion | `true` |
| F2.7 | Time-budget dry-run (AC-NF3 ≤20 min for ping-learn) | `jq 'select(.projectDir \| endswith("/ping-learn")) \| .durationS' $OUT_DIR/run-log.jsonl` | ≤ 1200 (20 × 60) |
| F2.8 | Ingestion writes reach Neo4j | `curl -sfS http://localhost:7474/db/neo4j/tx/commit -u neo4j:<pw> -H 'Content-Type: application/json' -d '{"statements":[{"statement":"MATCH (p:Project) RETURN count(p) AS n"}]}' \| jq '.results[0].data[0].row[0]'` | ≥5 |
| F2.9 | Ingestion writes reach Qdrant | `curl -sf http://localhost:6333/collections \| jq '.result.collections \| map(.name) \| length'` | ≥1 |

If **F2.7** fails (ping-learn >20 min but ≤30 min) → record actual duration in CHANGELOG, re-run once (variance); if second run still >20 min, escalate to orchestrator for AC-NF3 bar revision.
If **F2.7** >30 min → hard escalation; do not advance past Phase 2.

---

## 9. Gate Criterion (binary)

**Phase 2 passes iff ALL of the following are simultaneously true**:

1. V2.1 – V2.11 all green.
2. F7 – F9 all green (O4 delivered).
3. F2.4 – F2.9 all green (async contract, schema contract, infrastructure reach).
4. No investigation path in P2.6 left open without a matching GH issue.

Any single red → Phase 2 is NOT done; orchestrator must not advance to phases that depend on Phase 2 (specifically P5 W23 and P7 W28).

**Evidence bundle** persisted to `/tmp/ping-mem-p2-gate-evidence-<ts>.json`:

```json
{
  "v": {"V2.1": true, "V2.2": true, "V2.3": true, "V2.4": true, "V2.5": true, "V2.6": true, "V2.7": true, "V2.8": true, "V2.9": true, "V2.10": true, "V2.11": true},
  "f": {"F7": true, "F8": true, "F9": true, "F2.4": true, "F2.5": true, "F2.6": true, "F2.7": true, "F2.8": true, "F2.9": true},
  "coverage": "<path to /tmp/ping-mem-coverage-*.json>",
  "runLog":   "<path to OUT_DIR/run-log.jsonl>",
  "ghIssues": []
}
```

---

## 10. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| R2.1 | Full re-ingest of all 5 projects blocks the queue for ~1 h (serial) | high | medium | Run overnight or accept; queue is a single-tenant dev tool. Time-budget gate F2.7 catches pathological runs. |
| R2.2 | Schema shape of `/api/v1/codebase/projects` drifts before P5 consumes it | low | high | P2.4 assertion runs in Phase 2 AND is added to P5 doctor startup. If drift is found now, GH issue forces alignment before P5. |
| R2.3 | Coverage still <95 % after defaults fix because `ProjectScanner` excludes `docs/` and `.md`/`.sh` | medium | medium | P2.6 rows (b)+(c) diagnose deterministically; no scanner default is changed without a new ADR — surfaced to orchestrator via GH issue. |
| R2.4 | `.gitignore` vs scanner divergence causes spurious mismatch | low | low | P2.6 row (d) diagnoses; rare per R5 research. |
| R2.5 | Enqueue returns 202 but runner never reports `completed` (queue reaper bug) | low | high | Poll has 25 min timeout per project; timeout → F2.5 fails → phase RED; orchestrator escalates to queue subsystem. |
| R2.6 | Neo4j or Qdrant constraint violation mid-ingest leaves partial state | low | medium | `IngestionService.ts:180-189` already surfaces "Neo4j OK, Qdrant failed — force reingest to recover"; re-run with `FORCE=true` is safe. |
| R2.7 | ping-learn `maxCommits=10000` default produces OOM on a machine with <8GB free | very low | medium | Baseline run captures duration + memory via `/usr/bin/time -l`; if RSS >6 GB, drop default to 5000 and create follow-up issue. |
| R2.8 | Raising default to "all" exposes commits with large diffs causing slow `git log %B` | low | medium | `SafeGit` already sets `maxBuffer: 100 MB` (`GitHistoryReader.ts:125`); dry-run time budget (F2.7) is the canary. |

---

## 11. Dependencies

**Upstream (must complete first)**:

- **P0 (prep)** — required. P0 writes `/tmp/ping-mem-remediation-baseline.json` with `baseline.coverage.<projectKey>.{gitCommits, gitFiles, projectId}` for all five projects. P2.3 reads this file. P0 also kills stale processes and ensures disk <85 %.

**Downstream (blocked until P2 gate is green)**:

- **P5 observability** — W23 (coverage canary gate in doctor) reads the same `GET /api/v1/codebase/projects` shape asserted by P2.4. If P2 is red, the doctor gate will report false 0 % coverage. Do not advance P5 without P2 gate green.
- **P7 soak regression** — W28 includes hard-gates `coverage-commits-ge-95pct` and `coverage-files-ge-95pct` (overview.md §30-Day Soak, post-F3 reconciliation). These consume `scripts/verify-ingestion-coverage.sh` produced here.

No other phase has hard dependency on P2 outputs.

---

## 12. Success Definition (plain-language)

> After Phase 2, running `bash scripts/reingest-active-projects.sh` followed by `bash scripts/verify-ingestion-coverage.sh` produces a report where every one of the five active projects shows ≥95 % commit coverage **and** ≥95 % file coverage versus the P0 baseline, the verify script exits 0, the `/api/v1/codebase/projects` response still carries `commitsCount` and `filesCount` per project, and a second invocation of the re-ingest script with `FORCE=false` completes in <30 s per project because the manifest hash matches.
