---
description: Finalize, commit, squash, push, and open a PR for QA-passed changes. Handles both single-commit and multi-commit (hybrid-autonomy) flows.
---

The plan at $ARGUMENTS has passed QA review. Ship it.

Do exactly the following, asking for explicit user approval at each step. Use the `question` tool for every approval (fires OS notification). Do NOT skip approvals.

## 1. Survey the working state

Run in parallel:
- `git status` — are there uncommitted or staged changes?
- `git log --oneline origin/$(git rev-parse --abbrev-ref HEAD)..HEAD` — list local commits ahead of origin (if the branch doesn't exist on origin, this will error — fall back to `git log $(git merge-base HEAD origin/main)..HEAD`)
- `git diff --stat` — summarize file-level impact of everything (committed + uncommitted)

Show all three outputs to the user.

Classify the shape:
- **Clean + no local commits** — nothing to ship; tell the user and STOP.
- **Dirty + no local commits** — single-commit flow (path A below).
- **Clean + local commits** — push flow (path C below).
- **Dirty + local commits** — hybrid flow (path B below).

## 2. Commit / squash path

### Path A — single commit (clean → dirty)

1. Read the plan's `# <Title>` and `## Goal`. Propose a commit message:

   ```
   <type>: <title in lower case>

   <one paragraph from the goal>

   Plan: .agent/plans/<slug>.md
   ```

   `<type>` is one of: feat, fix, chore, refactor, docs, test, perf.

2. Ask via `question` tool: "Commit with this message? (yes / edit / cancel)"
3. On `yes`: `git add -u` then commit.

### Path B — hybrid (local commits exist, plus uncommitted changes)

1. Propose: commit the uncommitted changes first (Path A), then squash all local commits into one using the plan title.
2. Ask via `question` tool: "Hybrid flow detected: <N> local commits + uncommitted changes. Commit remaining work and squash all into one commit? (yes / edit message / keep separate commits / cancel)"
3. On `yes`: commit the dirty changes, then:
   - Determine base: `git merge-base HEAD origin/main`
   - Propose final commit message (same format as Path A)
   - Ask: "Squash to this message? (yes / edit / cancel)"
   - On `yes`: `git reset --soft <base>` followed by `git commit -m "<msg>"`
4. On `keep separate commits`: commit the dirty changes normally, proceed to push with multiple commits.

### Path C — local commits only (clean + local commits)

1. Tell the user there's nothing new to commit. List the existing local commits.
2. Ask via `question` tool: "Squash <N> local commits into one before push, or push as-is? (squash / push as-is / cancel)"
3. On `squash`: follow Path B's squash sub-flow.
4. On `push as-is`: skip to step 3 below.

## 3. Push

1. Determine current branch: `git rev-parse --abbrev-ref HEAD`.
2. Ask via `question` tool: "Push to origin/<branch>? (yes / cancel)"
3. On `yes`: `git push -u origin <branch>` (sets upstream if first push).
4. If push fails due to non-fast-forward, STOP and report — do NOT `--force`.

## 4. Open a PR / MR

1. Ask via `question` tool: "Open a PR? (yes / skip)"
2. On `yes`: detect the git host from `git remote get-url origin` and pick the right CLI:
   - **GitHub** (`github.com` or `gh auth status` succeeds): `gh pr create --title "<commit-title>" --body "$(cat <plan-path>)"`
   - **GitLab** (`gitlab.com` or a self-hosted `*.gitlab.*`): `glab mr create --title "<commit-title>" --description "$(cat <plan-path>)"`
   - **Bitbucket** (`bitbucket.org`): `bb pr create --title "<commit-title>" --body "$(cat <plan-path>)"` (if `bb` is installed) or fall through to step 3
   - **Gitea / Codeberg** (`codeberg.org`, `gitea.*`): `tea pr create --title "<commit-title>" --description "$(cat <plan-path>)"`
   - **Unknown host or no CLI available**: construct the web URL to open the compare/new-PR page (e.g., `https://<host>/<owner>/<repo>/compare/<base>...<head>?expand=1` for GitHub-shape hosts) and print it. Tell the user to paste the plan body manually.
   Escape the plan body properly (beware of backticks, dollar signs, and newlines in shell-argument context).
3. Report the PR / MR URL.

## Hard rules

- Every approval via the `question` tool — never free-text chat.
- Never `git push --force` automatically. If non-fast-forward, stop and ask.
- Never rebase interactively without explicit user opt-in.
- `git reset --soft` is the squash mechanism; `git reset --hard` is forbidden for safety.
- **Never use `--no-verify` or `--no-gpg-sign`.** If a pre-commit or pre-push hook fails, STOP and report the hook failure. Fix the root cause (resolve the TODO, repair the lint error, update the plan's Out-of-scope section). If the user insists on bypass, they must type the bypass themselves.
- If anything looks unexpected at any step, STOP and ask.
