# Continuation Package: First /full-system-zero Test Run on ping-mem
**Date**: 2026-04-12
**From**: Opus 4.6 (skill design session)
**To**: Fresh Opus 4.6 session for test execution
**Goal**: Run `/full-system-zero` on ping-mem, validate the skill family, and fix what's broken

---

## What was built in the previous session

A complete skill family for deterministic codebase auditing:

| Skill | Path | Purpose |
|-------|------|---------|
| `/full-system-zero` | `~/.claude/skills/full-system-zero/SKILL.md` | Meta-orchestrator with user gates |
| `/system-zero` | `~/.claude/skills/system-zero/SKILL.md` | Updated: Phase 0 mechanical scan + Phase 1 agent discovery |
| `/system-verify` | `~/.claude/skills/system-verify/SKILL.md` | Deterministic binary verification |
| `/system-execute` | `~/.claude/skills/system-execute/SKILL.md` | Gated execution, one commit per finding |

## What already exists from prior work

1. **Audit document**: `.ai/system-zero-audit-20260412.md` — 2-pass validated (4 verifier agents + 3 second-opinion agents), but produced WITHOUT Phase 0 mechanical scan

2. **Continuation package**: `docs/continuation-packages/continuation_20260412_system_zero_capability_verification.md` — contains runtime findings that static audit couldn't surface. READ THIS FIRST.

3. **Uncommitted working tree**: 25 files modified with runtime fixes from a prior Haiku session. These MUST be committed before or alongside any new work. See the continuation package for full file list.

4. **GH issues**:
   - usorama/ping-mem#116 — multi-model-opinion skill (separate workstream)

## What this session should do

### Option A: Fresh /full-system-zero run (recommended)
Run `/full-system-zero` from scratch. This tests the entire skill pipeline:
- Phase 0 mechanical scan (NEW — never run before)
- Phase 1 agent discovery (with Phase 0 inventory as input)
- User Gate 1
- Phase 2 verification (deterministic)
- User Gate 2
- Phase 3 execution (gated, per-item)

### Option B: Resume from existing audit
The audit doc exists but lacks a Findings Index and was produced without Phase 0. You could:
1. Run Phase 0 mechanical scan on the current codebase
2. Cross-reference against the existing audit — did it miss anything Phase 0 catches?
3. Generate the Findings Index from the existing audit
4. Proceed to /system-verify and /system-execute

### Option C: Fix what's broken first
The continuation package identifies 5 ingestion pipeline root causes that are FIXED in the working tree but not committed. Commit those first, then run /full-system-zero on the clean state.

## Critical context the next agent needs

### 1. The working tree is dirty with valuable fixes
Do NOT `git checkout -- .` or `git stash drop`. The uncommitted changes contain:
- Security fixes (path traversal guards, timing-safe auth)
- Performance fixes (BM25 batch transactions, fire-and-forget LLM extraction)
- Observability fixes (structured logging, health alerts surfaced)
- Infrastructure fixes (CausalGraphManager wiring, session timer unref)

### 2. The BM25/ingestion blast radius
If you touch anything in `src/ingest/`, `src/search/BM25Scorer.ts`, `src/graph/TemporalCodeGraph.ts`, or `src/http/rest-server.ts` — you're in the blast radius of critical runtime fixes. Read the diff before modifying.

### 3. The false positive that saved us
A Haiku agent flagged `src/mcp/proxy-cli.ts` as dead code. It's the recommended MCP transport entry point. The `/system-verify` skill was created specifically because of this — delete-and-typecheck is the only safe way to confirm dead code.

### 4. ping-mem's identity crisis
The user is frustrated that ping-mem claims to outclass mem0 and other systems but "fails miserably." The capabilities exist in code but many don't work at runtime:
- `codebase_impact` times out on its own codebase
- Ingestion was crashing every time until the fixes in this working tree
- Health probe was saying "ok" during active CRITICAL alerts
- 39/53 MCP tools have zero handler-execution tests

The audit should treat this as the primary finding: **the gap between paper capabilities and runtime capabilities is the #1 issue.** Dead code cleanup is secondary.

### 5. Key numbers
- 53 MCP tools registered
- ~100 REST endpoints
- 14 UI pages (HTMX server-rendered)
- 24 dead files identified (18 verified, 6 from second-opinion need verification)
- 1 HIGH security finding (auth bypass on tool-invoke)
- 5 unbounded fetch() calls (no timeout)
- 13/53 MCP tools have handler-execution tests
- 40/53 MCP tools pass smoke test against live container

### 6. The smoke test is the truth
`scripts/mcp-smoke-test.sh` tests all 53 MCP tools against the live Docker container. Unit tests pass with mocks that don't reflect reality. Run the smoke test after every change:
```bash
bash scripts/mcp-smoke-test.sh
```

---

## Suggested first command

```
/full-system-zero
```

Let the skill guide you. It starts with Phase 0 (mechanical scan), which has never been run on this codebase before. That alone will reveal whether our skill design works.
