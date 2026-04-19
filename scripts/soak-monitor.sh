#!/usr/bin/env bash
# Phase 7 — Soak Monitor
#
# Daily launchd script (com.ping-mem.soak-monitor, StartInterval=86400).
# Walks ~/.ping-mem/doctor-runs/*.jsonl, computes per-gate green streaks
# per the acceptance rules in tests/regression/soak-acceptance.md, and
# writes ~/.ping-mem/soak-state.json plus event log entries on clock resets.
#
# Exits 0 on success (including yellow/red states — soft failure = don't
# kill the launchd job, just update state). Non-zero only on hard errors
# (missing python, unreadable state dir, etc).
#
# Inputs:
#   ~/.ping-mem/doctor-runs/*.jsonl  — one JSON per line, see src/cli/commands/doctor.ts
#
# Outputs:
#   ~/.ping-mem/soak-state.json      — current soak state
#   ~/.ping-mem/soak-events.log      — append-only event log (clock resets)
#   stdout                            — human-readable daily summary
#
# Idempotent: running twice on the same day does not double-count.

set -euo pipefail

PING_MEM_DIR="${HOME}/.ping-mem"
DOCTOR_RUNS_DIR="${PING_MEM_DIR}/doctor-runs"
SOAK_STATE_FILE="${PING_MEM_DIR}/soak-state.json"
SOAK_EVENTS_FILE="${PING_MEM_DIR}/soak-events.log"

mkdir -p "${PING_MEM_DIR}"

if [[ ! -d "${DOCTOR_RUNS_DIR}" ]]; then
  echo "soak-monitor: no doctor-runs directory at ${DOCTOR_RUNS_DIR} — cannot compute soak state" >&2
  exit 1
fi

python3 - "${DOCTOR_RUNS_DIR}" "${SOAK_STATE_FILE}" "${SOAK_EVENTS_FILE}" <<'PYEOF'
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

doctor_runs_dir = Path(sys.argv[1])
state_file = Path(sys.argv[2])
events_file = Path(sys.argv[3])

# ---------- Config: maps acceptance IDs to doctor gate IDs ----------
# Kept in sync with tests/regression/soak-acceptance.md.

HARD_GATES = {
    "rest-health": ["service.rest-health", "service.rest-admin-auth"],
    "mcp-proxy-stdio": ["service.mcp-proxy-stdio"],
    "regression-queries-10-of-10": [
        f"regression.q{i}-*" for i in range(1, 11)
    ],
    "ingestion-coverage-ping-learn": ["data.commit-coverage", "data.file-coverage"],
    "ingestion-coverage-5-projects": ["data.commit-coverage", "data.file-coverage"],
    "self-heal-ollama-reachable": [
        "service.ollama-reachable",
        "service.ollama-model-qwen3",
        "selfheal.ollama-chain-reachable",
    ],
    "disk-below-90": ["infra.disk-free"],
    "session-cap-below-80%": ["service.session-cap-utilization"],
    "supervisor-no-rollback": ["loghyg.supervisor-no-rollback"],
    "doctor-launchd-ran": [],  # implicit — presence of ≥1 JSONL for the day
}

SOFT_GATES = {
    "orbstack-warm-latency": ["service.ollama-warm-latency"],
    "log-rotation-last-7d": ["loghyg.rotation-recent", "loghyg.log-file-size"],
    "pattern-confidence-nonzero": ["selfheal.pattern-library-confidence"],
    "auto-os-cross-project-hit": ["data.commit-coverage", "data.file-coverage"],
    "ping-mem-doctor-exec-time-below-10s": [],  # derived from run durationMs
}

SOFT_TOLERANCE_DAYS = 6
SOAK_TARGET_DAYS = 30

# ---------- Helpers ----------

def load_runs() -> List[dict]:
    """Load all doctor runs sorted by startedAt ascending."""
    runs: List[dict] = []
    for path in sorted(doctor_runs_dir.glob("*.jsonl")):
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    runs.append(json.loads(line))
        except (OSError, json.JSONDecodeError) as err:
            # Corrupt or partially-written run — skip rather than abort.
            print(f"soak-monitor: skipping unreadable {path.name}: {err}", file=sys.stderr)
    runs.sort(key=lambda r: r.get("startedAt", ""))
    return runs


def run_date(run: dict) -> date:
    """Extract UTC date from run.startedAt (ISO-8601)."""
    ts = run.get("startedAt", "")
    if ts.endswith("Z"):
        ts = ts.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(ts).astimezone(timezone.utc).date()
    except ValueError:
        return date.today()


def match_gate(gate_id: str, pattern: str) -> bool:
    """Glob-style match: `regression.q*-foo` against `regression.q1-foo`."""
    if "*" not in pattern:
        return gate_id == pattern
    import fnmatch
    return fnmatch.fnmatchcase(gate_id, pattern)


def gate_passed_any(run: dict, gate_patterns: List[str]) -> bool:
    """Did ALL listed gates pass in this run?"""
    if not gate_patterns:
        return True
    results = {r["id"]: r["status"] for r in run.get("results", [])}
    for pattern in gate_patterns:
        # Find all matching gate IDs; ALL of them must be pass.
        matched = [gid for gid in results if match_gate(gid, pattern)]
        if not matched:
            return False
        if not all(results[gid] == "pass" for gid in matched):
            return False
    return True


def regression_count_10_of_10(run: dict) -> bool:
    """Specialized check for the 10-canonical-query gate."""
    regs = [r for r in run.get("results", []) if r.get("group") == "regression"]
    if len(regs) < 10:
        return False
    return all(r["status"] == "pass" for r in regs[:10])


def exec_time_under_10s(run: dict) -> bool:
    return run.get("durationMs", 999_999) < 10_000


# ---------- Build per-day gate status ----------

runs = load_runs()
if not runs:
    print("soak-monitor: no doctor runs yet — baseline day 0", file=sys.stderr)
    runs = []

# runs_by_day[day] = list[run]
runs_by_day: Dict[date, List[dict]] = defaultdict(list)
for run in runs:
    runs_by_day[run_date(run)].append(run)

all_days = sorted(runs_by_day.keys())
today = datetime.now(timezone.utc).date()

# For each day, for each hard/soft gate, did it pass in at least one run?
def day_gate_pass(day: date, gate_id: str, gate_patterns: List[str]) -> bool:
    """Did this acceptance gate pass on this day?"""
    day_runs = runs_by_day.get(day, [])
    if not day_runs:
        return False  # doctor-launchd-ran red by implication

    if gate_id == "regression-queries-10-of-10":
        return any(regression_count_10_of_10(r) for r in day_runs)
    if gate_id == "ping-mem-doctor-exec-time-below-10s":
        return any(exec_time_under_10s(r) for r in day_runs)
    if gate_id == "doctor-launchd-ran":
        return len(day_runs) >= 1

    return any(gate_passed_any(r, gate_patterns) for r in day_runs)


# ---------- Compute streaks ----------

def streak_and_total(gate_id: str, gate_patterns: List[str], days_window: List[date]) -> Tuple[int, int, Optional[str]]:
    """Return (consecutive green days ending today, total days observed, last red ISO date)."""
    total = len(days_window)
    last_red: Optional[str] = None
    streak = 0
    # walk from most recent backwards
    for d in reversed(days_window):
        passed = day_gate_pass(d, gate_id, gate_patterns)
        if passed:
            if last_red is None:
                streak += 1
        else:
            if last_red is None:
                last_red = d.isoformat()
            # break the streak — don't count further
            break
    return streak, total, last_red


# Bound the window to last 60 days (enough for a 30-day soak + 30-day history).
cutoff = today - timedelta(days=60)
days_window = [d for d in all_days if d >= cutoff]
if not days_window:
    days_window = [today]

hard_state = {}
hard_any_red_streak_2 = False
for gate_id, patterns in HARD_GATES.items():
    streak, total, last_red = streak_and_total(gate_id, patterns, days_window)
    hard_state[gate_id] = {
        "streak_green_days": streak,
        "total_days": total,
        "last_red": last_red,
    }
    # Detect hard-red ≥2 consecutive days: check last 2 days both red.
    if len(days_window) >= 2:
        y1 = day_gate_pass(days_window[-1], gate_id, patterns)
        y2 = day_gate_pass(days_window[-2], gate_id, patterns)
        if not y1 and not y2:
            hard_any_red_streak_2 = True

soft_state = {}
soft_red_days_total = 0
for gate_id, patterns in SOFT_GATES.items():
    streak, total, last_red = streak_and_total(gate_id, patterns, days_window)
    # Count red days in last 30
    last_30 = days_window[-30:]
    red_in_window = sum(1 for d in last_30 if not day_gate_pass(d, gate_id, patterns))
    soft_state[gate_id] = {
        "streak_green_days": streak,
        "total_days": total,
        "last_red": last_red,
        "red_days_last_30": red_in_window,
        "tolerance_remaining": max(0, SOFT_TOLERANCE_DAYS - red_in_window),
    }
    soft_red_days_total = max(soft_red_days_total, red_in_window)


# ---------- Soak clock logic ----------

# Read prior state to preserve soak_start across runs.
prior_state: Dict = {}
if state_file.exists():
    try:
        prior_state = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        prior_state = {}

prior_soak_start = prior_state.get("soak_start")
if prior_soak_start:
    try:
        soak_start = date.fromisoformat(prior_soak_start)
    except ValueError:
        soak_start = today
else:
    soak_start = today

# Reset rule: any HARD gate red for ≥2 consecutive days → reset to today.
reset_reason = None
if hard_any_red_streak_2:
    for gate_id, patterns in HARD_GATES.items():
        if len(days_window) >= 2:
            y1 = day_gate_pass(days_window[-1], gate_id, patterns)
            y2 = day_gate_pass(days_window[-2], gate_id, patterns)
            if not y1 and not y2:
                reset_reason = f"hard-red-2d: {gate_id}"
                break
    if soak_start != today:
        # log the reset
        with events_file.open("a", encoding="utf-8") as f:
            evt = {
                "at": datetime.now(timezone.utc).isoformat(),
                "event": "soak_clock_reset",
                "prior_soak_start": soak_start.isoformat(),
                "reason": reset_reason,
            }
            f.write(json.dumps(evt) + "\n")
        soak_start = today

days_green = min(SOAK_TARGET_DAYS, (today - soak_start).days)
days_to_30 = max(0, SOAK_TARGET_DAYS - days_green)

# Current-status check (today-only)
hard_currently_green = all(
    day_gate_pass(today, gate_id, patterns)
    for gate_id, patterns in HARD_GATES.items()
)
soft_within_tolerance = soft_red_days_total <= SOFT_TOLERANCE_DAYS

if days_green >= SOAK_TARGET_DAYS and hard_currently_green and soft_within_tolerance:
    status = "green"
    message = "CONGRATULATIONS: 30-day soak clean"
elif any(
    (not day_gate_pass(today, gid, pats)) and (not day_gate_pass(days_window[-2], gid, pats) if len(days_window) >= 2 else False)
    for gid, pats in HARD_GATES.items()
):
    status = "red"
    message = "hard gate red ≥2 consecutive days — soak clock reset"
else:
    status = "yellow"
    message = (
        f"soak in progress: day {days_green}/{SOAK_TARGET_DAYS}, "
        f"hard_currently_green={hard_currently_green}, "
        f"soft_red_days={soft_red_days_total}/{SOFT_TOLERANCE_DAYS}"
    )

soak_state = {
    "as_of": datetime.now(timezone.utc).isoformat(),
    "soak_start": soak_start.isoformat(),
    "days_green": days_green,
    "days_to_30": days_to_30,
    "target_days": SOAK_TARGET_DAYS,
    "hard_gates": hard_state,
    "soft_gates": soft_state,
    "status": status,
    "message": message,
    "runs_observed": len(runs),
    "days_observed": len(days_window),
}

state_file.parent.mkdir(parents=True, exist_ok=True)
state_file.write_text(json.dumps(soak_state, indent=2) + "\n", encoding="utf-8")

print(f"soak-monitor: {message}")
print(f"  soak_start={soak_start.isoformat()} days_green={days_green}/{SOAK_TARGET_DAYS} status={status}")
print(f"  runs_observed={len(runs)} days_observed={len(days_window)}")
PYEOF

# Echo state for launchd stdout log
if [[ -f "${SOAK_STATE_FILE}" ]]; then
  echo "soak-monitor: state written to ${SOAK_STATE_FILE}"
  python3 -c "import json,sys; d=json.load(open('${SOAK_STATE_FILE}')); print(f'  status={d[\"status\"]} days_green={d[\"days_green\"]}/{d[\"target_days\"]}')"
fi

exit 0
