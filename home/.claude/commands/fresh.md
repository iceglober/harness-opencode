---
description: Re-key the current worktree to a new task. Discards working-tree state, fetches latest default branch, creates a new branch, dispatches to the repo reset hook for process/container cleanup, and writes a handoff brief. Assumes long-running worktree model — one terminal tab, one persistent worktree, many tasks over its lifetime.
---

User input: $ARGUMENTS

You are re-keying an existing, long-running git worktree to a new unit of work. The worktree itself is not created or destroyed — it's a persistent shell tab owned by the user. Your job is to get the working tree clean, the branch pointing at the right place, and repo-specific resources (Postgres, docker, dev servers) reset to a fresh state — **scoped to this worktree only**. Other worktrees and their running processes must be untouched.

## Mental model (read this first)

The user keeps 7–10 terminal tabs open, each permanently cd'd into a separate git worktree (typically under `~/.glorious/worktrees/<repo>/<name>`). Tabs are long-lived — the same tab hosts many tasks over weeks. `/fresh` is how a tab transitions from one task to the next without closing the session, spawning a new worktree, or touching any other tab's state.

What `/fresh` does NOT do:

- It does NOT create a new worktree directory.
- It does NOT run `gsag wt new` or `git worktree add`.
- It does NOT ask the user to `cd` anywhere — they're already where they need to be.
- It does NOT touch any other worktree's files, processes, or containers.

What `/fresh` DOES do, in order:

1. Verify the current cwd is inside a git worktree (not the main checkout).
2. Parse `$ARGUMENTS` to derive the new branch name (same rules as before — Linear/GitHub reference or free-text slug).
3. Confirm destructive reset with the user if working tree is dirty.
4. Discard all uncommitted changes (reset + clean).
5. Fetch `origin/<default-branch>` and create the new branch from it.
6. Invoke `.glorious/hooks/fresh-reset` for repo-specific process/container cleanup.
7. Write `.agent/fresh-handoff.md` with the context so future agent turns (and future sessions opened in this same dir) can pick up cleanly.
8. Print a compact summary. **Do NOT tell the user to `cd` — they're already there.**

## 0. Prereqs

- Run `git rev-parse --is-inside-work-tree` — must print `true`. Abort cleanly if not.
- Run `git rev-parse --show-toplevel` — capture this as `WORKTREE_DIR`.
- Run `git rev-parse --git-common-dir` and compare with `git rev-parse --git-dir`. If they match, this is the main checkout, NOT a worktree. Abort with: `/fresh is for long-running worktrees, not the main checkout. Run \`gsag wt new\` first to create one, or cd into an existing worktree tab.`
- `gsag` is NOT required by this command. (It's the tool the user uses to initially *create* worktree tabs; we don't need it for re-keying.)

## 1. Parse `$ARGUMENTS`

Same parsing rules as a typical fresh-worktree command:

- **Core flags** (consumed here):
  - `--from <branch>` — base branch override (default: repo's default branch, usually `main`)
  - `--skip-hook` — skip the `.glorious/hooks/fresh-reset` invocation (useful if the user knows the env is already clean)
  - `--no-discard` — refuse to proceed if the working tree is dirty, instead of offering to discard (sanity safety for paranoid users)
  - `--yes` — **non-interactive mode**. Assume yes on any confirmation that would normally use the `question` tool. Autopilot and orchestrator pass this when invoking `/fresh` inside a loop. Changes behavior when the tree is dirty: see § Non-interactive mode below.
- **Free text** — first contiguous non-flag substring, used to derive the branch name.
- **Pass-through args** — forwarded to the reset hook verbatim.

If `$ARGUMENTS` is empty or has no free text:

- **Interactive mode (default)**: use the `question` tool — "What's this tab re-keying to? (free text, or an issue-tracker reference like `ENG-1234`)"
- **Non-interactive mode (`--yes`)**: abort immediately with `ERROR: /fresh --yes requires a branch name or issue ref in $ARGUMENTS.` — the caller (autopilot) must always supply one.

## 1a. Non-interactive mode (`--yes`)

Under `--yes`, every `question`-tool use in this command is replaced by a deterministic rule:

| Decision | Interactive default | `--yes` behavior |
|---|---|---|
| Dirty tree, only untracked/gitignored debris | Ask to discard | **Proceed** — `git clean -fdx` is safe for gitignored/untracked build artifacts |
| Dirty tree with TRACKED changes (modified/staged/deleted) | Ask to discard | **Abort** with `ERROR: /fresh --yes refuses to discard tracked changes. Commit/stash and re-run, or run /fresh without --yes.` |
| Dirty tree with untracked NON-gitignored files | Ask to discard | **Abort** with the file list. Non-gitignored untracked files are almost always intentional. |
| Unpushed commits on current branch | Proceed silently | Proceed silently (same as interactive) |
| `$ARGUMENTS` empty | Ask for input | Abort |

The invariant: `--yes` must never destroy work that a reasonable human would want to keep. Gitignored build artifacts are the only discard that's clearly safe without consent. Everything else halts the autopilot sequence so a human can inspect. The autopilot loop treats a `/fresh --yes` abort as a hard stop, not a "try next issue."

To detect the tracked-vs-untracked split from `git status --porcelain`:
- Lines starting with ` M`, `M `, `MM`, `A `, `D `, ` D`, `R `, `C `, `U ` (or any non-`??` prefix) = tracked changes present
- Lines starting with `??` = untracked; run `git check-ignore --stdin` across them to split gitignored-debris from intentional-new-files

## 2. Derive the new branch name

**Issue-tracker reference path** — matches these shapes:

- `<PROJECT>-<NUMBER>` where PROJECT is 2–10 uppercase letters (e.g. `ENG-1234`, `GEN-1127`, `ICE-42`).
- `#<NUMBER>` alone (GitHub/GitLab shorthand).
- URL to a known tracker (`linear.app/.../issue/...`, `github.com/.../issues/N`, `<company>.atlassian.net/browse/...`).

For Linear-style `<PROJECT>-<NUMBER>`, if a Linear MCP is enabled, call `linear_get_issue(id)` and use `branchName` verbatim.

For GitHub `#<NUMBER>` or issue URL, if `gh` is available: `gh issue view <N> --json title --jq .title`, then slug like free text with prefix `issue-<N>-`.

If tracker lookup fails for any reason, fall through to the free-text path. Never abort for a lookup failure.

**Free-text path** — slug + verb-prefix inference:

1. Lowercase; replace non-alphanumeric runs with `-`; collapse repeats; strip leading/trailing `-`.
2. Verb prefix from the first whitespace-separated word:
   - `fix|bug|hotfix|patch` → `fix/`, strip verb. (`fix auth bug` → `fix/auth-bug`)
   - `add|feat|feature|implement|create` → `feat/`, strip verb.
   - `refactor|cleanup|rename|reorganize` → `refactor/`, strip verb.
   - `doc|docs|document` → `docs/`, strip verb.
   - Otherwise → `chore/` (or the dominant prefix from recent local branches if cheaply discoverable via `git branch --sort=-committerdate | head -5`).
3. Truncate to 50 chars total; on mid-word truncation, chop to last full word.

**Name collision check**: run `git rev-parse --verify <new-branch-name>` against both local and `refs/remotes/origin/<new-branch-name>`. On collision:

- Retry with `-$(date +%y%m%d)` suffix.
- If that also collides, append `-${EPOCHSECONDS}`. Never fails by now.

Capture old branch name via `git branch --show-current` BEFORE any state changes — it's part of the summary and handoff brief.

## 3. Working-tree safety check (critical)

Run these and assemble a "what would be lost" picture:

```bash
DIRTY_FILES=$(git status --porcelain)
UNPUSHED_COMMITS=$(git log "@{upstream}..HEAD" --oneline 2>/dev/null || git log HEAD --oneline | head -20)
STALE_STASHES=$(git stash list | head -5)
```

**Decision matrix:**

| Condition | Interactive default | `--yes` mode |
|---|---|---|
| Clean tree, tracked upstream | Proceed silently | Proceed silently |
| Dirty tree: only gitignored/untracked debris | Confirm discard (see below) | **Proceed** — `git clean -fdx` is safe here |
| Dirty tree: tracked changes (modified/staged/deleted) | Confirm discard (see below) | **Abort** with tracked-file list |
| Dirty tree: untracked non-gitignored files | Confirm discard (see below) | **Abort** with file list |
| Dirty tree and `--no-discard` passed (any mode) | Abort with the dirty list | Abort with the dirty list |
| Unpushed commits exist | **Proceed without asking** — old branch ref preserves them; summary mentions `Previous branch <old> kept N unpushed commits — recover with git checkout <old>` | Same |

**Destructive-discard confirmation (when dirty tree):**

Use the `question` tool with these exact contents:

- Question: `Worktree is dirty. /fresh will hard-discard ALL uncommitted changes in this worktree. Proceed?`
- Header: `Discard uncommitted changes?`
- Options:
  - `Yes, discard everything` — proceeds to step 4
  - `No, abort /fresh` — exits the command cleanly, zero changes made
  - `Show what would be lost first` — print `git status --short` output plus `git diff --stat HEAD`, then re-ask (recursive, but OK — the question tool handles this)

**If the user confirms discard:**

```bash
git reset --hard HEAD
git clean -fdx
```

Note the `-x` on `clean`: removes files matched by `.gitignore` too. This is deliberate for the long-running-worktree model — `.env` files, `dist/`, `node_modules/.cache/`, leftover build artifacts, etc. all get purged. The reset hook (step 6) is responsible for re-creating anything the new task needs (e.g., re-patch `.env`).

**BUT preserve `.agent/`** if it exists and contains a handoff brief you're about to overwrite. Before `git clean -fdx`:

```bash
if [ -f .agent/fresh-handoff.md ]; then
  mkdir -p /tmp/fresh-handoff-archive
  cp .agent/fresh-handoff.md "/tmp/fresh-handoff-archive/$(basename $WORKTREE_DIR)-$(date +%s).md"
fi
```

Best-effort preservation of the previous brief in `/tmp` for recovery if the user ran `/fresh` by mistake. Don't fail if this step fails — it's a courtesy.

## 4. Fetch and create the new branch

```bash
# Default branch name — from repo convention
DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

# --from flag overrides
BASE_BRANCH="${FROM_FLAG:-$DEFAULT_BRANCH}"

# Fetch only the branch we need (fast, avoids pulling every remote ref)
git fetch origin "$BASE_BRANCH" --prune

# Create the new branch from the freshly-fetched remote tip
git checkout -b "$NEW_BRANCH_NAME" "origin/$BASE_BRANCH"
```

On `git fetch` failure (network, auth, etc.): print the error, then **fall back to the local tip of `$BASE_BRANCH`** with a warning. Do NOT abort — network blips are common and the user may be offline.

On `git checkout -b` failure (collision after step 2's retry logic failed): this shouldn't happen given step 2's safeguards. If it does: abort with the error. Working tree is already clean from step 3, so the user is in a recoverable state.

## 5. Invoke `.glorious/hooks/fresh-reset`

This is the repo-specific teardown+setup step. Skipped if `--skip-hook` was passed.

Check for `.glorious/hooks/fresh-reset` in the current worktree. If it doesn't exist or isn't executable, skip silently (the repo hasn't opted in, which is fine for hobby repos).

**Environment variables to pass:**

- `WORKTREE_DIR` — absolute path of the current worktree (captured in step 0)
- `WORKTREE_NAME` — basename of `WORKTREE_DIR` (useful for scoping things like `docker-compose -p <name>`)
- `OLD_BRANCH` — the branch name before /fresh ran (captured in step 2)
- `NEW_BRANCH` — the new branch name (derived in step 2)
- `BASE_BRANCH` — the base branch the new branch was created from (from step 4)
- `FRESH_PASSTHROUGH_ARGS` — pass-through args joined with spaces (informational only, not parse-safe)

**Positional args:**

The hook is invoked with pass-through args verbatim so it can use `getopt`/`case`:

```bash
bash "$WORKTREE_DIR/.glorious/hooks/fresh-reset" "${PASSTHROUGH_ARGS[@]}"
```

**Hook contract** (what the repo's hook is responsible for):

- Killing dev servers, watchers, or other processes spawned previously IN THIS WORKTREE (matching on `/proc/<pid>/cwd` == `$WORKTREE_DIR`, or by PID files in `$WORKTREE_DIR/.pids/`, or by a project-label convention).
- Stopping docker/compose projects scoped to this worktree (e.g., `docker compose -p "$WORKTREE_NAME" down`).
- Freeing any port slot allocated to this worktree (e.g., releasing a Postgres port reservation).
- Re-running any env-patching for the new task (e.g., regenerating `.env` with the new branch name or secrets).
- Re-installing deps if the lockfile changed between `OLD_BRANCH` and `NEW_BRANCH` (usually just `pnpm install` / `bun install` / etc. — idempotent in the common case).

**What the hook must NOT do:**

- Touch any other worktree's directory, processes, or containers. This is the iron rule. If the hook uses `docker ps` or `ps` broadly, it MUST filter by `WORKTREE_NAME` or `WORKTREE_DIR` before killing anything.
- Modify global state (user's shell rc, `$HOME/.docker/config.json`, system services, etc.).
- Prompt the user. The hook runs non-interactively.

**Exit semantics:**

- Exit 0 → success, continue.
- Exit non-zero → print the hook's output as a warning, continue to step 7. The worktree itself is in a valid post-fresh state; the hook failure only means repo-specific setup didn't complete. User can re-run the hook manually.

**Convention for hook output:**

Hooks may write a JSON summary to stdout's last line (e.g., `{"postgresPort": 5442, "projectName": "wt-abc123"}`). Parse if valid JSON and include in the final summary.

## 6. Write the handoff brief

Write `.agent/fresh-handoff.md` in the current worktree. This is what the NEXT agent turn (or a new session opened in this same dir) reads to pick up context.

```markdown
# Fresh handoff — <NEW_BRANCH_NAME>

**Worktree:** `<WORKTREE_DIR>`
**Previous branch:** `<OLD_BRANCH>` — <"had N unpushed commits, recover with git checkout <OLD_BRANCH>" | "clean, nothing unrecovered">
**Base branch:** `<BASE_BRANCH>` (fetched <timestamp>)
**Created at:** <ISO 8601 timestamp>

## Original request

<verbatim $ARGUMENTS>

## Tracker context

<if Linear lookup succeeded:>
- **Issue:** <ID> — <title>
- **URL:** <url>
- **Status:** <status>
- **Description:**
  <first 40 lines of the issue description, or full if shorter>
<if GitHub lookup succeeded:>
- **Issue / PR:** #<N> — <title>
- **URL:** <url>
<if no tracker lookup:>
- (none — derived from free text)

## Reset-hook output

<if hook was invoked:>
<exit code, last ~40 lines of hook stdout>
<if JSON summary was parsed, include it as a key-value list>
<if skipped:>
Hook invocation was skipped (--skip-hook).
<if absent:>
No `.glorious/hooks/fresh-reset` found; no repo-specific reset run.

## Expectations for the next agent turn

- CWD is `<WORKTREE_DIR>`. Stay scoped to paths inside this directory.
- Other worktrees (siblings under `<parent-of-WORKTREE_DIR>`) are out of scope — never read, edit, or `cd` into them.
- If you are a new session just opened here, read this brief, then confirm with the user before making changes.
```

Write atomically: write to `.agent/fresh-handoff.md.tmp`, then `mv`.

`mkdir -p .agent` if needed.

## 6a. Reset autopilot state (always — interactive and non-interactive)

If `.agent/autopilot-state.json` exists, atomically reset the current session's iteration counter to 0 so the autopilot plugin's next scan sees a clean slate and can pick up the new task via the fresh handoff brief.

You don't know the current session ID directly from inside the slash command, so rewrite the whole file by resetting every session entry to `{ iterations: 0 }`. This is safe: the autopilot plugin uses iterations to decide "has this session gone idle mid-plan without progress?" — zeroing it just means "start fresh counting from here." Losing the old counter is correct behavior across a `/fresh` boundary because the work-in-progress on the old plan is intentionally abandoned.

```bash
STATE_FILE=".agent/autopilot-state.json"
if [ -f "$STATE_FILE" ]; then
  # Best-effort reset; don't fail /fresh if jq is missing or the file is malformed.
  if command -v jq >/dev/null 2>&1; then
    jq '.sessions |= with_entries(.value = {iterations: 0})' "$STATE_FILE" > "$STATE_FILE.tmp" \
      && mv "$STATE_FILE.tmp" "$STATE_FILE" \
      || rm -f "$STATE_FILE.tmp"
  else
    # Fallback: just truncate to empty-sessions object. Plugin tolerates it.
    echo '{"sessions":{}}' > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
  fi
fi
```

This step is silent on success and a single warning on failure. Never abort `/fresh` over this — autopilot coordination is nice-to-have; the core re-keying work is already done.

## 7. Summary (print to stderr for the human)

Assemble a compact summary. This is what the human sees.

```
✓ Worktree re-keyed
  Directory:     <WORKTREE_DIR>
  Previous:      <OLD_BRANCH> → New: <NEW_BRANCH_NAME>
  Base:          <BASE_BRANCH> (fetched just now)
  Discarded:     <"N files" if the tree was dirty, else "(clean)">
  Unpushed:      <"N commits preserved on <OLD_BRANCH>" if applicable, else "(none)">
  Reset hook:    <"invoked successfully" | "invoked with warnings" | "skipped via --skip-hook" | "no hook present">
  Handoff brief: .agent/fresh-handoff.md

<if hook emitted a JSON summary, print each key-value one per line>
<if there are unpushed commits on the old branch:>
Recover previous work: git checkout <OLD_BRANCH>
```

**Do NOT print `cd <path>` or "start a new session" or any handoff command.** The user is already in the tab where the work happens. The session continues in place.

## Failure-mode reference

| Step | Failure | Interactive | `--yes` |
|---|---|---|---|
| 0 (env check) | Not inside a worktree | Abort with guidance to create one first | Same |
| 0 (env check) | Inside main checkout, not a worktree | Abort — `/fresh` is for worktrees only | Same |
| 1 (parsing) | Empty `$ARGUMENTS` | Ask via `question` tool | **Abort** with `ERROR: /fresh --yes requires a ref/description.` |
| 2 (tracker lookup) | MCP/gh unavailable, issue not found | Fall back to free-text slug | Same |
| 2 (name collision) | New branch name conflicts | Retry with `-YYMMDD`, then `-$EPOCHSECONDS` | Same |
| 3 (dirty tree with tracked changes) | User intervention needed | Ask to discard | **Abort** with file list |
| 3 (dirty tree with untracked non-gitignored files) | User intervention needed | Ask to discard | **Abort** with file list |
| 3 (dirty tree, only gitignored debris) | Safe to clean | Ask to discard | **Proceed** silently |
| 3 (discard runs) | `git clean -fdx` fails | Print error, abort | Same — don't proceed with partial state |
| 4 (fetch) | Network/auth failure | Fall back to local tip of base, warn, continue | Same |
| 4 (checkout) | Name collision despite step 2 safeguards | Abort — shouldn't reach here | Same |
| 5 (hook invocation) | Hook exits non-zero | Print hook output as warning, continue to step 6 | Same |
| 5 (hook missing) | No hook file | Skip silently — generic repos don't need one | Same |
| 6 (handoff brief write) | File-system error | Warn, continue — brief is nice-to-have | Same |
| 6a (autopilot-state reset) | File or `jq` issue | Warn, continue — coordination is nice-to-have | Same |

## Integration with `/autopilot` (sequence-of-issues mode)

When the user runs `/autopilot` with a project / milestone / queue reference, the autopilot command sequences through multiple issues and invokes `/fresh <ref> --yes` between each one. The contract across that boundary:

**From autopilot's side** (before calling `/fresh`):

- Autopilot pops the next ref from its queue.
- Autopilot pre-checks whether that ref already has an open or merged PR (via `gh pr list --search <ref>` or Linear MCP). If yes, skip silently, log, and pop the next ref. `/fresh` is not invoked for already-shipped work.
- Autopilot calls `/fresh <ref> --yes` only when the ref is genuinely open.

**From `/fresh`'s side** (this command):

- `--yes` suppresses every `question`-tool prompt. Autopilot cannot respond to them.
- If the working tree has tracked changes or untracked non-gitignored files, `/fresh --yes` aborts. Autopilot treats this as a **hard stop** for the sequence, not "try next issue" — dirty tracked work means something went wrong in the previous iteration that requires human attention.
- If the reset hook exits non-zero, `/fresh --yes` still completes (worktree is re-keyed, handoff brief written). Autopilot continues; the hook warning appears in the handoff brief.
- `/fresh` writes `.agent/fresh-handoff.md` and resets `.agent/autopilot-state.json` iteration counters to 0. The autopilot plugin picks up from here: on its next session-idle scan, it sees the recent handoff brief + zeroed counter and injects a "new task started, read the handoff brief" nudge.

**Summary of the handoff contract:**

```
autopilot queue    →    autopilot pops ref    →    /fresh <ref> --yes    →    autopilot plugin sees:
                                                                                - .agent/fresh-handoff.md
                                                                                  (fresher than last plan path)
                                                                                - .agent/autopilot-state.json
                                                                                  (iterations reset to 0)
                                                                              plugin nudges agent:
                                                                              "New task: read .agent/fresh-handoff.md"
                                                                              agent runs orchestrator arc
                                                                              plan → build → verify → STOP
                                                                              plugin sees acceptance criteria all [x],
                                                                              resets counter, autopilot pops next ref
```

## Hook contract, for repo authors

A repo opts into `/fresh` reset behavior by providing an executable at `.glorious/hooks/fresh-reset`. It receives:

- Env: `WORKTREE_DIR`, `WORKTREE_NAME`, `OLD_BRANCH`, `NEW_BRANCH`, `BASE_BRANCH`, `FRESH_PASSTHROUGH_ARGS`
- Positional args: the pass-through args from `$ARGUMENTS`

It is responsible for: scoping to this worktree only, stopping/cleaning processes and containers previously spun up here, resetting env files / port reservations, and re-running dep installation if lockfiles changed. It MUST NOT touch any other worktree. It exits 0 on success; any non-zero exit is a warning, not a fatal error. See `docs/fresh.md` in the glorious-opencode repo for a worked example (pnpm + docker compose + per-worktree Postgres slot reservation).

## One-sentence philosophy

`/fresh` is the workspace equivalent of a fresh `git stash && git checkout -b`, but with process/container awareness, scoped narrowly to the worktree the user is already in, with zero terminal-tab or session churn.
