---
phase-id: P3
title: "Phase 3 — Ollama 3-tier self-heal chain + ping-guard manifest updates"
status: pending
effort_estimate: 4h
dependent-on: phase-0-prep
owns_wiring: [W10, W11, W12, W13, W14]
owns_outcomes: [O5]
blocks: ["phase-5-observability-doctor (self-heal doctor gates)", "phase-7-soak-regression (soak regression on self-heal reliability)"]
gap_coverage: [D.1, D.2, D.3, D.4]
adr_refs: [ADR-2]
research_refs:
  - docs/ping-mem-remediation-research/02-ping-guard-remediation.md
  - docs/ping-mem-remediation-research/04-ollama-integration.md
  - docs/ping-mem-remediation-research/07-synthesis.md (ADR-2)
---

# Phase 3 — Ollama 3-tier self-heal chain + ping-guard manifest updates

## Phase Goal

Deliver **O5** (≥90% self-heal auto-resolve rate on injected canary faults). Today the self-heal LLM chain is 100% broken: Claude tier exits 1, Codex `--prompt` flag is invalid, Gemini creds path is wrong, rules tier has confidence 0. Command-path recoveries (`docker compose restart …`) still work but never get a second opinion when they don't fully resolve, and they never escalate cleanly to an LLM when the confidence is low.

This phase replaces the broken 4-tier cloud chain with a 3-tier local Ollama chain (llama3.2 → qwen3:8b → gpt-oss:20b) plus a rules fallback, per **ADR-2** (user-selected 2026-04-18). It preserves all existing `guard.patterns[].recover.command` entries, seeds their confidences to a non-zero baseline, bumps the `ollama_memory_hog` threshold from 4GB→14GB to fit the new tier 3 model, switches the memory-hog evict target from `qwen3:8b` (active recovery model) to `gpt-oss:20b` (biggest eviction candidate), and removes the broken `aos-reconcile-scheduled` call from `wake_detector.py`.

**Outcome measurement**: Inject `docker stop ping-mem-neo4j`. Wait ≤120s. `docker ps --filter name=ping-mem-neo4j` must show `Up`. Run 3 trials; all 3 must pass. This directly measures O5.

---

## Pre-conditions

1. **P0 Prep complete**: worktree active, disk <85% post-cleanup, test baseline snapshot taken, `~/.claude.json` chmod 600 applied.
2. **Ollama endpoint reachable** — preflight evidence:
   ```bash
   curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null && echo OLLAMA_OK
   # Expected: OLLAMA_OK
   ```
3. **Models present** — evidence captured 2026-04-18 via `ollama list` in-session:
   ```
   NAME                         ID              SIZE      MODIFIED
   gpt-oss:20b                  17052f91a42e    13 GB     6 days ago
   llama3.2:latest              a80c4f17acd5    2.0 GB    3 weeks ago
   qwen3:8b                     500a1f067a9f    5.2 GB    8 weeks ago
   ```
   All 3 required models are installed locally. No model pulls needed.
4. **`guard.db` schema source of truth** — `/Users/umasankr/Projects/ping-guard/packages/typescript/src/storage/GuardDB.ts:82-96`:
   ```sql
   CREATE TABLE IF NOT EXISTS patterns (
     pattern_id TEXT PRIMARY KEY,
     project TEXT NOT NULL,
     name TEXT NOT NULL,
     detect_condition TEXT NOT NULL,
     recover_action TEXT NOT NULL,
     confidence REAL NOT NULL DEFAULT 0.5,
     times_used INTEGER NOT NULL DEFAULT 0,
     times_succeeded INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL,
     source_incident_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )
   ```
   The seed script MUST match this schema exactly (`pattern_id` is the PRIMARY KEY, not `name`; the recovery column is `recover_action`, not `recovery_template`).
5. **ping-guard daemon loaded** — `launchctl list com.ping-guard.daemon` returns a line with PID>0 (otherwise kickstart after P3.2).
6. **Backup directory writable** — `mkdir -p ~/Projects/ping-guard/.backups && touch ~/Projects/ping-guard/.backups/.writable && rm ~/Projects/ping-guard/.backups/.writable`.

---

## Tasks

### P3.1 — Write `~/Projects/ping-guard/scripts/ollama-tier.sh`

**Purpose**: One shell script, invoked by the ping-guard LLMRouter with args `(model, timeout_ms, confidence_floor, prompt)`. Calls Ollama REST `/api/generate`, parses the structured JSON response, extracts a `confidence` score, and exits `0` on success, `2` on low-confidence (below floor → escalate), `3` on transport error (timeout, 5xx, unreachable → escalate).

**Backup**: N/A (new file).

**Create** `/Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh`:

```bash
#!/usr/bin/env bash
# ollama-tier.sh — ping-guard LLM tier wrapper for local Ollama models.
# Usage: ollama-tier.sh <model> <timeout_ms> <confidence_floor> <prompt_file>
# Exit codes:
#   0  - success, confidence >= floor, recovery_plan printed to stdout
#   2  - success, confidence <  floor  (escalate to next tier)
#   3  - transport error: unreachable/timeout/5xx/parse-fail (escalate)
#   4  - usage error
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo '{"error":"usage: ollama-tier.sh <model> <timeout_ms> <confidence_floor> <prompt_file>"}' >&2
  exit 4
fi

MODEL="$1"
TIMEOUT_MS="$2"
CONF_FLOOR="$3"
PROMPT_FILE="$4"

TIMEOUT_S=$(( TIMEOUT_MS / 1000 ))
[[ "$TIMEOUT_S" -lt 1 ]] && TIMEOUT_S=1

# Preflight reachability (2s fast-fail)
if ! curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null; then
  echo '{"error":"ollama_unreachable"}' >&2
  exit 3
fi

# Build JSON payload with jq.
# NOTE: --arg kl "15m" is correct. DO NOT use --argjson kl "15m" — "15m" is not valid JSON,
# --argjson would fail with "parse error: Invalid literal at …".
PROMPT="$(cat "$PROMPT_FILE")"
PAYLOAD=$(jq -n \
  --arg model "$MODEL" \
  --arg prompt "$PROMPT" \
  --arg kl "15m" \
  '{model:$model, prompt:$prompt, stream:false, keep_alive:$kl, format:"json",
    options:{temperature:0.2, num_predict:512}}')

# Call /api/generate with curl timeout.
RESPONSE=$(curl -sf --max-time "$TIMEOUT_S" \
  -X POST http://localhost:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>/dev/null) || {
    echo '{"error":"ollama_timeout_or_5xx"}' >&2
    exit 3
  }

# Ollama returns {response: "<json-string>", ...}. The model is asked to emit
# {"diagnosis":"…","recovery_plan":"…","confidence":<float 0..1>}.
INNER=$(printf '%s' "$RESPONSE" | jq -r '.response // empty')
if [[ -z "$INNER" ]]; then
  echo '{"error":"empty_response"}' >&2
  exit 3
fi

# Parse the inner JSON; if it fails, treat as transport-level parse error.
CONFIDENCE=$(printf '%s' "$INNER" | jq -r '.confidence // 0' 2>/dev/null || echo 0)
if [[ -z "$CONFIDENCE" || "$CONFIDENCE" == "null" ]]; then
  CONFIDENCE=0
fi

# Emit the inner JSON on stdout for the router to consume.
printf '%s\n' "$INNER"

# Compare confidence vs floor using awk (bash cannot do float math natively).
PASSES=$(awk -v c="$CONFIDENCE" -v f="$CONF_FLOOR" 'BEGIN { print (c+0 >= f+0) ? 1 : 0 }')
if [[ "$PASSES" == "1" ]]; then
  exit 0
else
  exit 2
fi
```

**Permissions**: `chmod +x /Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh`

**Lint gate**: `shellcheck /Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh` — MUST exit 0.

---

### P3.2 — Patch `~/Projects/ping-guard/manifests/ping-mem.yaml`

**Purpose**:
- (a) Replace the 4-tier cloud `llm_chain` (current lines **249–266**) with the 3-tier Ollama + rules chain.
- (b) Fix `ollama_memory_hog` pattern: threshold 4 → 14 (GB), evict target `qwen3:8b` → `gpt-oss:20b`. The GB value lives at line **243**; the evict command lives at line **246**.

**Backup**:
```bash
cp -a /Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml \
      /Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml.bak.$(date +%s)
```

**Patch (a) — lines 249–266 → new `llm_chain`**:

```yaml
  escalation:
    llm_chain:
      - tier: "ollama_triage"
        type: "script"
        command: "/Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh"
        args: ["llama3.2:latest", "5000", "0.8"]
        preflight: "curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null"
        timeout_ms: 7000
      - tier: "ollama_recovery"
        type: "script"
        command: "/Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh"
        args: ["qwen3:8b", "20000", "0.7"]
        preflight: "curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null"
        timeout_ms: 25000
      - tier: "ollama_deep"
        type: "script"
        command: "/Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh"
        args: ["gpt-oss:20b", "120000", "0.6"]
        preflight: "curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null"
        timeout_ms: 125000
      - tier: "rules"
        type: "pattern_match"
```

Notes on the numbers:
- Tier 3 script-level timeout is **120s** (not 60s). `gpt-oss:20b` is 13GB and cold-start on Apple Silicon routinely exceeds 60s; see **P3.5** pre-warm strategy. Outer `timeout_ms` is 125000 to give the script a 5s safety margin for preflight + curl connect.
- All three Ollama tiers include a `preflight` that fails-fast in 2s if the daemon is down; rules tier has no preflight.
- `args` positional order matches the `ollama-tier.sh` contract: `<model> <timeout_ms> <confidence_floor>`. The router passes the prompt file path as the fourth arg when invoking.

**Patch (b) — line 243 + line 246**:

Before:
```yaml
    - name: "ollama_memory_hog"
      detect:
        field: "system.ollama_loaded_model_gb"
        operator: ">"
        value: 4                              # line 243
      recover:
        type: "command"
        command: "ollama stop qwen3:8b"       # line 246
      cooldown_ms: 300000
```

After:
```yaml
    - name: "ollama_memory_hog"
      detect:
        field: "system.ollama_loaded_model_gb"
        operator: ">"
        value: 14
      recover:
        type: "command"
        command: "ollama stop gpt-oss:20b"
      cooldown_ms: 300000
```

Rationale: the old 4GB threshold tripped any time even `qwen3:8b` (5.2GB) was loaded — i.e., every active tier-2 recovery — and evicted the model mid-diagnosis. New 14GB threshold only trips when `gpt-oss:20b` (13GB) is loaded alongside another model, i.e. true pressure. Evicting `gpt-oss:20b` first frees the most memory and preserves the active tier-2 recovery path.

**Lint gate**:
```bash
python3 -c 'import yaml,sys; yaml.safe_load(open("/Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml"))' \
  && echo YAML_OK
# Expected: YAML_OK
```

---

### P3.3 — Write `~/Projects/ping-guard/scripts/seed-pattern-confidence.ts`

**Purpose**: Seed non-zero confidence (0.5) on every currently-defined pattern from `manifests/ping-mem.yaml` into `~/.ping-guard/guard.db`, so the rules-fallback tier produces matches rather than returning empty. Safe to run repeatedly; WILL NOT overwrite learned confidence values ≥ 0.5.

**Backup**:
```bash
if [[ -f "$HOME/.ping-guard/guard.db" ]]; then
  cp -a "$HOME/.ping-guard/guard.db" "$HOME/.ping-guard/guard.db.bak.$(date +%s)"
fi
```

**Create** `/Users/umasankr/Projects/ping-guard/scripts/seed-pattern-confidence.ts`:

```typescript
#!/usr/bin/env bun
// seed-pattern-confidence.ts — seed rules-tier confidence for command-path patterns.
// Re-runnable. Never overwrites learned confidence >= 0.5.

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// CRITICAL: JS/TS strings DO NOT expand "~". Must use path.join(homedir(), ...).
const DB_PATH = join(homedir(), ".ping-guard", "guard.db");

// The canonical seed set — these names MUST match manifests/ping-mem.yaml guard.patterns[].name.
// Source: manifests/ping-mem.yaml lines 188-247 (as of 2026-04-18).
const SEED_PATTERNS: Array<{
  name: string;
  detect_condition: string;
  recover_action: string;
}> = [
  {
    name: "neo4j_disconnected",
    detect_condition: "health.components.neo4j != ok",
    recover_action: "docker-compose-restart:ping-mem-neo4j+warmup",
  },
  {
    name: "qdrant_disconnected",
    detect_condition: "health.components.qdrant != ok",
    recover_action: "docker-compose-restart:ping-mem-qdrant+warmup",
  },
  {
    name: "ping_mem_down",
    detect_condition: "health.status == unreachable",
    recover_action: "docker-compose-restart:ping-mem+warmup",
  },
  {
    name: "sqlite_corrupt_indexes",
    detect_condition: "observability.sqlite.integrity_ok == 0",
    recover_action: "sqlite3-reindex:~/.ping-mem/ping-mem.db",
  },
  {
    name: "neo4j_orphaned_nodes",
    detect_condition: "observability.neo4j.null_node_count > 100",
    recover_action: "cypher-orphan-sweep:500-chunks",
  },
  {
    name: "ollama_memory_hog",
    detect_condition: "system.ollama_loaded_model_gb > 14",
    recover_action: "ollama-stop:gpt-oss:20b",
  },
];

const SEED_CONFIDENCE = 0.5;
const PROJECT = "ping-mem";
const SOURCE = "seed-pattern-confidence";

const db = new Database(DB_PATH, { create: true });

// Precondition: schema exists. Mirror GuardDB.ts:82-96 so a first-run machine works.
// Uses IF NOT EXISTS — no-op if the daemon already created the table.
db.run(`
  CREATE TABLE IF NOT EXISTS patterns (
    pattern_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    name TEXT NOT NULL,
    detect_condition TEXT NOT NULL,
    recover_action TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    times_used INTEGER NOT NULL DEFAULT 0,
    times_succeeded INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    source_incident_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const now = new Date().toISOString();

const findStmt = db.prepare(
  "SELECT pattern_id, confidence FROM patterns WHERE project = ? AND name = ?",
);
const insertStmt = db.prepare(`
  INSERT INTO patterns
    (pattern_id, project, name, detect_condition, recover_action, confidence,
     times_used, times_succeeded, source, source_incident_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ?, ?)
`);
// Guardrail: only bump confidence if still below seed floor. Protects learned values.
const updateStmt = db.prepare(`
  UPDATE patterns
     SET confidence = ?, updated_at = ?
   WHERE project = ? AND name = ? AND confidence < ?
`);

let inserted = 0;
let updated = 0;
let preserved = 0;

db.transaction(() => {
  for (const p of SEED_PATTERNS) {
    const row = findStmt.get(PROJECT, p.name) as
      | { pattern_id: string; confidence: number }
      | null;
    if (!row) {
      insertStmt.run(
        randomUUID(),
        PROJECT,
        p.name,
        p.detect_condition,
        p.recover_action,
        SEED_CONFIDENCE,
        SOURCE,
        now,
        now,
      );
      inserted++;
    } else if (row.confidence < SEED_CONFIDENCE) {
      updateStmt.run(SEED_CONFIDENCE, now, PROJECT, p.name, SEED_CONFIDENCE);
      updated++;
    } else {
      preserved++;
    }
  }
})();

const count = (
  db
    .prepare("SELECT COUNT(*) as c FROM patterns WHERE project = ?")
    .get(PROJECT) as { c: number }
).c;

console.log(
  JSON.stringify({
    db_path: DB_PATH,
    inserted,
    updated,
    preserved,
    total_patterns_for_project: count,
  }),
);

// Hard assertion — must have all 6 seed patterns present for this project.
if (count < SEED_PATTERNS.length) {
  console.error(
    `FAIL: expected >=${SEED_PATTERNS.length} patterns for project=${PROJECT}, found ${count}`,
  );
  process.exit(1);
}

db.close();
```

**Run**:
```bash
cd /Users/umasankr/Projects/ping-guard && bun run scripts/seed-pattern-confidence.ts
# Expected JSON:  {"db_path":"/Users/umasankr/.ping-guard/guard.db","inserted":6,"updated":0,"preserved":0,"total_patterns_for_project":6}
# On re-run:      {"db_path":"…","inserted":0,"updated":0,"preserved":6,"total_patterns_for_project":6}
```

**Verification assertion** (V3.4 below): row count must be ≥ 6.

---

### P3.4 — Patch `~/Projects/ping-guard/scripts/wake_detector.py`

**Purpose**: Remove the now-dead `_reconcile_scheduled()` call. Research R2 confirmed no downstream consumer — only an archived binary references `aos-reconcile-scheduled`. The current behavior is that every Mac wake event logs `reconcile-scheduled failed (exit …)` to `wake-detector.err`, which is noise that hides real failures.

**Surgery targets** (verified against live file at wake_detector.py:1-121):
- **Lines 40–51**: the entire `def _reconcile_scheduled() -> None:` function body (12 lines).
- **Line 95**: the call site inside `WakeObserver.handleWakeNotification_`: `        _reconcile_scheduled()`.

**Backup**:
```bash
cp -a /Users/umasankr/Projects/ping-guard/scripts/wake_detector.py \
      /Users/umasankr/Projects/ping-guard/scripts/wake_detector.py.bak.$(date +%s)
```

**Edits** (using the Edit tool, exact strings):

Edit 1 — remove the function. Delete lines 40-51 inclusive (plus the preceding blank line joiner; net replacement keeps one blank line between `_kickstart` and `_wait_for_docker`):

```python
# OLD (lines 39-53):


def _reconcile_scheduled() -> None:
    result = subprocess.run(
        [
            "/opt/homebrew/bin/python3",
            "/Users/umasankr/Projects/auto-os/bin/aos-reconcile-scheduled",
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        LOG.warning("reconcile-scheduled failed (exit %d): %s", result.returncode, result.stderr.strip())


def _wait_for_docker(timeout_s: int = 90, poll_s: int = 5) -> bool:

# NEW:


def _wait_for_docker(timeout_s: int = 90, poll_s: int = 5) -> bool:
```

Edit 2 — remove the call at line 95. `handleWakeNotification_` goes from:

```python
# OLD (lines 89-95):
    def handleWakeNotification_(self, _notification) -> None:
        LOG.info("Wake detected")
        _wait_for_docker()
        for label in PING_GUARD_LABELS:
            _kickstart(label)
        time.sleep(5)
        _reconcile_scheduled()

# NEW:
    def handleWakeNotification_(self, _notification) -> None:
        LOG.info("Wake detected")
        _wait_for_docker()
        for label in PING_GUARD_LABELS:
            _kickstart(label)
```

The trailing `time.sleep(5)` is also removed — it existed only to stagger the now-deleted reconcile call; with no downstream call, the sleep is dead weight and delays real work.

**Post-edit assertions (V3.5)**:
```bash
# AST parse must succeed — prevents shipping a SyntaxError.
python3 -c "import ast; ast.parse(open('/Users/umasankr/Projects/ping-guard/scripts/wake_detector.py').read())" \
  && echo AST_OK

# No reference to the removed function or binary remains.
grep -c "_reconcile_scheduled\|aos-reconcile-scheduled" \
  /Users/umasankr/Projects/ping-guard/scripts/wake_detector.py
# Expected: 0
```

If AST parse fails, restore the backup and abort the task:
```bash
LATEST=$(ls -t /Users/umasankr/Projects/ping-guard/scripts/wake_detector.py.bak.* | head -1)
cp -a "$LATEST" /Users/umasankr/Projects/ping-guard/scripts/wake_detector.py
```

---

### P3.5 — Tier 3 pre-warm strategy (decision + implementation)

**Problem**: `gpt-oss:20b` is 13GB. On Apple Silicon, cold-start from disk commonly exceeds 60s. If tier 3 is invoked on a cold model and the script timeout is 65s (as the superseded plan wrote), every first invocation after a `keep_alive` expiry fails. That regresses O5 directly.

**Options evaluated**:

| Option | Pros | Cons | Choice |
|---|---|---|---|
| (a) Raise tier 3 timeouts: script 120s, outer 125s | Simple; no extra moving parts | First fault still incurs cold-start latency the user sees | SELECTED |
| (b) Add startup pre-warm task to ping-guard daemon | Eliminates cold-start on first fault | Requires daemon change (out of this phase's scope; touches cli/daemon.ts) | Deferred — P5 will own a `warm-latency` gate |
| (c) Add `warm-latency` doctor gate, re-ping on >90s | Reactive; self-healing | Doctor runs every 15min, can't help the first fault in that window | Combined with (a) |

**Selected combination**: **(a) + (c)**.

- (a) already implemented in P3.2: tier 3 `timeout_ms: 125000`, script-level `120000` passed as second arg.
- (c) is OWNED BY P5 (doctor gates phase). This phase only produces a **hand-off note** to P5:

**Hand-off to P5** (add to `phase-5-observability-doctor.md` gate registry):

```yaml
# P5 doctor gate — owned by P5, defined here for traceability
- id: ollama-tier3-warm-latency
  group: selfheal
  hard_or_soft: soft
  check: |
    start=$(date +%s%3N); \
    curl -sf --max-time 95 -X POST http://localhost:11434/api/generate \
      -H 'Content-Type: application/json' \
      -d '{"model":"gpt-oss:20b","prompt":"hi","stream":false,"keep_alive":"15m","options":{"num_predict":1}}' \
      >/dev/null; \
    end=$(date +%s%3N); echo $((end-start))
  pass_if: output_ms_le(90000)
  on_fail: "pre-warm gpt-oss:20b by reissuing the same request with keep_alive=15m"
```

**Hand-off to P4** (lifecycle phase): add a one-shot pre-warm in `wake_detector.py` after Docker is ready — but this is P4's decision. This phase records the recommendation only.

**This phase's only implementation for P3.5** is a standalone smoke-test script at `/Users/umasankr/Projects/ping-guard/scripts/ollama-tier3-smoketest.sh`:

```bash
#!/usr/bin/env bash
# ollama-tier3-smoketest.sh — confirm gpt-oss:20b responds within budget.
# Exit 0 if <=90000ms, exit 1 otherwise. Not invoked by daemon; used by V3.6.
set -euo pipefail
START=$(date +%s%3N)
curl -sf --max-time 95 -X POST http://localhost:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss:20b","prompt":"ok","stream":false,"keep_alive":"15m","options":{"num_predict":1}}' \
  >/dev/null
END=$(date +%s%3N)
MS=$((END - START))
echo "tier3_latency_ms=$MS"
[[ "$MS" -le 90000 ]]
```

---

### P3.6 — Canary fault injection test script

**Purpose**: Deterministic, repeatable measurement for O5.

**Create** `/Users/umasankr/Projects/ping-guard/scripts/selfheal-canary.sh`:

```bash
#!/usr/bin/env bash
# selfheal-canary.sh — fault injection canary for self-heal chain.
# Usage: selfheal-canary.sh
# Exits 0 on PASS, 1 on FAIL.
set -euo pipefail

TRIALS=${TRIALS:-3}
BUDGET_S=${BUDGET_S:-120}
CONTAINER="ping-mem-neo4j"

pass=0
fail=0

for i in $(seq 1 "$TRIALS"); do
  echo "--- Trial $i/$TRIALS ---"
  # Ensure container is up before we break it.
  docker start "$CONTAINER" >/dev/null 2>&1 || true
  sleep 5

  # Inject fault.
  docker stop "$CONTAINER" >/dev/null
  inject_t=$(date +%s)

  # Wait up to $BUDGET_S for self-heal to restart the container.
  ok=0
  while (( $(date +%s) - inject_t < BUDGET_S )); do
    status=$(docker ps --filter "name=$CONTAINER" --format '{{.Status}}' || true)
    if [[ "$status" == Up* ]]; then
      ok=1
      break
    fi
    sleep 3
  done

  elapsed=$(( $(date +%s) - inject_t ))
  if (( ok == 1 )); then
    echo "PASS in ${elapsed}s"
    pass=$((pass+1))
  else
    echo "FAIL after ${elapsed}s (budget=${BUDGET_S}s)"
    fail=$((fail+1))
  fi
done

echo "--- Summary ---"
echo "pass=$pass fail=$fail trials=$TRIALS"
(( fail == 0 ))
```

`chmod +x` it, then invoke as V3.7 below. Expected: `pass=3 fail=0 trials=3`.

---

### P3.7 — Kickstart ping-guard daemon to pick up new manifest + patterns

**Purpose**: the daemon caches the parsed manifest at start. Config changes are not hot-reloaded. After P3.2 + P3.3 land, the daemon must be kicked to re-read both.

**Commands**:

```bash
# Pre-kickstart state
launchctl list com.ping-guard.daemon | head -1

# Kickstart
launchctl kickstart -k "gui/$(id -u)/com.ping-guard.daemon"

# Post-kickstart: PID must be non-zero and stable after 5s.
sleep 5
launchctl list com.ping-guard.daemon
PID=$(launchctl list com.ping-guard.daemon | awk '/"PID"/{gsub(";","",$3); print $3}')
echo "daemon_pid=${PID}"
[[ -n "$PID" && "$PID" != "0" ]] && echo DAEMON_OK
```

If the PID is 0 or empty, the manifest YAML is almost certainly invalid. Tail the error log:

```bash
tail -30 ~/Library/Logs/ping-guard/daemon.err
```

Restore the manifest backup if the error is a YAML parse error, then re-try P3.2 byte-for-byte.

---

### P3.8 — Verify no stale cloud-tier references in guard.db

**Purpose**: Earlier `incidents` rows may reference `pattern_id`s tied to `claude`/`codex`/`gemini` tier runs, and old `audit_runs`/`incidents` tables may contain the tier names in free-text columns. We need to confirm the NEW runs only record the new tier names — no regression into the old chain.

**Commands**:

```bash
# (a) No old tier name in live daemon logs since kickstart.
KICKSTART_T=$(stat -f %m ~/Library/Logs/ping-guard/daemon.log 2>/dev/null || echo 0)
# Read only lines written after the kickstart.
awk -v t="$KICKSTART_T" 'NR==1 || $0 ~ /claude|codex|gemini-2.5/ {print NR": "$0}' \
  ~/Library/Logs/ping-guard/daemon.log | head -20

# (b) guard.db incidents table has no rows with tier='claude'|'codex'|'gemini' recorded AFTER kickstart.
sqlite3 "$HOME/.ping-guard/guard.db" \
  "SELECT COUNT(*) FROM incidents WHERE detected_at > datetime('now','-2 minutes') \
   AND (rca_summary LIKE '%claude%' OR rca_summary LIKE '%codex%' OR rca_summary LIKE '%gemini%');"
# Expected: 0
```

If (b) returns >0 after a fresh canary run, the manifest replacement did not take effect — re-run P3.7 and inspect `daemon.log`.

---

## Function Signatures

### `ollama-tier.sh` contract

```
Invocation: ollama-tier.sh <model:string> <timeout_ms:int> <confidence_floor:float[0..1]> <prompt_file:path>
Stdin:      none
Stdout:     On exit 0 or 2: {"diagnosis":string, "recovery_plan":string, "confidence":float}
            On exit 3 or 4: nothing (stdout empty)
Stderr:     Error JSON on exit 3/4: {"error":string}
Exit codes: 0 success-above-floor, 2 success-below-floor (escalate),
            3 transport/parse error (escalate), 4 usage error
```

### `seed-pattern-confidence.ts` contract

```
Invocation:   bun run scripts/seed-pattern-confidence.ts
Reads:        ~/.ping-guard/guard.db (creates if missing; creates patterns table if missing)
Writes:       INSERT new seed patterns OR UPDATE confidence=0.5 ONLY WHERE confidence<0.5
Preserves:    any learned confidence >= 0.5
Stdout:       JSON summary {db_path, inserted, updated, preserved, total_patterns_for_project}
Exit codes:   0 on success + total>=6; 1 if final count <6 (seed failed)
```

### `wake_detector.py` diff

```diff
--- a/scripts/wake_detector.py
+++ b/scripts/wake_detector.py
@@ -37,18 +37,6 @@ def _kickstart(label: str) -> None:
         LOG.warning("kickstart failed for %s (exit %d): %s", label, result.returncode, result.stderr.strip())


-def _reconcile_scheduled() -> None:
-    result = subprocess.run(
-        [
-            "/opt/homebrew/bin/python3",
-            "/Users/umasankr/Projects/auto-os/bin/aos-reconcile-scheduled",
-        ],
-        capture_output=True,
-        text=True,
-        timeout=120,
-    )
-    if result.returncode != 0:
-        LOG.warning("reconcile-scheduled failed (exit %d): %s", result.returncode, result.stderr.strip())
-
-
 def _wait_for_docker(timeout_s: int = 90, poll_s: int = 5) -> bool:
@@ -88,8 +76,6 @@ class WakeObserver(NSObject):
         _wait_for_docker()
         for label in PING_GUARD_LABELS:
             _kickstart(label)
-        time.sleep(5)
-        _reconcile_scheduled()
```

---

## Integration Points

| # | File | Line(s) | Change | Owner |
|---|------|---------|--------|-------|
| IP1 | `~/Projects/ping-guard/scripts/ollama-tier.sh` | new file, ~65 lines | create | P3.1 |
| IP2 | `~/Projects/ping-guard/manifests/ping-mem.yaml` | 243 | `value: 4` → `value: 14` | P3.2 |
| IP3 | `~/Projects/ping-guard/manifests/ping-mem.yaml` | 246 | `ollama stop qwen3:8b` → `ollama stop gpt-oss:20b` | P3.2 |
| IP4 | `~/Projects/ping-guard/manifests/ping-mem.yaml` | 249–266 | replace `llm_chain` (4 cloud tiers) with 3 Ollama tiers + rules | P3.2 |
| IP5 | `~/Projects/ping-guard/scripts/seed-pattern-confidence.ts` | new file, ~90 lines | create | P3.3 |
| IP6 | `~/Projects/ping-guard/scripts/wake_detector.py` | 40–51 | delete `_reconcile_scheduled()` function | P3.4 |
| IP7 | `~/Projects/ping-guard/scripts/wake_detector.py` | 94–95 | delete `time.sleep(5)` + `_reconcile_scheduled()` call | P3.4 |
| IP8 | `~/Projects/ping-guard/scripts/ollama-tier3-smoketest.sh` | new file, ~12 lines | create | P3.5 |
| IP9 | `~/Projects/ping-guard/scripts/selfheal-canary.sh` | new file, ~40 lines | create | P3.6 |
| IP10 | `launchctl kickstart com.ping-guard.daemon` | runtime | reload manifest + patterns | P3.7 |
| IP11 | `~/.ping-guard/guard.db` patterns table | runtime | 6 rows seeded, confidence ≥ 0.5 | P3.3 via IP5 |

No other files touched. All destructive edits preceded by `cp -a … .bak.$(date +%s)` per P3.2/P3.3/P3.4.

---

## Wiring Matrix (W10–W14)

| # | Capability | User / System Trigger | Call Path (files + lines) | Preflight / Fallback | Functional Test |
|---|-----------|----------------------|---------------------------|----------------------|-----------------|
| W10 | Ollama tier 1 triage (llama3.2) | LLMRouter invoked after pattern-match confidence < threshold | ping-guard core → reads manifests/ping-mem.yaml#llm_chain[0] → exec `ollama-tier.sh llama3.2:latest 5000 0.8 <prompt_file>` → POST http://localhost:11434/api/generate | preflight: `curl -sf --max-time 2 http://localhost:11434/api/tags`. Fallback on exit 2 or 3: W11 | F10 canary |
| W11 | Ollama tier 2 recovery (qwen3:8b) | W10 exit 2 (low-conf) or 3 (transport) | manifests/ping-mem.yaml#llm_chain[1] → exec `ollama-tier.sh qwen3:8b 20000 0.7 <prompt_file>` | same preflight. Fallback: W12 | F10 canary |
| W12 | Ollama tier 3 deep reasoning (gpt-oss:20b) | W11 exit 2 or 3 | manifests/ping-mem.yaml#llm_chain[2] → exec `ollama-tier.sh gpt-oss:20b 120000 0.6 <prompt_file>`, outer `timeout_ms: 125000` | same preflight. Cold-start mitigation: P3.5 (a)+(c). Fallback: W13 (rules) | F10 canary + smoketest |
| W13 | Command-path recovery | Pattern match hit on any `guard.patterns[*]` | manifests/ping-mem.yaml lines 188-247 `recover.type=command` executed directly. Confidence from `~/.ping-guard/guard.db` patterns table (6 rows seeded ≥ 0.5). | Fallback if pattern DB empty: the LLM chain above still runs via rules tier | F11 (neo4j, qdrant, ping_mem, sqlite, ollama patterns all trigger on detect) |
| W14 | Wake handler clean — no aos-reconcile-scheduled error | Mac wake event (NSWorkspaceDidWakeNotification) | wake_detector.py#handleWakeNotification_ → _wait_for_docker() → _kickstart(label) for each PING_GUARD_LABELS entry. NO call to _reconcile_scheduled. | Fallback: if Docker wait times out, log warning and still kickstart daemons. | F12 (post-wake logs show zero `reconcile-scheduled failed` entries) |

---

## Verification Checklist

All greps and asserts must return the exact expected output before the gate.

| # | Assertion | Command | Expected |
|---|-----------|---------|----------|
| V3.1 | `ollama-tier.sh` exists + executable | `test -x /Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh && echo OK` | `OK` |
| V3.2 | `ollama-tier.sh` uses `--arg kl` not `--argjson kl` | `grep -n "argjson kl" /Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh \| wc -l` | `0` |
| V3.3 | `ollama-tier.sh` passes shellcheck | `shellcheck /Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh; echo $?` | `0` |
| V3.4 | Seed script ran, DB has ≥6 ping-mem patterns | `sqlite3 ~/.ping-guard/guard.db "SELECT COUNT(*) FROM patterns WHERE project='ping-mem' AND confidence>=0.5;"` | `>=6` |
| V3.5 | Seed script does NOT overwrite learned confidences | Re-run `bun run scripts/seed-pattern-confidence.ts` → stdout JSON has `updated:0` on second run | `"updated":0` |
| V3.6 | Seed script uses `path.join(homedir(), …)` | `grep -n "homedir()" /Users/umasankr/Projects/ping-guard/scripts/seed-pattern-confidence.ts` | ≥1 hit, 0 hits for the literal `"~/.ping-guard"` | 
| V3.7 | Seed script has `WHERE …confidence<` guardrail | `grep -n "confidence < ?" /Users/umasankr/Projects/ping-guard/scripts/seed-pattern-confidence.ts` | ≥1 |
| V3.8 | Seed script has `CREATE TABLE IF NOT EXISTS patterns` precondition | `grep -n "CREATE TABLE IF NOT EXISTS patterns" /Users/umasankr/Projects/ping-guard/scripts/seed-pattern-confidence.ts` | `1` |
| V3.9 | Manifest YAML parses | `python3 -c 'import yaml; yaml.safe_load(open("/Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml"))' && echo OK` | `OK` |
| V3.10 | Manifest `llm_chain` has ollama_triage, ollama_recovery, ollama_deep, rules | `grep -E "tier: \"(ollama_triage\|ollama_recovery\|ollama_deep\|rules)\"" /Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml \| wc -l` | `4` |
| V3.11 | Manifest no longer references claude/codex/gemini LLM tiers | `grep -cE "tier: \"(claude\|codex\|gemini)\"" /Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml` | `0` |
| V3.12 | ollama_memory_hog threshold bumped to 14 | `grep -A4 "name: \"ollama_memory_hog\"" /Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml \| grep -c "value: 14"` | `1` |
| V3.13 | ollama_memory_hog evicts gpt-oss:20b | `grep -A7 "name: \"ollama_memory_hog\"" /Users/umasankr/Projects/ping-guard/manifests/ping-mem.yaml \| grep -c "ollama stop gpt-oss:20b"` | `1` |
| V3.14 | wake_detector.py parses (no SyntaxError) | `python3 -c "import ast; ast.parse(open('/Users/umasankr/Projects/ping-guard/scripts/wake_detector.py').read())" && echo AST_OK` | `AST_OK` |
| V3.15 | wake_detector.py has no _reconcile_scheduled refs | `grep -c "_reconcile_scheduled\|aos-reconcile-scheduled" /Users/umasankr/Projects/ping-guard/scripts/wake_detector.py` | `0` |
| V3.16 | ping-guard daemon PID > 0 after kickstart | `launchctl list com.ping-guard.daemon \| awk '/"PID"/{gsub(";","",$3); print $3}'` | positive integer |
| V3.17 | No reconcile-scheduled errors in last wake-detector run | `grep -c "reconcile-scheduled failed" ~/Library/Logs/ping-guard/wake-detector.err` (measure growth across a wake event; must not increase) | growth = 0 |

---

## Functional Tests

| # | Test | Command / Procedure | Pass Criterion |
|---|------|---------------------|----------------|
| F3.1 | `ollama-tier.sh` returns 0 on healthy triage | `echo "respond with JSON: {\"diagnosis\":\"ok\",\"recovery_plan\":\"noop\",\"confidence\":0.9}" > /tmp/p.txt; /Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh llama3.2:latest 5000 0.8 /tmp/p.txt; echo exit=$?` | `exit=0` and stdout JSON has `confidence >= 0.8` |
| F3.2 | `ollama-tier.sh` returns 2 on below-floor | same prompt but set `confidence_floor=0.99` | `exit=2` |
| F3.3 | `ollama-tier.sh` returns 3 when Ollama unreachable | `launchctl unload /Users/umasankr/Library/LaunchAgents/ai.ollama.ollama.plist 2>/dev/null \|\| pkill ollama; sleep 2; /Users/umasankr/Projects/ping-guard/scripts/ollama-tier.sh llama3.2:latest 5000 0.8 /tmp/p.txt; echo exit=$?` then restore with `open -a Ollama` | `exit=3` |
| F3.4 | Seed runs, 6 patterns present | `bun run /Users/umasankr/Projects/ping-guard/scripts/seed-pattern-confidence.ts` → verify V3.4 | count ≥ 6 |
| F3.5 | Re-seed is idempotent | run F3.4 twice; second run prints `"inserted":0,"updated":0` | matches |
| F3.6 | Manifest lint green | V3.9 command | `OK` |
| F3.7 | Wake detector AST-clean | V3.14 command | `AST_OK` |
| F3.8 | ping-guard daemon healthy after manifest swap | P3.7 kickstart sequence | PID > 0 + `daemon.err` shows no parse errors |
| F3.9 | Tier 3 smoketest latency ≤ 90s | `/Users/umasankr/Projects/ping-guard/scripts/ollama-tier3-smoketest.sh` | exit 0; stdout has `tier3_latency_ms=<=90000` |
| F3.10 | **Canary self-heal ≥ 90% over 3 trials (O5)** | `TRIALS=3 BUDGET_S=120 /Users/umasankr/Projects/ping-guard/scripts/selfheal-canary.sh` | `pass=3 fail=0 trials=3` |
| F3.11 | Command-path recovery still executes (W13) | stop qdrant (`docker stop ping-mem-qdrant`), wait 120s, inspect: `docker ps --filter name=ping-mem-qdrant --format '{{.Status}}'` | `Up …` |
| F3.12 | Wake handler no longer logs reconcile-scheduled error | `pmset sleepnow` via `caffeinate -u -t 1 &` or actual sleep+wake, then `grep -c "reconcile-scheduled" ~/Library/Logs/ping-guard/wake-detector.err` (measure delta across the wake event) | delta = 0 |

---

## Gate Criterion (binary)

**Phase P3 passes if and only if**:
1. V3.1–V3.17 all return their exact expected output (17/17).
2. F3.10 returns `pass=3 fail=0 trials=3` — i.e. 3 of 3 canary fault injections resolved within 120s. This is the direct measurement of outcome **O5 ≥ 90%** (3/3 = 100% on the canary sample; policy requires ≥90%, so 3/3 satisfies it and 2/3 (67%) would not).
3. F3.12 shows no new reconcile-scheduled error lines across a wake event.

Any other result = phase does not pass. Restore backups, diagnose, re-run.

---

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Tier 3 cold-start exceeds 120s on a cold Mac → tier 3 times out on first fault → escalation to rules → possibly no recovery | (a) Script timeout raised to 120s; outer 125s (see P3.5). (b) P5 `ollama-tier3-warm-latency` gate runs every 15min and re-warms. (c) Fallback path via `pre-warm` hand-off to P4 wake_detector. |
| R2 | Manifest YAML parse break from the `llm_chain` replacement → daemon refuses to start | P3.2 requires `python3 yaml.safe_load` lint before kickstart. Backup file `.bak.<ts>` lives next to the manifest. Rollback: `cp .bak file`, kickstart. |
| R3 | `wake_detector.py` partial edit leaves orphaned `def`/call → Python SyntaxError → wake detector crashes → O6 regresses | V3.14 runs `ast.parse` BEFORE declaring P3.4 done. On failure: auto-restore from the timestamped backup (see P3.4 rollback snippet). This is the specific fix for the A-HIGH-3 judge finding where only lines 43-51 were deleted and orphaned 40-42 caused SyntaxError. |
| R4 | `ollama_memory_hog` evict target change fires during active tier-2 recovery and kills the model → recovery itself fails → O5 regresses | Threshold raised 4→14GB. Evict target is now the BIGGEST model (gpt-oss:20b), which is only loaded by tier 3. Tier-2 qwen3:8b stays loaded. |
| R5 | Seed script run on a machine without a daemon-created DB → no `patterns` table → error | Precondition `CREATE TABLE IF NOT EXISTS patterns …` inside the seed script itself (see P3.3), schema lifted verbatim from GuardDB.ts:82-96. Validated via V3.8. |
| R6 | `~` literal in a JS/TS string silently creates `./~/.ping-guard/guard.db` in the cwd | Hard rule in P3.3: `path.join(homedir(), …)` only. Enforced by V3.6 grep. |
| R7 | `--argjson kl "15m"` would fail silently on payload build and return exit 3 every time | P3.1 uses `--arg kl`. V3.2 greps for the forbidden pattern (must be 0). V3.3 shellcheck pass reinforces. |
| R8 | Seed script overwrites learned confidences back down to 0.5, destroying real learning from the daemon | `UPDATE … WHERE confidence < ?` guardrail (V3.7 assertion). Any row already ≥0.5 is left alone. |
| R9 | Ollama daemon not running at kickstart → every LLM tier exits 3 → falls through to rules → O5 still met because command-path patterns are seeded | Preflight check in each tier. Rules fallback guaranteed by P3.3 seeding. Doctor gate `selfheal-ollama-reachable` (owned by P5) alerts if Ollama stays down >15min. |
| R10 | Stale `incidents` rows reference deleted tier names in `rca_summary` text | Not destructive — historical audit data is fine. V3.8 specifically scopes to `detected_at > now()-2min` to check only post-kickstart rows. |

---

## Dependencies

- **phase-0-prep** must be complete (worktree active, disk cleaned, baseline snapshot).
- **Ollama models present locally** — verified 2026-04-18 via `ollama list`: llama3.2:latest (2.0GB), qwen3:8b (5.2GB), gpt-oss:20b (13GB). No pulls required.
- **ping-guard daemon installed** — `launchctl list com.ping-guard.daemon` must resolve. If missing, install per `ping-guard/docs/setup.md` before this phase.
- **`bun` on PATH** — required by P3.3 (`bun run`).
- **`jq` on PATH** — required by P3.1 (payload build + response parse).
- **`shellcheck` on PATH** — required by V3.3. Install: `brew install shellcheck`.
- **Docker running** — required by F3.10 canary (stops/starts `ping-mem-neo4j`).

## Blocks

- **phase-5-observability-doctor**: the self-heal doctor gates (including `ollama-tier3-warm-latency` referenced in P3.5) depend on P3 being live, since they measure the chain this phase creates.
- **phase-7-soak-regression**: the 30-day soak's `self-heal-ollama-reachable` hard gate and the `pattern-confidence-nonzero` soft gate can only run after P3.3 seeds confidence and P3.7 reloads the daemon. Without P3, the soak clock cannot start.
