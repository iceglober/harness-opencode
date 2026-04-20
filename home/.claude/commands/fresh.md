---
description: Create a fresh worktree from the repo default branch (or a specified base), with an inferred branch name from free text or an issue-tracker reference. Dispatches to an optional repo-specific hook for post-creation provisioning.
---

User input: $ARGUMENTS

You are kicking off a new unit of work in an isolated git worktree. This command is intentionally generic — it only handles the universally applicable parts (create worktree, rename branch, dispatch to repo hook). Repo-specific provisioning (Postgres, Docker, seeds, env patching, etc.) lives in `.glorious/hooks/fresh` of the consuming repo.

## Prereqs

- `gs-agentic` (aliased `gsag`) must be installed. If `command -v gsag` fails, tell the user:
  ```
  Install gs-agentic first:
    curl -fsSL https://raw.githubusercontent.com/iceglober/glorious/main/packages/agentic/install.sh | bash
  ```
  and abort. Do NOT auto-install — leaves the install decision to the user.

## 1. Parse `$ARGUMENTS`

Split into:

- **Core flags** (consumed by this command):
  - `--from <branch>` — base branch for the new worktree (default: repo's default, usually `main`)
  - `--clean` — after creation, run `gsag wt cleanup --dry-run` and ask the user to confirm pruning stale worktrees
- **Free text** — the first contiguous non-flag substring (up to the next flag). Used to derive the branch name.
- **Pass-through args** — any other flags or tokens, preserved in order. These are forwarded to the hook unchanged. The hook decides what to do with them.

If `$ARGUMENTS` is empty or has no free text, ask the user via the `question` tool:
> "What's this worktree for? (free text, or an issue-tracker reference like `ENG-1234`)"

## 2. Derive the branch name

**Issue-tracker reference path** — matches any of these shapes:
- `<PROJECT>-<NUMBER>` where PROJECT is 2–10 uppercase letters (e.g. `ENG-1234`, `ICE-42`, `GEN-1127`, `PROJ-456`)
- `#<NUMBER>` alone (e.g. `#1234`) — GitHub/GitLab shorthand
- A URL to a known tracker (`github.com/.../issues/N`, `github.com/.../pull/N`, `linear.app/.../issue/...`, `<company>.atlassian.net/browse/...`, etc.)

For the Linear-style `<PROJECT>-<NUMBER>` shape, if a Linear MCP is configured and enabled, call `linear_get_issue(id)` and use the returned `branchName` field verbatim (Linear auto-generates these — they're well-formed and idiomatic for the user's workspace).

For a GitHub `#<NUMBER>` or issue URL, if the `gh` CLI is available, fetch the issue title with `gh issue view <N> --json title --jq .title` and slug it like free text (see below), with prefix `issue-<N>-`.

If tracker lookup fails (MCP disabled, network error, issue not found), **fall through to the free-text path** treating the whole input as plain text. Do NOT abort — the worktree is more useful than a perfect name.

**Free-text path** — slug + verb-prefix inference:
1. Lowercase the text; replace non-alphanumeric runs with `-`; collapse repeated `-`; strip leading/trailing `-`.
2. Identify the leading verb (first whitespace-separated word of the original text, lowercased):
   - `fix|bug|hotfix|patch` → prefix `fix/`, **strip the verb** from the slug. Example: `fix auth bug` → `fix/auth-bug`.
   - `add|feat|feature|implement|create` → prefix `feat/`, strip the verb. Example: `add SAML support` → `feat/saml-support`.
   - `refactor|cleanup|rename|reorganize` → prefix `refactor/`, strip the verb.
   - `doc|docs|document` → prefix `docs/`, strip the verb.
   - Otherwise → prefix `chore/` (or use the user's convention if discoverable from recent branch names — see below), keep all words.
3. Truncate the final `prefix/slug` to 50 chars total. If truncation lands mid-word, chop to the last full word.

**Prefix discovery from existing branches** (optional polish, only if cheap):

If `git branch -r 2>/dev/null | head -20` returns branches with a recognisable prefix pattern (e.g., many branches start with `<user>/` or a ticket-tag like `ENG-`), consider using the dominant user/team prefix for `chore/` cases. Don't spend much time here — fall back to `chore/` if unclear.

## 3. Create the worktree

Run `gsag wt new` with `--from` if specified. Capture the generated worktree name from stdout (the last line of `gsag wt new`'s output is the name, per gs-agentic convention).

```bash
if [[ -n "$FROM_BRANCH" ]]; then
  WT_NAME=$(gsag wt new --from "$FROM_BRANCH" 2>&1 | tee /dev/stderr | tail -1)
else
  WT_NAME=$(gsag wt new 2>&1 | tee /dev/stderr | tail -1)
fi
```

On failure: abort with the error. Nothing was created — no cleanup needed.

## 4. Resolve path + rename branch

```bash
WT_PATH=$(gsag wt path "$WT_NAME")
cd "$WT_PATH"
git branch -m "$DERIVED_BRANCH_NAME"
```

**On rename failure** (name collision with another branch anywhere in the repo):
1. Retry with a short date suffix: `${DERIVED_BRANCH_NAME}-$(date +%y%m%d)`.
2. If that also collides, log a warning and keep the `gsag`-generated auto-name. The worktree is still functional.
3. Do NOT abort for a rename failure — the user can always `git branch -m` manually later.

Note: `gsag wt ls` reads branch names from live git (the `→` arrow in its output), so stale registry cache is harmless.

## 5. Dispatch to repo-specific hook

Check for `.glorious/hooks/fresh` in the **new worktree**. If it exists and is executable, invoke it with:

**Environment variables:**
- `WORKTREE_DIR` — absolute path of the new worktree
- `BRANCH_NAME` — the final branch name (after rename, or the auto-generated one if rename failed)
- `BASE_BRANCH` — the base branch this was created from (e.g. `main` or the `--from` value)
- `WORKTREE_NAME` — the `gsag`-generated worktree directory basename
- `FRESH_PASSTHROUGH_ARGS` — the pass-through args from step 1, joined with spaces (single-line, quoting-unsafe — only informational)

**Positional args:**
The hook is called with the pass-through args verbatim so it can parse them with `getopt`, `case`, etc.:

```bash
bash "$WT_PATH/.glorious/hooks/fresh" "${PASSTHROUGH_ARGS[@]}"
```

**Exit semantics:**
- Hook exits 0 → success, continue
- Hook exits non-zero → print the hook's output, treat as warning (the worktree itself was created successfully), continue to summary. Do NOT abort — the user can re-run the hook manually.

**If no hook exists:** skip this step silently. The worktree is valid on its own for repos that don't need extra provisioning.

**Convention for hook output:** hooks may write a JSON summary to stdout's last line that this command parses and includes in the final summary (e.g., `{"postgresPort": 5442}`). Ignore if not valid JSON.

## 6. (Optional) Cleanup stale worktrees

If `--clean` was passed:

```bash
STALE_OUTPUT=$(gsag wt cleanup --dry-run 2>&1)
```

If the output lists candidates (non-empty), use the `question` tool:

> "Found N stale worktrees (branches merged or remote gone). Delete them all?"

Options: "Yes, delete all" | "No, skip cleanup" | "Show list first"

If user confirms:
- For each candidate, check whether THAT worktree has a `.glorious/hooks/fresh` hook with a `pre-delete` subcommand (call it with `pre-delete` as the first arg — hook should no-op if it doesn't recognize). This is the one standardized subcommand.
- Then: `gsag wt delete --force <name>`

If the user declines or no candidates exist, skip.

## 7. Summary

Print to stderr (for the human). Assemble:

- ✓ Fresh workspace created
- Worktree path: `<WT_PATH>`
- Branch: `<BRANCH_NAME>`
- Base: `<BASE_BRANCH>`
- Hook status: `invoked successfully` / `invoked with warnings` / `no hook present` / `not invoked`
- Hook output (if any, from the JSON summary)
- Next step hint:
  - `cd <WT_PATH>` to start working
  - `opencode` / `claude` to open an agent session there
- If stale worktrees exist and `--clean` was NOT passed: `N stale worktrees detected. Run /fresh --clean to prune next time.`

## Failure-mode reference

| Step | Failure | Behavior |
|---|---|---|
| 2 (tracker lookup) | MCP/gh unavailable, issue not found | Fall back to free-text slug |
| 3 (`gsag wt new`) | CLI error | Abort, surface the error |
| 4 (`git branch -m`) | Name collision | Retry with `-YYMMDD` suffix; if still fails, keep auto-name and warn |
| 5 (hook invoke) | Hook exits non-zero | Print hook output as warning, continue (worktree is still valid) |
| 5 (hook missing) | No hook file | Silently skip — generic repos don't need one |
| 6 (cleanup) | User declines | Skip — summary still prints |

## Tool name reminder

The CLI is **`gsag`** (alias of `gs-agentic`). Do NOT use `gsa` — that's a different tool (`gs-assume`, for AWS/GCP credential management).

## Hook contract in one sentence

A repo opts into per-fresh provisioning by dropping an executable at `.glorious/hooks/fresh`. It receives `WORKTREE_DIR`, `BRANCH_NAME`, `BASE_BRANCH`, and the pass-through args; it should be idempotent and fast for the common case, and it exits 0 on success. See `docs/fresh.md` in the glorious-opencode repo for a template and a worked example.
