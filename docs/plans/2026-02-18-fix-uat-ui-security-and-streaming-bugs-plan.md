---
title: "fix: UAT UI security, streaming, and error handling bugs"
type: fix
date: 2026-02-18
github_issue: 7
version: 1.0.0
---

# fix: UAT UI security, streaming, and error handling bugs

## Overview

UAT testing of the Web UI Observability Dashboard revealed 6 bugs (3 CRITICAL, 3 HIGH) across 4 files. All bugs were found via automated E2E testing against a live REST server and code review.

## Fixes

### 1. Static Assets 404 (CRITICAL)
- [x] `rest-server.ts:1027` — Change `../../static` → `../../src/static` so `import.meta.dir` resolves correctly from `dist/http/`

### 2. Path Traversal Hardening (CRITICAL)
- [x] `rest-server.ts:1028-1031` — Use `path.resolve()` instead of `path.join()`, compare canonicalized paths with trailing separator

### 3. hx-vals Double-Encoding (CRITICAL)
- [x] `ingestion.ts:53` — Switch from single-quoted to double-quoted attribute so `&quot;` entities are correctly decoded by browsers

### 4. Partial Stream Fallback (HIGH)
- [x] `LLMProxy.ts:68-78` — Move `yielded` flag outside try block, check in catch to skip Gemini fallback if Ollama already sent chunks

### 5. Stream Timeout Reset (HIGH)
- [x] `LLMProxy.ts:168-170` — Reset `setTimeout` on each chunk instead of just clearing once, preventing indefinite hangs on stalled models

### 6. Dashboard Error Boundary (HIGH)
- [x] `dashboard.ts:14-89` — Wrap entire handler in try-catch, return user-friendly error page instead of raw 500

## Acceptance Criteria

- [x] All 4 UI routes return 200
- [x] All 3 static assets return 200
- [x] Path traversal attempts return 404/403
- [x] TypeScript: 0 errors
- [x] Tests: 1021 pass, 0 fail

## References

- GitHub Issue: #7
- UAT Session: 2026-02-18
- Parent plan: `2026-02-18-feat-ping-mem-web-ui-observability-dashboard-plan.md`
