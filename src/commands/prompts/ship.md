---
description: Finalize, commit, squash, push, and open a PR for QA-passed changes. Handles both single-commit and multi-commit (hybrid-autonomy) flows.
---

The plan at $ARGUMENTS has passed QA review. Ship it.

**User invoking `/ship` IS the approval.** Execute the pipeline end-to-end without asking for per-step permission. Commits, pushes, and PR creation are not destructive — they're the whole point of this command. Only stop for genuinely unexpected states (see "Stop conditions" at the bottom).

Report what you did in one compact message at the end with the PR URL. Do NOT narrate each step individually.

## 1. Survey the working state

Run in parallel:
- `git status --short`
- `git log --oneline origin/$(git rev-parse --abbrev-ref HEAD)..HEAD 2>/dev/null || git log $(git merge-base HEAD origin/main)..HEAD --oneline` — local commits ahead of origin (or ahead of main if branch is not pushed)
- `git diff --stat`

Classify the shape silently and proceed:
- **Clean + no local commits** — nothing to ship; report "Nothing to ship — working tree clean and no local commits ahead of origin." and STOP.
- **Dirty + no local commits** — Path A.
- **Clean + local commits** — Path C.
- **Dirty + local commits** — Path B.

## 2. Commit / squash

### Path A — single commit

1. Derive a commit message:
   - If a plan path was given in `$ARGUMENTS` and the file exists, read its `# <Title>` and `## Goal` to shape the message.
   - If no plan, derive a title and paragraph from the diff itself (infer the `<type>`: feat / fix / chore / refactor / docs / test / perf).
2. Format:
   ```
   <type>: <title>

   <one paragraph summarizing what and why>

   Plan: .agent/plans/<slug>.md       ← only if a plan path was given
   ```
3. `git add -u && git commit -m "<subject>" -m "<body>"` — do it. No confirmation prompt.

### Path B — hybrid (local commits exist + uncommitted changes)

1. Commit the uncommitted changes using Path A's message logic (one atomic commit of the remaining work).
2. Squash all local commits into one:
   - Determine base: `BASE=$(git merge-base HEAD origin/main)`
   - Derive the final squash message from the plan (if given) or from the union of commit subjects.
   - `git reset --soft "$BASE" && git commit -m "<subject>" -m "<body>"`
3. No confirmation prompts. Just do it.

### Path C — local commits only, no dirty changes

- **Single local commit** → skip straight to push.
- **Multiple local commits** → squash to one using Path B's squash sub-flow (derive message from plan / commit subjects).

## 3. Push

1. `BRANCH=$(git rev-parse --abbrev-ref HEAD)`
2. `git push -u origin "$BRANCH"` — just do it. First push sets upstream automatically.
3. On non-fast-forward or hook failure → STOP (see stop conditions).

## 4. Open a PR

1. Detect the git host from `git remote get-url origin`.
2. Derive the PR body:
   - If a plan path was given and the file exists → body is the plan contents (escape backticks/dollar signs/newlines for shell).
   - Else → body is the commit's body (from `git log -1 --pretty=%b`).
3. Create the PR:
   - **GitHub**: `gh pr create --title "<subject>" --body "$(cat <path-or-tempfile>)"`
   - **GitLab**: `glab mr create --title "<subject>" --description "$(cat <path-or-tempfile>)"`
   - **Bitbucket**: `bb pr create --title "<subject>" --body "$(cat ...)"` (fall through if `bb` unavailable)
   - **Gitea / Codeberg**: `tea pr create --title "<subject>" --description "$(cat ...)"`
   - **Unknown host or no CLI**: construct and print the web URL (e.g., `https://<host>/<owner>/<repo>/compare/<base>...<head>?expand=1`). Report it so the user can open it manually.
4. Report the PR URL.

Prefer writing the body to a tempfile and using `--body-file` or `$(cat <tempfile>)` over inlining to dodge shell-escape bugs with backticks and dollar signs in plan content.

## Final report

One message, compact:

```
Shipped.
- Commit: <subject> (<sha>)
- Branch: <branch> → origin
- PR: <url>
```

## Stop conditions

Only stop and ask if:
- **Non-fast-forward push** — someone else pushed to this branch; never force. Report and ask what to do.
- **Pre-commit or pre-push hook failure** — NEVER use `--no-verify`. Report the hook output verbatim and ask the user. Fix the root cause if they direct you to.
- **Working tree shape doesn't match any of the four classes above** (e.g., detached HEAD, merge in progress, rebase in progress) — report and ask.
- **User has *unstaged* changes that look unrelated to the plan** — e.g., the plan says you're shipping a React refactor but the diff includes edits to unrelated files. Report the suspicious files and ask before committing them.

## Hard rules

- **Never** `git push --force` or `git push -f`. Permission-denied anyway. If non-fast-forward, stop and ask — the user decides.
- **Never** `git reset --hard`. Use `git reset --soft` only, and only for the squash case in Path B/C.
- **Never** use `--no-verify` or `--no-gpg-sign`. If a hook fails, stop and report.
- **Never** merge a PR — that's always the user's call.
- Everything else (commit, push, PR open, PR body write, upstream set) is a normal tool call. Just do it.
