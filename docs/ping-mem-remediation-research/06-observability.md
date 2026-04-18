# R6 — Observability: `ping-mem-doctor` + `/ui/health` + launchd alerting

**Section F of hard scope.** Binary pass/fail doctor command, dashboard, launchd timer, macOS notifications, and soak gate arithmetic.

## Current State (enumerated)

**`src/observability/`**
- `health-probes.ts` (10 KB) — `probeSystemHealth()` returns `HealthSnapshot` with per-component `healthy|degraded|unhealthy|not_configured` for sqlite/neo4j/qdrant/diagnostics. Has 8 s per-probe timeout. Used by REST `/health` and `HealthMonitor`. Error sanitizer strips control chars.
- `HealthMonitor.ts` (21 KB) — background fast + quality tick loops. Drives thresholds: `wal_size_bytes`, `freelist_ratio`, `integrity_ok`, `null_node_count`, `orphan_node_count`, `point_count_drift_pct`. Emits `HealthAlert{key, severity, source, message}`. No disk / log-dir / container checks yet.
- `__tests__/` — unit coverage.

**`src/http/ui/`**
- `dashboard.ts` (6 KB) — landing stats.
- `memories.ts`, `sessions.ts`, `events.ts`, `worklog.ts`, `knowledge.ts`, `agents.ts`, `insights.ts`, `mining.ts`, `profile.ts`, `codebase.ts`, `ingestion.ts`, `diagnostics.ts`, `eval.ts`, `chat-api.ts` — existing explorer/monitor views.
- `layout.ts`, `components.ts`, `routes.ts` — shell and registration.
- `partials/health.ts` — **tiny `registerHealthPartialRoute`** returning a single health dot (polled by HTMX from the nav header). Not a full page; reuses `probeSystemHealth()`.
- No `/ui/health` page. `/ui/diagnostics` is SARIF-findings, not service health.

**`package.json` `health` script** — 3 `curl`s (qdrant 6333, neo4j 7474, ping-mem 3003). Returns 0 on HTTP-reachable, misses: auth, container state, MCP stdio, data coverage, log hygiene, session cap, regression set.

## 1. Gate Set (29 gates, 6 categories)

Format: `ID NAME | CHECK | PASS | SEV`. SEV: `C`=critical (exit 2), `W`=warning (exit 1), `U`=unreachable (exit 3).

### Infrastructure (6)
| ID | Name | Check | Pass | Sev |
|----|------|-------|------|-----|
| INF-01 | disk-free | `df -k / \| awk 'NR==2{print int($5)}'` | `< 90` | C |
| INF-02 | log-dir-size | `du -sk ~/Library/Logs/ping-mem \| cut -f1` | `< 102400` (100 MB) | C |
| INF-03 | container-ping-mem | `docker inspect -f '{{.State.Running}}' ping-mem-rest` | `== true` | U |
| INF-04 | container-neo4j | `docker inspect -f '{{.State.Running}}' ping-mem-neo4j` | `== true` | C |
| INF-05 | container-qdrant | `docker inspect -f '{{.State.Running}}' ping-mem-qdrant` | `== true` | C |
| INF-06 | orbstack-reachable | `docker version --format '{{.Server.Version}}'` | exit 0 | U |

### Service Health (7)
| ID | Name | Check | Pass | Sev |
|----|------|-------|------|-----|
| SVC-01 | rest-health | `curl -sf -m 5 http://localhost:3003/health` | JSON `.status in [ok,degraded]` and all components `!= unhealthy` | U |
| SVC-02 | rest-stats-auth | `curl -sf -m 5 -u $PING_MEM_ADMIN_USER:$PING_MEM_ADMIN_PASS http://localhost:3003/api/v1/stats` | HTTP 200 | C |
| SVC-03 | mcp-proxy-stdio | spawn `ping-mem-mcp`, write `{"jsonrpc":"2.0","id":1,"method":"initialize",...}`, 5 s deadline | got valid `result.serverInfo` | C |
| SVC-04 | ollama-reachable (if `PING_MEM_OLLAMA_ENABLED=1`) | `curl -sf -m 3 http://localhost:11434/api/tags` | HTTP 200, ≥1 model | W |
| SVC-05 | active-sessions | `sqlite3 ~/.ping-mem/events.db 'SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL'` | `< 0.8 * SESSION_CAP` | W |
| SVC-06 | session-cap-not-hit-24h | `sqlite3 events.db "SELECT COUNT(*) FROM events WHERE type='session_cap_hit' AND ts > strftime('%s','now','-1 day')"` | `== 0` | C |
| SVC-07 | rest-p95-latency | `curl` `/api/v1/metrics/http` and read `p95_ms` | `< 500` | W |

### Data Coverage (4, looped per active project)
Active project = row in `projects` with `last_event_ts > now - 7d`.
| ID | Name | Check | Pass | Sev |
|----|------|-------|------|-----|
| DAT-01 | file-coverage | `ingested_files/$(git -C $path ls-files \| wc -l)` | `≥ 0.95` | C |
| DAT-02 | commit-coverage | `ingested_commits/$(git -C $path rev-list --count HEAD)` | `≥ 0.95` | C |
| DAT-03 | last-ingested-recent | `now - projects.last_ingested_at` | `< 86400 s` | C |
| DAT-04 | memory-sync-lag | write `$SENTINEL_FILE`, poll `context_get("sentinel")` until match | `< 60 s` | C |

### Self-Heal (3)
| ID | Name | Check | Pass | Sev |
|----|------|-------|------|-----|
| HEA-01 | pattern-library-baseline | `sqlite3 events.db "SELECT COUNT(*) FROM patterns WHERE confidence >= 0.3"` | `≥ 5` | W |
| HEA-02 | ollama-escalation | same as SVC-04 but required when `SELF_HEAL_TIER=ollama` | exit 0 | W |
| HEA-03 | reconcile-scheduled-consistency | either `launchctl list \| grep aos-reconcile-scheduled` exits 0 OR `grep -L 'aos-reconcile-scheduled' wake_detector.py` exits 0 | one of the two | C |

### Log Hygiene (3)
| ID | Name | Check | Pass | Sev |
|----|------|-------|------|-----|
| LOG-01 | per-file-size | `find ~/Library/Logs/ping-mem -type f -size +5M` | empty | W |
| LOG-02 | rotation-freshness | `stat -f %m ~/Library/Logs/ping-mem/.last-rotate` | `now - mtime < 7d` | W |
| LOG-03 | supervisor-no-rollback-24h | `grep -c 'ROLLBACK' ~/Library/Logs/ping-mem/supervisor.log` since `-1 day` | `== 0` | C |

### Regression Set (Section B.5) (5)
Canonical queries stored in `~/.ping-mem/regression-queries.json`. Each runs `mcp__ping-mem__context_search` and expects `≥1` hit.
| ID | Name | Query | Sev |
|----|------|-------|-----|
| REG-01 | recall-claude-md | `"CLAUDE.md forbidden patterns"` | C |
| REG-02 | recall-recent-decision | `"most recent architecture decision"` | C |
| REG-03 | recall-project-summary | `"ping-mem project summary"` | C |
| REG-04 | recall-deploy-runbook | `"deployment runbook staging"` | C |
| REG-05 | recall-credentials-location | `"credentials directory location"` | C |

### Alert-Store Integrity (1)
| ID | Name | Check | Pass | Sev |
|----|------|-------|------|-----|
| ALE-01 | alerts-db-writable | `sqlite3 ~/.ping-mem/alerts.db 'INSERT INTO selftest...; DELETE...'` | exit 0 | W |

**Total: 29 gates. ≥25 required. Met.**

## 2. Exit Codes

| Code | Meaning | Trigger |
|------|---------|---------|
| 0 | all green | every gate PASS |
| 1 | warning | ≥1 W-sev FAIL, no C-sev FAIL, REST reachable |
| 2 | critical | ≥1 C-sev FAIL, REST reachable |
| 3 | unreachable | INF-03/SVC-01 FAIL (ping-mem down — suppress cascading alerts) |

Precedence: `3 > 2 > 1 > 0`. Highest trumps.

## 3. Output Format

**Default (tty, colored):**
```
ping-mem-doctor  2026-04-18T11:32:14Z  (run 7a3f)
──────────────────────────────────────────────────────────────
CATEGORY         GATE                      RESULT   DETAIL
infrastructure   disk-free                 [PASS]   41% used
infrastructure   log-dir-size              [PASS]   38 MB
infrastructure   container-ping-mem        [PASS]   up 4d2h
...
data             file-coverage:ping-learn  [FAIL]   0.82 (expected ≥0.95)
──────────────────────────────────────────────────────────────
Summary: 27 pass · 1 warn · 1 fail · 0 unreachable
Exit: 2 (critical)
```

**`--json`:** `{runId, startedAt, finishedAt, exit, summary:{pass,warn,fail,unreach}, gates:[{id,name,category,sev,result,detail,durationMs}]}`.

**`--fix`:** allow-listed safe auto-remediations only:
- `LOG-01` → rotate via `logrotate -s state -f logrotate.conf`
- `SVC-05` → `DELETE FROM sessions WHERE ended_at IS NULL AND started_at < now - 24h` (zombie purge)
- `DAT-03` → `ping-mem ingest --project $name --incremental`
- never auto-touches containers, secrets, neo4j, qdrant data.

**`--gate <id>`:** run one gate; useful for launchd dedup and tests.

**`--continuous`:** run forever, one full sweep per interval; used by timer.

CLI file: `src/cli/doctor.ts`, bin entry `ping-mem-doctor` added to `package.json#bin`. Thin wrapper — gate runners live in `src/observability/doctor/gates/*.ts` (one file per category) behind a `GateRunner` interface `{id, sev, run(ctx): Promise<GateResult>}`.

## 4. launchd Timer

**`~/Library/LaunchAgents/com.ping-mem.doctor.plist`**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ping-mem.doctor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ping-mem-doctor</string>
    <string>--json</string>
    <string>--notify-on-change</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>~/Library/Logs/ping-mem-doctor/run.log</string>
  <key>StandardErrorPath</key><string>~/Library/Logs/ping-mem-doctor/run.err</string>
  <key>EnvironmentVariables</key><dict>
    <key>PING_MEM_ADMIN_USER</key><string>...</string>
    <key>PING_MEM_ADMIN_PASS</key><string>...</string>
  </dict>
</dict></plist>
```

**Notification pipeline** (runs inside doctor, not in a wrapper script — keeps dedup atomic):
1. On exit 2, for each FAILED gate not in dedup window, run:
   `osascript -e 'display notification "ping-mem: <gate.name> FAIL — <detail>" with title "ping-mem-doctor" subtitle "critical" sound name "Basso"'`
2. Append to `~/Library/Logs/ping-mem-doctor/alerts.log` (JSON-Lines: `{ts,runId,gateId,sev,detail}`).
3. Upsert dedup row in `~/.ping-mem/alerts.db` (see §7).

Install script `scripts/install-doctor.sh`:
```bash
cp packaging/com.ping-mem.doctor.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.ping-mem.doctor.plist 2>/dev/null
launchctl load -w ~/Library/LaunchAgents/com.ping-mem.doctor.plist
```

## 5. `/ui/health` Dashboard

New file `src/http/ui/health.ts` (wires into `routes.ts` at `app.get("/ui/health", …)`). Hono route, same `renderLayout` + nav entry.

**Data source:** reads the last `ping-mem-doctor --json` run from `~/.ping-mem/doctor-runs/` (ring buffer, 7 days). Optionally `?refresh=1` triggers in-process `runDoctor()` call (bounded to 1 request in flight via a shared `AbortController`).

**Layout:**
- Header: overall badge (green/yellow/red), exit code, last-run timestamp, "Run now" button (POST `/ui/api/doctor/run`, Basic-Auth).
- Category accordions (6): each shows an ordered table of gates.
- Per gate row: status dot, name, last-check ts, last-fail ts, last-detail, 7-day sparkline (inline SVG, 1 px per 15-min tick = 672 points × 2 px = 1344 px wide — downsample to 168 buckets = 1 per hour for compact render).
- Footer: auto-poll toggle (HTMX `hx-trigger="every 60s"` on a partial `/ui/partials/health/summary`).

**Storage:** `~/.ping-mem/doctor-runs/YYYY-MM-DD.jsonl` (one run-summary per line). Sparkline reads last 7 files, maps gate-id → hourly bucket worst-result.

**Auth:** same Basic-Auth guard used on `/ui/api/mining/start`. `/ui/health` itself is readable with existing UI auth.

## 6. Soak-Test Arithmetic (Section H)

**Hard gates (10)** — must be green 30 consecutive days for soak PASS. Any single day FAIL → soak FAIL, restart clock.
`INF-03, INF-04, INF-05, SVC-01, SVC-02, SVC-03, SVC-06, DAT-03, HEA-03, LOG-03`.

**Soft gates (5)** — may flap; soak passes if `green_days / 30 ≥ 0.8` (≥24 days green in 30).
`INF-01 (disk), INF-02 (log-dir), SVC-05 (active sessions), HEA-01 (pattern baseline), LOG-01 (per-file size)`.

**Regression gates (REG-01…05)**: rolled up — at least 4 of 5 green per day = day passes. <4 green = hard fail.

**Data coverage DAT-01, DAT-02, DAT-04**: hard per active project; any project fails 2 days in a row = soak FAIL.

**Daily verdict function (pseudo):**
```
day_green = all(hard green) AND (green_soft_count ≥ 4) AND (reg_green ≥ 4) AND (per_project_streaks OK)
soak_green = count(day_green for last 30) == 30
```

## 7. Alert Noise Control

**Dedup store** `~/.ping-mem/alerts.db`:
```sql
CREATE TABLE alerts (
  gate_id TEXT NOT NULL,
  detail_hash TEXT NOT NULL,
  first_fired_at INTEGER NOT NULL,
  last_fired_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (gate_id, detail_hash)
);
CREATE TABLE flap_history (
  gate_id TEXT NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL
);
```

**Rules:**
1. **60-min dedup:** if `now - last_fired_at < 3600` for `(gate_id, detail_hash)`, suppress notification; still log to `alerts.log` with `dedup=1`.
2. **Flap detection:** inspect `flap_history` last 10 min for `gate_id`. If transitions ≥ 3 (red→green→red pattern or denser), hold notification for 15 min cool-down. Record `flap_suppressed=1`.
3. **Severity gating:** only exit-code 2 fires `osascript` popup. Exit 1 writes `alerts.log` + updates UI dot only.
4. **Cascade correlation:** if exit 3 (ping-mem unreachable), emit ONE "ping-mem down" notification and tag all downstream FAILs with `cascade_parent=SVC-01`; those children are NOT separately notified. When SVC-01 recovers, issue a single "ping-mem up, resuming gate alerts" notification.
5. **Nightly roll-up:** launchd `com.ping-mem.doctor.digest.plist` (`StartCalendarInterval` 09:00) emails/logs a 24-hour gate summary so suppressed non-critical issues remain visible.

## 8. Mock Console Runs

**All-green:**
```
$ ping-mem-doctor
ping-mem-doctor  2026-04-18T11:32:14Z  (run 7a3f91)
──────────────────────────────────────────────────────────────
CATEGORY         GATE                       RESULT   DETAIL
infrastructure   disk-free                  [PASS]   41% used
infrastructure   log-dir-size               [PASS]   38 MB
infrastructure   container-ping-mem         [PASS]   up 4d 2h
infrastructure   container-neo4j            [PASS]   up 4d 2h
infrastructure   container-qdrant           [PASS]   up 4d 2h
infrastructure   orbstack-reachable         [PASS]   Docker 27.4.0
service          rest-health                [PASS]   sqlite+neo4j+qdrant healthy (48 ms)
service          rest-stats-auth            [PASS]   200 OK (31 ms)
service          mcp-proxy-stdio            [PASS]   initialize ok (420 ms)
service          ollama-reachable           [PASS]   6 models
service          active-sessions            [PASS]   3 / 50 (6%)
service          session-cap-not-hit-24h    [PASS]   0 hits
service          rest-p95-latency           [PASS]   186 ms
data             file-coverage:ping-learn   [PASS]   0.98 (412/420)
data             file-coverage:ping-mem     [PASS]   1.00 (287/287)
data             commit-coverage:ping-learn [PASS]   0.99 (1284/1290)
data             last-ingested:ping-learn   [PASS]   23 min ago
data             memory-sync-lag            [PASS]   4.2 s
self-heal        pattern-library-baseline   [PASS]   12 patterns ≥0.3
self-heal        ollama-escalation          [PASS]   tier reachable
self-heal        reconcile-scheduled        [PASS]   launchd job present
logs             per-file-size              [PASS]   max 2.1 MB
logs             rotation-freshness         [PASS]   rotated 18 h ago
logs             supervisor-no-rollback-24h [PASS]   0 rollbacks
regression       recall-claude-md           [PASS]   7 hits
regression       recall-recent-decision     [PASS]   3 hits
regression       recall-project-summary     [PASS]   9 hits
regression       recall-deploy-runbook      [PASS]   4 hits
regression       recall-credentials         [PASS]   2 hits
alerts           alerts-db-writable         [PASS]   rw ok
──────────────────────────────────────────────────────────────
Summary: 29 pass · 0 warn · 0 fail · 0 unreachable
Duration: 8.4 s
Exit: 0 (all green)
```

**One-red run:**
```
$ ping-mem-doctor
ping-mem-doctor  2026-04-18T11:47:02Z  (run 7a4012)
──────────────────────────────────────────────────────────────
CATEGORY         GATE                       RESULT   DETAIL
infrastructure   disk-free                  [PASS]   43% used
...
data             file-coverage:ping-learn   [FAIL]   0.82 (expected ≥0.95) — 76 files missing since last ingest
data             last-ingested:ping-learn   [WARN]   29h ago (expected <24h)
...
service          mcp-proxy-stdio            [PASS]   initialize ok (380 ms)
regression       recall-deploy-runbook      [FAIL]   0 hits (expected ≥1)
──────────────────────────────────────────────────────────────
Summary: 26 pass · 1 warn · 2 fail · 0 unreachable
Duration: 9.1 s
Exit: 2 (critical)
Notifications: 2 sent (file-coverage:ping-learn, recall-deploy-runbook)
                1 suppressed (last-ingested:ping-learn — warning severity, logged only)
Hint: run `ping-mem-doctor --fix --gate file-coverage:ping-learn` to trigger incremental re-ingest.
```

---

## Implementation Pointers

- `src/observability/doctor/runner.ts` — orchestrator (parallel gate exec with concurrency=6, per-gate 10 s timeout).
- `src/observability/doctor/gates/{infrastructure,service,data,self-heal,logs,regression,alerts}.ts` — one file per category; export `GateRunner[]`.
- `src/observability/doctor/dedup.ts` — owns `alerts.db`.
- `src/observability/doctor/sink.ts` — writes `doctor-runs/*.jsonl`, triggers `osascript`.
- `src/http/ui/health.ts` + `src/http/ui/partials/health-full.ts` — dashboard render + HTMX partial.
- `src/cli/doctor.ts` + `package.json#bin.ping-mem-doctor`.
- `packaging/com.ping-mem.doctor.plist` + `scripts/install-doctor.sh`.
- Replace the 3-curl `package.json#scripts.health` with `bun run dist/cli/doctor.js --json --quiet`.

Word count: ~1980.
