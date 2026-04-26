---
"@glrs-dev/harness-opencode": patch
---

fix(pilot): prevent `git worktree add -B` collision between runs of the same plan.

Previously, every `pilot build` of the same plan constructed identical per-task branch names (`pilot/<slug>/<taskId>`). An aborted or failed prior run left `preserveOnFailure` worktrees alive (by design — so users can inspect), but those worktrees held the branch refs. The next `pilot build` tripped on `fatal: '<branch>' is already used by worktree at <prior-run-dir>`, failing T1 and cascade-blocking every downstream task.

Branch names now include the runId: `pilot/<slug>/<runId>/<taskId>`. Runs of the same plan no longer share a branch namespace; preserved worktrees from prior runs stay on disk for inspection but don't block new runs.

**Note on existing branches:** branches created by earlier pilot versions (without the runId segment) remain on disk as orphans. They won't be touched or reused by new runs. To clean up manually: `git branch --list 'pilot/*' | xargs -n1 git branch -D` (after confirming nothing valuable lives under those refs, and pruning any orphan worktrees with `git worktree prune`).
