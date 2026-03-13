# Lessons Learned — Deterministic Search Quality Plan

**Date**: 2026-03-09
**Plan**: docs/plans/2026-03-09-deterministic-search-quality.md
**Skill version**: deterministic-plan v2.0

---

## What Worked Well

1. **Synthesis before plan** — Writing the 7 founding principles + ADRs + gap analysis (doc 06) before starting the plan prevented scope creep. The plan stayed exactly on the three issues (#26, #27, #28) without adding unrelated features.

2. **VERIFY agent (10/10)** — All 10 codebase claims in the plan were accurate. The codebase investigation phase (reading PingMemServer, CodeIndexer, rest-server, KnowledgeStore, SDK .d.ts files with exact line numbers) paid off.

3. **Parallel EVAL agents caught what VERIFY missed** — VERIFY checks factual accuracy; EVAL catches logical bugs (column weights, trigger semantics, constructor ordering). Running both is essential.

4. **Security agent found critical auth gap** — The MCP endpoint auth bypass would have shipped as a security vulnerability. The security-focused EVAL agent caught it.

5. **Performance agent quantified transaction cost** — "Wrap in a transaction" advice is common, but the agent gave the specific cost: ~10s without transaction vs ~150ms with (100x), making the priority unambiguous.

---

## What Could Improve

1. **Session compaction interrupted research phase** — 4 of 5 research agents hit quota limits and failed to write their output files. The plan had to be reconstructed from session transcript. Session summaries preserve agent findings but require reconstruction effort. **Mitigation**: Have research agents write files progressively (section by section) rather than all at once at the end.

2. **INSERT OR REPLACE / FTS5 trigger bug** — The plan's risk matrix originally stated "FTS5 UPDATE triggers handle replace" — this is factually wrong. INSERT OR REPLACE fires DELETE+INSERT at the SQLite engine level, not UPDATE triggers. This was caught by 3 separate agents (performance, completeness, architecture). Should have been caught in the initial synthesis. **Mitigation**: Add FTS5 trigger semantics to the founding principles list for plans involving SQLite FTS5.

3. **bun:sqlite WAL default assumption** — The plan falsely claimed "bun:sqlite uses WAL by default." This is incorrect — WAL must be set explicitly. Every other store in the codebase sets it manually, which should have been the signal. **Mitigation**: Before writing any plan involving SQLite, grep for `PRAGMA journal_mode` to understand the project's conventions.

4. **Column weight direction** — `bm25(table, w0, w1)` where w0=2.0 was backwards (prioritized file_path over content). The weights are positional and match column order in CREATE VIRTUAL TABLE. **Mitigation**: Always note column order explicitly in the FTS5 CREATE VIRTUAL TABLE SQL comment.

5. **HTTPServerConfig in types.ts not rest-server.ts** — The plan said to edit `rest-server.ts` for a type that lives in `types.ts`. A single grep for `interface HTTPServerConfig` before writing the plan would have caught this. **Mitigation**: Always verify type locations via grep before writing integration point instructions.

---

## Bugs Found Per Validation Pass

| Pass | Agent(s) | Bugs Found | Critical/High |
|------|----------|------------|---------------|
| VERIFY | 1 codebase agent | 0 | 0 — all claims accurate |
| EVAL (security) | 1 security agent | 4 | 2 critical, 2 high |
| EVAL (performance) | 1 performance agent | 4 | 2 high, 2 medium |
| EVAL (completeness) | 1 completeness agent | 8 | 2 high, 3 medium, 3 low |
| REVIEW (architecture) | 1 architecture agent | 5 | 3 high, 2 medium |
| **Total** | **5 agents** | **21** | **2C + 7H + 5M + 7L** |

---

## Quality Standards Updates

- **ALWAYS set WAL explicitly**: `this.db.run("PRAGMA journal_mode = WAL")` in any new SQLite store. Never assume defaults.
- **FTS5 column weights are positional**: Write column names and weights side-by-side in comments (`col0=file_path×1.0, col1=content×2.0`).
- **FTS5 upsert pattern**: Use `INSERT ... ON CONFLICT(chunk_id) DO UPDATE SET ...` not `INSERT OR REPLACE`. Document the trigger semantics reason in code comments.
- **Transaction wrapping for bulk SQLite writes**: Always wrap bulk insert loops in `db.transaction(() => { ... })()`. Never loop individual `run()` calls without a transaction.
- **Type locations**: Before writing integration points, grep for interface/type definitions rather than assuming they're in the primary class file.
- **Auth coverage verification**: Before writing any new HTTP route, check the existing auth middleware's path patterns. Never assume wildcard coverage extends to new paths.

---

## Time Estimate (Actual vs Expected)

| Step | Expected | Actual |
|------|----------|--------|
| Research (6 agents) | 30 min | 3+ hours (4/5 agents hit quota, reconstruction required) |
| Synthesis + plan writing | 1 hour | 2 hours |
| EVAL + REVIEW + VERIFY (5 parallel agents) | 30 min | 3 hours (ran overnight, cross-session) |
| Plan amendment | 30 min | 45 min |
| **Total** | 2.5 hours | ~9 hours |

Primary time loss: agent quota failures requiring reconstruction.

---

## Improvements to deterministic-plan Skill

1. **Research agents should write incrementally** — each section of the research document should be written as it's completed, not all at once. This way, partial output is preserved if the agent hits quota.

2. **Add "WAL pragma verification" to the plan checklist** — when any plan involves creating a new SQLite store, the checklist item should read: "grep codebase for `PRAGMA journal_mode` to understand convention, ensure new store matches."

3. **FTS5 pitfalls subsection** — Add a subsection to Common Pitfalls covering:
   - INSERT OR REPLACE fires DELETE+INSERT triggers (not UPDATE triggers)
   - bm25() returns negative values (multiply by -1 for positive scores)
   - Column weights are positional (match column order in CREATE VIRTUAL TABLE)
   - WAL must be set explicitly
