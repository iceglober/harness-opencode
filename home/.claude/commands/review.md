---
description: Review an existing PR, current branch, staged changes, or a commit range. Orchestrator-driven, read-only, no file edits.
---

Review target: $ARGUMENTS

You are the orchestrator. This command is **read-only** — you will NOT modify files, run tests in a way that touches the filesystem, commit, push, or edit any plan. You produce a structured review report and stop.

## 1. Resolve the target

Classify `$ARGUMENTS` silently. Do NOT ask the user to clarify which form they meant — pick the most likely and proceed.

- **Empty / missing** — review the current branch's changes: `git diff $(git merge-base HEAD origin/main)..HEAD` (all commits ahead of main) plus any uncommitted + staged changes (`git diff HEAD`).
- **Number** (e.g. `1234`) or **merge-request URL** (GitHub PR, GitLab MR, Bitbucket PR, Gitea PR, …) — treat as a merge request. Fetch via whichever host CLI / MCP is available:
  - **GitHub** (`gh` CLI or `github` MCP): `gh pr view <num> --json title,body,author,labels,files,baseRefName,headRefName` + `gh pr diff <num>`
  - **GitLab** (`glab` CLI): `glab mr view <num>` + `glab mr diff <num>`
  - **Bitbucket** (`bb` CLI) or **Gitea** (`tea` CLI): equivalent view/diff commands
  - **No CLI available**: use `git remote -v` to detect the host, then fetch the patch over HTTPS (e.g., `curl` the PR's `.patch` URL on GitHub) and the metadata via the host's REST API if an auth token is in env
  If the PR's head branch is checked out locally, also include any uncommitted changes (`git diff HEAD`).
- **Commit SHA** (7+ hex chars) — review that single commit: `git show <sha>`.
- **Range** (`A..B` or `A...B`) — review the commit range: `git diff <range>`.
- **"staged"** — review staged changes only: `git diff --cached`.
- **"HEAD"** — review the most recent commit only: `git show HEAD`.
- **A file path** — review uncommitted + last commit touching that file: `git diff HEAD <path>` + `git log -1 -p <path>`.

If the scope is ambiguous after the classifier (rare), make the most-likely pick and state it in your report's opening line.

## 2. Gather context

- **Branch name** → if it looks like it contains a ticket reference (e.g. `<team>/<TICKET>-<slug>`, `<team>-<NUM>`, `feature/<NUM>`, `<prefix>/<TICKET>-...`), try to fetch the underlying issue via any configured issue-tracker MCP. Probe in order: `linear`, `github`/`gh` CLI, `jira`/`atlassian`, other issue MCPs. Use the fetched title + description + acceptance criteria as the "intent" baseline the diff should satisfy. Do NOT ask the user which tracker — probe.
- **PR description** (if target is a PR) → that's the intent baseline. Note: if the PR body contains a ticket reference (often linked in an "## Issue" / "Fixes:" / "Closes:" section), also try the tracker probe above for the richer source.
- **No tracker issue, no PR description** → state "no stated intent captured" in the report; judge the diff on its own merits.
- **Recently modified files in the diff** → for files > 200 lines, run `comment_check` to surface existing `@TODO`/`@FIXME`/`@HACK` context.
- **Changed TS symbols** → use `serena_find_symbol` + `serena_find_referencing_symbols` on the top-3 most load-bearing symbol changes to measure blast radius. This is the single most important tool-preference for review work.

## 3. Run the review

Delegate to `@qa-reviewer` with:
- The resolved target (e.g., "PR #1234" or "current branch ahead of main")
- The intent baseline (tracker issue body + acceptance criteria, or PR description, or "no stated intent")
- A directive: "Review this as PR-style adversarial analysis — not vs a specific plan. Output structured FAIL findings (file:line + specific issue) or PASS with summary."

If `@qa-reviewer` returns `[PASS]`, accept it. If `[FAIL]`, that's your finding list.

For any finding flagged as security-sensitive or architecture-level (new service boundary, new entity, new auth path, public API shape change), also delegate to `@architecture-advisor` for a second opinion. Include its recommendation in the report.

## 4. Run automated checks inline

- **Type check** (if the project uses a typed language): `tsc_check` on a TS project root, or the equivalent shell invocation (`mypy`, `cargo check`, `go vet`, etc.). Discover from `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml`.
- **Lint** (on the specific files changed): `eslint_check` for JS/TS, or the project's configured linter (`ruff`, `golangci-lint`, `rubocop`, etc.). Read from the project's lint config / `CI.yml` / `package.json` scripts to discover the right invocation.
- `todo_scan` with `onlyChanged: true` against the diff — surface any TODO/FIXME/HACK that was added

Include the output of each in the report. Failures here are not auto-failures of the review (users may be WIP) but they should be surfaced. If the project isn't typed or has no configured linter, skip those lines and note "(not applicable)".

## 5. Report

Output format:

```
# Review: <target>

## Intent
<1-2 sentences from tracker issue / PR body, or "no stated intent captured">

## Verdict
[PASS] or [FAIL] or [PASS WITH CONCERNS]

## Findings

### Must fix (blocking)
- `<file>:<line>` — <specific issue + suggested approach (not a patch)>

### Should consider (non-blocking)
- `<file>:<line>` — <concern>

### Automated checks
- Typecheck: <N errors | clean | not applicable>
- Lint: <N issues | clean | not applicable>
- New TODO/FIXME/HACK in diff: <list or none>

### Blast radius
- <symbol> → used in <N> places, changes are/aren't backwards-compatible

## Architecture note
<Only if @architecture-advisor was consulted. One paragraph summary.>
```

Keep findings specific and actionable. Avoid "consider adding tests" — instead, "no test covers the branch at <file>:<line> where <specific scenario>."

## Hard rules

- Read-only. NEVER commit, push, edit files, check out branches, or mutate anything.
- If the target is a PR on a different branch and you need to see the code, use the host CLI's *diff* subcommand (e.g., `gh pr diff`, `glab mr diff`) — do NOT check out the PR branch locally (`gh pr checkout`, `git fetch + checkout`, etc.). The user's working tree is sacred.
- One report at the end, not a running commentary.
- Prefer `serena_find_referencing_symbols` over grep when measuring blast radius on TS code.
- Do NOT ask the user clarifying questions unless the target genuinely can't be resolved. Pick the most-likely scope and state it.
