---
title: "fix: Branch hygiene cleanup + systemic prevention"
type: fix
date: 2026-03-15
status: executing
github_issues: []
github_pr: null
research: "inline (git worktree list, git branch -a, gh pr list, skill/hook grep)"
synthesis: "inline"
eval_iteration: 0
review_iteration: 0
verification_iteration: 0
verification_method: "pending"
---

# Fix: Branch Hygiene Cleanup + Systemic Prevention

## Problem Statement

A zombie worktree (`.worktrees/feat/multi-agent-memory`) was discovered in another session, pointing to a branch whose PR (#11) was merged to main on 2026-03-07 — 8 days ago. Investigation reveals this is not isolated:

**Evidence gathered 2026-03-15:**
- 1 zombie worktree (merged branch, never cleaned)
- 5 stale local branches (3 from merged PRs, 2 with no PR and 91 commits behind main)
- 4 stale remote branches (merged PRs, branches not deleted on GitHub)
- 2 orphan stashes (on a merged branch)
- 5 systemic gaps in our skill/hook/memory stack that should have prevented this

**Impact**: Zombie worktrees consume disk space, confuse `git worktree list` collision detection, and — most critically — create false "existing worktree branch" warnings that block new worktree creation in future sessions.

## Proposed Solution

Two-phase approach:
1. **Phase 1 (Cleanup)**: Remove all zombies, stale branches, orphan stashes. Verify main is clean.
2. **Phase 2 (Prevention)**: Patch 4 systems (session-start hook, cc-connect, cc-memory, GitHub settings) so zombie accumulation is impossible.

```
┌─────────────────────────────────────────────────┐
│           Phase 1: Cleanup (one-time)           │
│                                                 │
│  Remove worktree → Delete local branches →      │
│  Delete remote branches → Drop stashes →        │
│  Handle PR #33 → /implementation-review main    │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│         Phase 2: Prevention (permanent)         │
│                                                 │
│  session-start hook: detect zombie worktrees    │
│  cc-connect: add worktree + stale branch scan   │
│  cc-memory: Tier 2 events for merge lifecycle   │
│  GitHub: enable auto-delete merged branches     │
│  worktree-first: enforce cleanup gate           │
└─────────────────────────────────────────────────┘
```

## Gap Coverage Matrix

| Gap ID | Description | Resolution | Phase |
|--------|-------------|------------|-------|
| G1 | Zombie worktree `.worktrees/feat/multi-agent-memory` | `git worktree remove` | 1 |
| G2 | Stale local branches (5) | `git branch -d` for merged, `-D` + user confirm for unmerged | 1 |
| G3 | Stale remote branches (4 merged) | `git push origin --delete` | 1 |
| G4 | Orphan stashes (2) | `git stash drop` after inspection | 1 |
| G5 | PR #33 open with failing CI | Decision: merge/close/fix — user decides | 1 |
| G6 | session-start hook has no worktree detection | Add `git worktree list` check | 2 |
| G7 | cc-connect has no worktree awareness | Add worktree + stale branch section | 2 |
| G8 | cc-memory has no merge lifecycle events | Add Tier 2 event type for merges | 2 |
| G9 | GitHub doesn't auto-delete merged branches | Enable via `gh api` settings | 2 |
| G10 | worktree-first cleanup is advisory, not enforced | Add pre-creation zombie check | 2 |
| G11 | No verification that main is clean after cleanup | Run `/implementation-review` on main | 1 |

## Critical Questions — Answers

| # | Question | Answer |
|---|----------|--------|
| Q1 | What to do with `feat/core-gaps` (1 commit, no PR, 91 behind)? | Inspect the single commit. If the change is already in main or trivially small, delete. If valuable, cherry-pick to a new branch off main. |
| Q2 | What to do with `feat/docs-guides` (8 commits, no PR, 91 behind)? | Inspect commits. If docs are still relevant, cherry-pick to new branch off main. If superseded by current docs, delete. |
| Q3 | What to do with PR #33 (`feat/intelligence-platform-self-improvement`)? | This is the CURRENT branch with 1 commit ahead of main. Options: (a) fix CI and merge, (b) close PR and merge commit to main directly, (c) close and discard. User decides. |
| Q4 | Should stashes be inspected before dropping? | Yes — `git stash show stash@{0}` and `stash@{1}` to verify nothing valuable. Both are on `feat/self-healing-health-monitor` which is already merged (PR #30). |
| Q5 | Should unmerged remote branches (`origin/feat/multi-project-discovery-and-docs`, `origin/fix/veracity-audit-issues`, `origin/launch-readiness`) be deleted even though `--is-ancestor` says UNMERGED? | Yes — their PRs (#5, #23, #8) were squash-merged, so the branch commits differ from main but the CONTENT is in main. Safe to delete. |
| Q6 | How aggressive should the session-start zombie detection be? | Warn-only on SessionStart (print to stderr for hook output). Do NOT auto-delete — user must confirm destructive actions. |
| Q7 | Should cc-connect run worktree checks across ALL projects or just the current one? | All projects in `active-projects.json` — cc-connect already iterates all projects, so add worktree check to each iteration. |

---

## Phase 1: Cleanup

### Step 1.1: Remove Zombie Worktree

```bash
# Verify it's fully merged (already confirmed)
git merge-base --is-ancestor feat/multi-agent-memory main  # exits 0

# Remove worktree
git worktree remove .worktrees/feat/multi-agent-memory

# Delete local branch
git branch -d feat/multi-agent-memory
```

**Quality gate**: `git worktree list` shows only the main working directory.

### Step 1.2: Delete Stale Local Branches (Merged PRs)

```bash
# These had PRs that were squash-merged — content is in main
git branch -D launch-readiness
git branch -D feat/multi-project-discovery-and-docs
```

**Quality gate**: `git branch` shows only `main`, `feat/core-gaps`, `feat/docs-guides`, `feat/intelligence-platform-self-improvement`.

### Step 1.3: Inspect and Decide on Unmerged Local Branches

```bash
# Inspect feat/core-gaps (1 commit)
git log main..feat/core-gaps --oneline -p  # Review the single commit

# Inspect feat/docs-guides (8 commits)
git log main..feat/docs-guides --oneline   # Review commit titles
```

**Decision**: User reviews output. For each branch:
- If content is in main or obsolete → `git branch -D <branch>`
- If content is valuable → `git cherry-pick <commit>` onto a new branch from main

**Quality gate**: Only `main` and `feat/intelligence-platform-self-improvement` remain (plus any cherry-pick branches).

### Step 1.4: Delete Stale Remote Branches

```bash
# Merged branches (--is-ancestor confirms)
git push origin --delete feat/multi-agent-memory
git push origin --delete feat/paro-memory-migration
git push origin --delete feat/self-healing-health-monitor
git push origin --delete feat/smart-ingestion-git-aware

# Squash-merged branches (PRs confirmed merged)
git push origin --delete feat/multi-project-discovery-and-docs
git push origin --delete fix/veracity-audit-issues
git push origin --delete launch-readiness

# Prune local remote-tracking refs
git remote prune origin
```

**Quality gate**: `git branch -r` shows only `origin/main`, `origin/HEAD`, and `origin/feat/intelligence-platform-self-improvement`.

### Step 1.5: Inspect and Drop Stashes

```bash
# Inspect stash contents
git stash show stash@{0}
git stash show stash@{1}

# If nothing valuable (both on already-merged branch)
git stash drop stash@{1}
git stash drop stash@{0}
```

**Quality gate**: `git stash list` returns empty.

### Step 1.6: Resolve PR #33

**User decision required.** Options:

| Option | Steps | Risk |
|--------|-------|------|
| A: Fix CI + merge | Fix failing diagnostics/benchmark CI, run /pr-zero, merge | Low — 1 commit, CI issues may be config |
| B: Close PR, keep commit | Close PR #33, rebase to main if needed | Low — work preserved on main |
| C: Close PR, discard | Close PR #33, reset to main | Medium — loses 1 commit of work |

### Step 1.7: Verify Main is Clean

```bash
# Switch to main
git checkout main
git pull origin main

# Quality gate
bun run typecheck && bun run lint && bun test
```

Then run `/implementation-review` on main to verify no issues.

**Quality gate**: All three pass. /implementation-review returns clean.

### Phase 1 Verification Checklist

| Check | Command | Expected | PASS/FAIL |
|-------|---------|----------|-----------|
| No zombie worktrees | `git worktree list` | Only main working dir | |
| No stale local branches | `git branch` | Only main + current | |
| No stale remote branches | `git branch -r` | Only origin/main + origin/HEAD (+ current if open) | |
| No orphan stashes | `git stash list` | Empty | |
| Typecheck passes | `bun run typecheck` | 0 errors | |
| Lint passes | `bun run lint` | 0 errors | |
| Tests pass | `bun test` | All pass | |
| /implementation-review clean | Manual run | No critical issues | |

---

## Phase 2: Prevention

### Step 2.1: Patch `session-start-cleanup.py` — Add Zombie Worktree Detection

**File**: `~/.claude/hooks/session-start-cleanup.py`

**Current behavior**: Detects multiple sessions, cleans orphan MCP processes.

**Add**: After existing checks, run `git worktree list` in the current project directory. For each worktree, check if its branch has been merged to main. If yes, emit a warning.

```python
# NEW FUNCTION: detect_zombie_worktrees()
def detect_zombie_worktrees(project_dir: str) -> list[dict]:
    """Check for worktrees whose branches are already merged to main."""
    result = subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        cwd=project_dir, capture_output=True, text=True
    )
    if result.returncode != 0:
        return []

    zombies = []
    current_worktree = None
    current_branch = None

    for line in result.stdout.strip().split("\n"):
        if line.startswith("worktree "):
            current_worktree = line.split(" ", 1)[1]
        elif line.startswith("branch "):
            current_branch = line.split(" ", 1)[1].replace("refs/heads/", "")
        elif line == "":  # entry separator
            if current_worktree and current_branch and current_branch != "main":
                # Check if branch is ancestor of main
                check = subprocess.run(
                    ["git", "merge-base", "--is-ancestor", current_branch, "main"],
                    cwd=project_dir, capture_output=True
                )
                if check.returncode == 0:  # is ancestor = merged
                    zombies.append({
                        "path": current_worktree,
                        "branch": current_branch
                    })
            current_worktree = None
            current_branch = None

    return zombies
```

**Integration point**: Call `detect_zombie_worktrees()` at the end of the main session-start flow. Print warnings to stderr (hook output visible to the agent).

**Output format** (printed to stderr for hook consumers):
```
ZOMBIE_WORKTREES: 1
  [1] branch: feat/multi-agent-memory
      path:   /Users/umasankr/Projects/ping-mem/.worktrees/feat/multi-agent-memory
      merged: PR #11 on 2026-03-07
      action: run "git worktree remove .worktrees/feat/multi-agent-memory && git branch -d feat/multi-agent-memory"
```

**Also check**: Stale local branches (merged to main but not deleted) and stale remote branches.

```python
def detect_stale_branches(project_dir: str) -> dict:
    """Check for local branches merged to main but not deleted."""
    result = subprocess.run(
        ["git", "branch", "--merged", "main"],
        cwd=project_dir, capture_output=True, text=True
    )
    stale_local = []
    for line in result.stdout.strip().split("\n"):
        branch = line.strip().lstrip("* ")
        if branch and branch != "main" and branch != "master":
            stale_local.append(branch)

    return {"stale_local": stale_local}
```

**Quality gate**: Hook runs on next session start. If zombie worktrees exist, warning appears in hook output.

### Step 2.2: Patch `cc-connect` Skill — Add Worktree + Branch Hygiene Section

**File**: `~/.claude/skills/cc-connect/SKILL.md`

**Current behavior**: For each project, checks git log, current branch, uncommitted changes, stashes, GitHub issues/PRs.

**Add to Phase 1 (Source 1: Git + GitHub)**: After existing git checks, add:

```bash
# Worktree status
git -C ~/Projects/<name> worktree list 2>/dev/null

# Stale branches (merged to main but not deleted)
git -C ~/Projects/<name> branch --merged main 2>/dev/null | grep -v '^\*\|main\|master'

# Stale remote branches (merged but not deleted)
for rb in $(git -C ~/Projects/<name> branch -r --merged main 2>/dev/null | grep -v 'HEAD\|main\|master'); do
  echo "STALE_REMOTE: $rb"
done
```

**Add to output template**: New section in the per-project summary:

```markdown
### Branch Hygiene
- Worktrees: N active (N zombie — merged but not cleaned)
- Stale local branches: [list]
- Stale remote branches: [list]
- Stashes: N (on branch: X — merged/active?)
- ACTION NEEDED: [specific cleanup commands if any zombies found]
```

**Quality gate**: Next `/cc-connect` run shows branch hygiene section for each project.

### Step 2.3: Patch `cc-memory` Skill — Add Merge Lifecycle to Tier 2

**File**: `~/.claude/skills/cc-memory/SKILL.md`

**Current behavior**: Tier 2 records decisions, pivots, outcomes, learnings. No branch lifecycle events.

**Add to "During Session (AUTOMATIC)" section**:

```markdown
- Branch merged (PR merged or manual merge) → WRITE Tier 2:
  {"date":"<date>","session":"<id>","type":"outcome","what":"Merged <branch> via PR #N",
   "source":"gh-pr-<N>","status":"completed",
   "cleanup":{"worktree":"removed|pending","local_branch":"deleted|pending","remote_branch":"deleted|pending"}}

- Worktree created → WRITE Tier 2:
  {"date":"<date>","session":"<id>","type":"decision","what":"Created worktree for <branch>",
   "why":"<task description>","status":"active"}

- Worktree removed → WRITE Tier 2:
  {"date":"<date>","session":"<id>","type":"outcome","what":"Removed worktree <branch>",
   "status":"completed"}
```

**Add "cleanup" field validation**: When recording a merge outcome, ALL three cleanup steps (worktree, local branch, remote branch) must be either "removed" or "not_applicable". If any is "pending", log a warning.

**Quality gate**: Next branch merge produces a Tier 2 entry with complete cleanup status.

### Step 2.4: Enable GitHub Auto-Delete Merged Branches

```bash
# Enable auto-delete head branches after PR merge
gh api repos/{owner}/{repo} -X PATCH -f delete_branch_on_merge=true
```

**Verification**:
```bash
gh api repos/{owner}/{repo} --jq '.delete_branch_on_merge'
# Expected: true
```

**Quality gate**: Next PR merge automatically deletes the remote branch.

### Step 2.5: Patch `worktree-first-workflow` — Pre-Creation Zombie Check

**File**: `~/.claude/skills/worktree-first-workflow/SKILL.md`

**Current behavior**: Step 0 runs `check-collisions.sh` for active worktrees. But doesn't check if existing worktrees are zombies.

**Add to Step 0 (Collision Detection)**: Before collision analysis, check for zombies:

```bash
# Check for zombie worktrees (merged branches with lingering worktrees)
for wt in $(git worktree list --porcelain | grep "^worktree " | cut -d' ' -f2-); do
  branch=$(git worktree list --porcelain | grep -A2 "^worktree $wt$" | grep "^branch " | sed 's/branch refs\/heads\///')
  if [ -n "$branch" ] && [ "$branch" != "main" ]; then
    if git merge-base --is-ancestor "$branch" main 2>/dev/null; then
      echo "ZOMBIE_WORKTREE: $wt (branch: $branch — already merged to main)"
      echo "  AUTO-CLEANUP: git worktree remove $wt && git branch -d $branch"
    fi
  fi
done
```

**Decision matrix addition**:

| Zombie worktrees found? | Action |
|--------------------------|--------|
| Yes | Auto-remove zombies BEFORE proceeding with new worktree creation. Log removal to Tier 2. |
| No | Continue to existing collision detection |

**Add to Step 5 (Completion Checklist)**: Make cleanup a BLOCKING gate, not advisory:

```
5. **After merge — cleanup (BLOCKING — do not end session without completing):**
   git worktree remove .worktrees/<branch-name>
   git branch -d <branch-name>
   # Remote branch auto-deleted by GitHub (Step 2.4)
   # Record Tier 2 outcome with cleanup status
```

**Quality gate**: Next worktree creation attempt auto-cleans any zombies first.

### Step 2.6: Add Memory Entry for This Incident

Record this incident in the appropriate memory systems so future sessions have context.

**Tier 2 entry** (`.ai/decisions.jsonl`):
```jsonl
{"date":"2026-03-15","session":"cleanup-session","type":"learning","what":"Discovered zombie worktree + 5 stale branches + 4 stale remote branches. Root cause: 5 gaps in skill/hook/memory stack (no worktree detection in session-start, cc-connect, cc-memory; no GitHub auto-delete; worktree-first cleanup advisory not enforced).","why":"Zombie worktree blocked new worktree creation in another session. Stale branches accumulated over 6 weeks.","status":"active"}
```

**Claude memory** (`~/.claude/projects/-Users-umasankr-Projects-ping-mem/memory/`):
- Update `MEMORY.md` with branch hygiene lesson learned

**Quality gate**: Memory entry exists and is discoverable by future sessions.

---

## Phase 2 Verification Checklist

| Check | How to Verify | Expected | PASS/FAIL |
|-------|---------------|----------|-----------|
| Session-start detects zombies | Create a test zombie worktree, start new session | Warning in hook output | |
| cc-connect shows branch hygiene | Run `/cc-connect` | "Branch Hygiene" section per project | |
| cc-memory records merge lifecycle | Merge a test PR | Tier 2 entry with cleanup status | |
| GitHub auto-deletes branches | Merge a test PR | Remote branch deleted automatically | |
| worktree-first auto-cleans zombies | Create zombie, then create new worktree | Zombie removed before new creation | |
| Memory entry discoverable | Start new session, check hook output | Incident context available | |

---

## Risk Analysis

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Auto-cleanup deletes a worktree with uncommitted work | HIGH | LOW | Zombie detection only flags branches merged to main — by definition, the work is already in main |
| GitHub auto-delete removes branch before local cleanup | LOW | MEDIUM | Local branch deletion is idempotent; `git branch -d` will say "already deleted" |
| Session-start hook becomes slow with many projects | LOW | LOW | `git worktree list` and `merge-base --is-ancestor` are fast (<100ms each) |
| Stale branch from force-push (rebased, not merged) | MEDIUM | LOW | Only auto-clean branches that are `--is-ancestor` of main — force-pushed branches won't match |
| `feat/core-gaps` or `feat/docs-guides` has valuable uncommitted work | MEDIUM | LOW | Step 1.3 requires manual inspection before deletion |

## Acceptance Criteria

### Functional
- [ ] Zero zombie worktrees after Phase 1
- [ ] Zero stale local branches after Phase 1
- [ ] Zero stale remote branches after Phase 1
- [ ] Zero orphan stashes after Phase 1
- [ ] `/implementation-review` on main returns clean
- [ ] Session-start hook warns on zombie worktrees
- [ ] `/cc-connect` reports branch hygiene per project
- [ ] Tier 2 records merge lifecycle events
- [ ] GitHub auto-deletes merged branches
- [ ] `worktree-first-workflow` auto-cleans zombies before creating new worktrees

### Non-Functional
- [ ] Session-start hook adds <500ms to startup
- [ ] No false positives (only flags branches actually merged to main)
- [ ] No destructive auto-actions without user confirmation (except zombie cleanup during worktree creation, which is safe by definition)

## Success Metrics

| Metric | Baseline (Today) | Target | Measurement |
|--------|-------------------|--------|-------------|
| Zombie worktrees | 1 | 0 (permanent) | `git worktree list` across all projects |
| Stale local branches | 5 | 0 (permanent) | `git branch --merged main` across all projects |
| Stale remote branches | 4+ | 0 (permanent) | `git branch -r --merged main` across all projects |
| Time to detect zombie | 8+ days (manual) | <1 session (<5 min) | Session-start hook detection |
| Merge-to-cleanup latency | Never (manual) | Same session | Tier 2 cleanup status tracking |

## Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| git | >=2.20 | `git worktree list --porcelain` support |
| gh CLI | >=2.0 | `gh api` for repo settings |
| Python 3 | >=3.8 | Session-start hook |

## Complete File Changes

```
~/.claude/hooks/session-start-cleanup.py     # MODIFY: add zombie worktree + stale branch detection
~/.claude/skills/cc-connect/SKILL.md         # MODIFY: add "Branch Hygiene" section to Phase 1
~/.claude/skills/cc-memory/SKILL.md          # MODIFY: add merge lifecycle Tier 2 events
~/.claude/skills/worktree-first-workflow/SKILL.md  # MODIFY: add pre-creation zombie check + blocking cleanup gate
<project>/.ai/decisions.jsonl                # APPEND: learning entry for this incident
~/.claude/projects/.../memory/MEMORY.md      # UPDATE: branch hygiene lesson
```

No new files created. No new dependencies. All changes are modifications to existing files.

## Effort Estimate

| Phase | Steps | Estimated Effort | Dependencies |
|-------|-------|------------------|--------------|
| Phase 1: Cleanup | 1.1–1.7 | 15–30 min | User decision on Q1–Q3 |
| Phase 2: Prevention | 2.1–2.6 | 45–60 min | Phase 1 complete |
| Total | | 60–90 min | |

## Appendix: Exact Branch State (Evidence Snapshot 2026-03-15)

```
$ git worktree list
/Users/umasankr/Projects/ping-mem                                    ee4d1a4 [feat/intelligence-platform-self-improvement]
/Users/umasankr/Projects/ping-mem/.worktrees/feat/multi-agent-memory 1dcbdf6 [feat/multi-agent-memory]

$ git branch -a --no-merged main
  feat/core-gaps
  feat/docs-guides
* feat/intelligence-platform-self-improvement
  feat/multi-project-discovery-and-docs
  launch-readiness
  remotes/origin/feat/intelligence-platform-self-improvement
  remotes/origin/feat/multi-project-discovery-and-docs
  remotes/origin/fix/veracity-audit-issues
  remotes/origin/launch-readiness

$ git stash list
stash@{0}: On feat/self-healing-health-monitor: temp: manifest
stash@{1}: WIP on feat/self-healing-health-monitor: f3527be feat: add self-healing health monitor...

$ git merge-base --is-ancestor feat/multi-agent-memory main → YES (exit 0)
```
