# 🔄 Continue PR Zero Cycle 23 — AdminStore UUID Regression + Full Cycle Completion

**Generated**: 2026-03-13
**Branch**: `feat/self-healing-health-monitor`
**PR**: #30
**Last Committed**: `c232856 fix: PR Zero cycle 22 — /tmp removed, SSRF scheme restriction, HTML encoding, log injection sanitization`
**Status**: Cycle 23 fixes in-progress (NOT YET COMMITTED — uncommitted changes exist)

---

## CRITICAL: Uncommitted Changes Present

The following files have Cycle 23 fixes applied but NOT yet committed:

- `src/admin/AdminStore.ts` — `generateUUID()` changed to `crypto.randomUUID()`
- `src/http/admin.ts` — ~30 fixes (CSRF, escapeHtml, respondJson, auth, async fs, etc.)
- `src/http/__tests__/admin.test.ts` — process.env antipattern fix, new error containment tests, `makeReq` async iterator fix
- `src/validation/admin-schemas.ts` — `.refine()` removed from `projectDir` (now dead code after trim reorder), comment updated
- `src/validation/__tests__/admin-schemas.test.ts` — test updated to not assert specific error message

---

## BLOCKER: 2 Failing Tests (Regression from Our Changes)

`bun test` shows **2 failing tests** introduced by Cycle 23 changes:

```
(fail) AdminStore > API Key Create / List / Validate / Deactivate > should list all API keys
(fail) AdminStore > API Key Create / List / Validate / Deactivate > should deactivate all old keys with deactivateOld option
```

**Error**: `SQLiteError: UNIQUE constraint failed: admin_api_keys.id`

**Root cause (partially diagnosed)**:
- Tests pass in isolation: `bun test src/admin/` → 22/22 pass
- Tests FAIL in full suite: `bun test` → 2 fail
- The contaminating test directory is **`src/graph/__tests__/`** (confirmed by binary search)
- Specific file within graph/__tests__/ NOT yet identified (each file ran individually with AdminStore showed pass, but running the full directory together fails)
- Hypothesis: `src/graph/__tests__/` tests create a non-`:memory:` AdminStore or pollute the `crypto` module in a way that makes `crypto.randomUUID()` produce collisions

**Change that introduced regression**: In `src/admin/AdminStore.ts`, `generateUUID()` was changed from the bespoke timestamp+random implementation to `crypto.randomUUID()`. The old implementation used `crypto.randomBytes(10)` which never caused this problem.

**Investigation progress**:
```bash
# These pass:
bun test src/admin/                                        # 32 pass
bun test src/admin/ src/http/ src/validation/              # 336 pass
bun test src/admin/ src/diagnostics/ src/graph/            # FAILS

# Individual graph files also pass:
bun test src/admin/__tests__/AdminStore.test.ts src/graph/__tests__/TemporalCodeGraph.test.ts  # 29 pass
bun test src/admin/__tests__/AdminStore.test.ts src/graph/__tests__/  # FAILS (400 tests, 2 fail)
# → specific culprit file within graph/__tests__/ not isolated yet (looping through each file individually all showed pass)
```

**The mystery**: Running each graph test file individually with AdminStore shows pass, but the full `src/graph/__tests__/` directory together fails. This suggests it's a **combination of multiple graph test files** that causes the contamination, not a single file.

---

## Immediate Next Steps (in order)

### Step 1: Fix the AdminStore UUID regression

**Options to investigate**:

A) **Revert `generateUUID()` to use `crypto.randomBytes`** (safest — restores the working implementation while still being secure random):
```typescript
private generateUUID(): string {
  // crypto.randomUUID() shows inter-test interference in the full suite when
  // combined with src/graph/__tests__/. Using randomBytes-based v4 UUID avoids
  // the contamination while remaining cryptographically secure.
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant RFC 4122
  return [
    bytes.slice(0, 4).toString("hex"),
    bytes.slice(4, 6).toString("hex"),
    bytes.slice(6, 8).toString("hex"),
    bytes.slice(8, 10).toString("hex"),
    bytes.slice(10, 16).toString("hex"),
  ].join("-");
}
```

B) **Investigate graph/__tests__ tests** to find what they do that contaminates the UUID space (look for any mocking of `crypto`, `Math.random`, or module-level AdminStore creation)

C) **Check if graph tests mock `crypto.randomUUID`** via `mock.module()` which in Bun is process-global

**Recommendation**: Start with option B first (grep graph tests for any crypto mock), then fall back to option A if needed.

```bash
grep -r "crypto\|randomUUID\|randomBytes\|mock.module" src/graph/__tests__/ --include="*.ts" | head -30
```

### Step 2: Verify all 1556 tests pass

```bash
bun run typecheck && bun test
# Target: 1556 pass, 0 fail
```

### Step 3: Commit Cycle 23 fixes

```bash
git add src/admin/AdminStore.ts src/http/__tests__/admin.test.ts src/http/admin.ts src/validation/__tests__/admin-schemas.test.ts src/validation/admin-schemas.ts
git commit -m "fix: PR Zero cycle 23 — error containment, escapeHtml, CSRF Host, async fs, DOM guards, trim order"
git push
```

### Step 4: Launch Cycle 24 Review

Run three review agents in parallel:
- `compound-engineering:review:security-sentinel`
- `pr-review-toolkit:code-reviewer`
- `pr-review-toolkit:silent-failure-hunter`

Continue PR Zero loop until zero findings across ALL tiers.

---

## Context: What Cycle 23 Fixed

All fixes applied to 4 files. Here is the complete list:

### src/admin/AdminStore.ts
- `generateUUID()`: Changed bespoke timestamp-prefix implementation to `crypto.randomUUID()` ← **THIS CAUSED THE REGRESSION**

### src/validation/admin-schemas.ts
- `projectDir`: Removed dead `.refine()` (was redundant after `.trim().min(1)` reorder); updated comment
- `apiKey`: Reordered to `.trim().min(1).max(10_000)` (trim fires before min check)
- `model`: Reordered to `.trim().min(1).max(500)` (same)

### src/http/admin.ts (major file — many changes)
- Import changed to `import * as fs from "fs/promises"` (was `"fs"`)
- `ADMIN_RATE_LIMIT_MAX` exported (was private const)
- `_isProjectDirSafe`: HOME validation (must be >3 chars, absolute path)
- `isLockedOut`: Eagerly evicts expired lockouts
- `sanitizeAdminError`: Added `.slice(0, 4096)` length cap
- `escapeHtml`: Added `'` → `&#39;` single-quote escape
- `respondJson`: try/catch around JSON.stringify, Cache-Control: no-store, Content-Length header
- `/admin` page response: Cache-Control: no-store added
- CSRF check: Absent Host → 400 (was warn+continue)
- `handleAdminRequest`: Top-level try/catch wraps `handleAdminApi`
- `handleAdminApi`: All AdminStore calls (listProjects, listApiKeys, createApiKey, deactivateApiKey, getLLMConfig) wrapped in individual try/catch → 500 on failure
- `catch (error: unknown)` typing for setLLMConfig
- Partial-delete warnings apply `sanitizeAdminError()`
- `deleteProjectManifest`: Converted to async using fs.promises
- `resolveProjectId`: TOCTOU existsSync removed
- `renderAdminPage`: providersJson uses `escapeHtml()`, apiFetch checks ok before json()
- All DOM `getElementById` calls null-guarded
- `rotateKey`: null-check on result.key and DOM elements
- `refreshKeys`, `refreshProjects`: null-checks on table elements
- `loadLLMConfig`, `saveLLMConfig`: null-checks on all getElementById
- Dead `if (state.apiKey)` block removed
- `checkBasicAuth`: RFC 7235 case-insensitive scheme normalization

### src/http/__tests__/admin.test.ts
- `ADMIN_RATE_LIMIT_MAX` imported and used instead of magic number 20
- `createMockResponse`: Added `body` capture and `headersSent` property
- `process.env` antipattern fixed in all 4 describe blocks (specific key delete/set)
- New test: POST with absent Host → 400
- New test: invalid API key → 401 before CSRF
- New `describe("handleAdminApi error containment")` block: 5 tests for listProjects/listApiKeys/createApiKey/deactivateApiKey/getLLMConfig throwing → 500
- `makeReq`: Fixed to use `[Symbol.asyncIterator]` instead of `.on` (readJsonBody uses `for await`)

### src/validation/__tests__/admin-schemas.test.ts
- Test "should reject empty projectDir" updated to not assert specific error message text (since `.trim().min(1)` fires first with different message than the old `.refine()`)

---

## PR Zero Protocol Reminder

- **Standing directive**: "don't end /pr-zero until 0 review cycle"
- **Zero means zero**: ALL tiers, ALL origins (in-scope, pre-existing, adjacent files)
- **No deferral**: Every finding must be fixed in the current PR
- **Quality gate**: `bun run typecheck && bun test` must pass before each commit
- **Cycle limit**: Max 5 cycles from current position; if not clean by then, report UNRESOLVED

---

## To Continue in Next Session

```
Read /Users/umasankr/Projects/ping-mem/docs/continuation-packages/continuation_20260313_pr_zero_cycle23.md

Then:
1. Fix the AdminStore UUID regression (Step 1 above)
2. Run bun run typecheck && bun test (must be 0 failures)
3. Commit Cycle 23 fixes
4. Push to origin
5. Launch Cycle 24 review agents in parallel
6. Continue PR Zero loop until zero findings
```
