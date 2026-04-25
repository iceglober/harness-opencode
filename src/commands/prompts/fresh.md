---
description: Re-key the current worktree to a new task. Runs the repo's .glorious/hooks/fresh-reset if present+executable; otherwise discards local changes, fetches latest origin, and creates a new branch from it. Then continues inline into the PRIME on the new task. Assumes long-running worktree model — one terminal tab, one persistent worktree, many tasks over its lifetime.
---

User input: $ARGUMENTS

## STOP — read this first, before anything else

**You do NOT ask the user to confirm discarding the working tree. Ever. Unless the user's input above literally contains the flag `--confirm`, you wipe silently.**

Running `/fresh` IS the intent to discard. The user typed `/fresh` because they want a clean workspace. A confirmation prompt at this stage is not safety — it is friction that defeats the entire point of the command. If you are about to invoke the `question` tool to ask any variant of "proceed with discarding changes?" — **STOP.** Re-read this paragraph. The answer is already "yes," because the user already said it by running `/fresh`.

The ONLY permissible uses of the `question` tool inside `/fresh`:

1. The user's input contains the literal flag `--confirm` AND the working tree is dirty → ask the §3 discard confirmation.
2. The user's input has no free-text ref AND does not contain `--yes` → ask "what's this tab re-keying to?"

Those are the only two cases. **Not** "but there's an untracked file," **not** "but the file isn't gitignored," **not** "but `.opencode/package-lock.json` looks important." The user knows what's in their worktree; they typed `/fresh` anyway. Recovery is already baked in — unpushed commits stay reachable via `git reflog` and the old branch ref.

Before every `question` tool invocation in this command, verify it matches case 1 or case 2 above. If it doesn't, do not call the tool. Just proceed.

---

You are re-keying an existing, long-running git worktree to a new unit of work. The worktree itself is not created or destroyed — it's a persistent shell tab owned by the user. Your job is to parse the request, dispatch to the repo's reset strategy (either a committed hook or the built-in default), print a compact summary, and then continue inline into the PRIME on the new task — all **scoped to this worktree only**. Other worktrees and their running processes must be untouched.

## Mental model (read this first)

The user keeps 7–10 terminal tabs open, each permanently cd'd into a separate git worktree (typically under `~/.glorious/worktrees/<repo>/<name>`). Tabs are long-lived — the same tab hosts many tasks over weeks. `/fresh` is how a tab transitions from one task to the next without closing the session, spawning a new worktree, or touching any other tab's state.

What `/fresh` does NOT do:

- It does NOT create a new worktree directory.
- It does NOT run `gsag wt new` or `git worktree add`.
- It does NOT ask the user to `cd` anywhere — they're already where they need to be.
- It does NOT touch any other worktree's files, processes, or containers.

What `/fresh` DOES do, in order:

1. **Prereq checks** — verify cwd is inside a worktree (not the main checkout).
2. **Parse the user's input** — extract flags and free text.
3. **Derive the new branch name** — from Linear/GitHub reference or free-text slug, with collision retry.
4. **Working-tree safety check** — wipe without prompting in the interactive default; opt into confirmation via `--confirm`; hard-stop in `--yes` mode if the tree has tracked or non-gitignored untracked changes.
5. **Capture state** — `OLD_BRANCH`, unpushed commits.
6. **Dispatch to the reset strategy** — hook present+executable → hook; otherwise (or `--skip-hook`) → built-in flow.
7. **Print a compact summary** — **Do NOT tell the user to `cd` — they're already there.**
8. **Start the PRIME on the new task immediately** — in the SAME turn, begin the PRIME arc (Phase 0 → Phase 1 → …) on the user's original request. Do NOT stop after the summary and wait for the user to type "work on it." `/fresh` is "re-key and go," not "re-key and wait."

## Architectural principle: who owns what

- **`/fresh` owns the protocol:** argument parsing, safety gates (dirty-tree checks, `--yes` abort semantics, `--no-discard`), `OLD_BRANCH` capture, summary printing, PRIME kickoff. These are invariants that must be consistent across every repo that uses the harness.

- **The reset strategy owns the reset:** discarding working tree, switching branches, cleaning up repo-specific processes/containers, resetting env files. This is project-specific. The built-in flow is the default strategy (sensible for the long-running-worktree model); projects can ship their own at `.glorious/hooks/fresh-reset` if they want different semantics (e.g., "brand new worktree per task," "nuke containers only," "no-op on a bare repo").

**The two paths are mutually exclusive.** Either the hook runs, or the built-in flow runs. Never both. Hooks that want "the built-in thing plus some extras" must either (a) explicitly replicate the built-in logic inline (see §5a for the exact commands to copy), or (b) leave the hook absent and rely on the user running their extras manually after `/fresh`.

## 0. Prereqs

- Run `git rev-parse --is-inside-work-tree` — must print `true`. Abort cleanly if not.
- Run `git rev-parse --show-toplevel` — capture this as `WORKTREE_DIR`.
- Run `git rev-parse --git-common-dir` and compare with `git rev-parse --git-dir`. If they match, this is the main checkout, NOT a worktree. Abort with: `/fresh is for long-running worktrees, not the main checkout. Run \`gsag wt new\` first to create one, or cd into an existing worktree tab.`
- `gsag` is NOT required by this command. (It's the tool the user uses to initially *create* worktree tabs; we don't need it for re-keying.)

## 1. Parse the user's input

Same parsing rules as a typical fresh-worktree command:

- **Core flags** (consumed here):
  - `--from <branch>` — base branch override (default: repo's default branch, usually `main`)
  - `--skip-hook` — force the built-in flow even when `.glorious/hooks/fresh-reset` is present+executable. Escape hatch for when you want to bypass the hook (e.g., debugging a broken hook). When no hook is present, this flag is a silent no-op.
  - `--no-discard` — refuse to proceed if the working tree is dirty, instead of discarding. Aborts cleanly with the dirty list. Sanity safety for paranoid users who want a hard gate.
  - `--confirm` — **interactive safety gate**. Before discarding a dirty tree, prompt via the `question` tool with the "what would be lost" list. Without this flag, the default interactive behavior is **wipe without asking** — `/fresh` is the user saying "I want a fresh workspace, don't slow me down with prompts." Use `--confirm` when you're not sure whether your working tree has anything salvageable.
  - `--yes` — **non-interactive mode**. Assume yes on any confirmation that would normally use the `question` tool. Autopilot and PRIME pass this when invoking `/fresh` inside a loop. Crucially, `--yes` is STRICTER than interactive default: it aborts on tracked changes or non-gitignored untracked files to protect unattended loops from silent data loss. See § Non-interactive mode below.

**Design note on the dirty-tree default:** interactive `/fresh` trusts that the human running it has already decided they want the workspace wiped — that's the whole point of running `/fresh`. We do NOT prompt by default. `--confirm` opts into the safety prompt for paranoid runs. `--yes` (autopilot) is stricter because a loop can't recover from mistaken destruction the way a human at the terminal can.
- **Free text** — first contiguous non-flag substring, used to derive the branch name.
- **Pass-through args** — forwarded to the reset hook verbatim.

If the input is empty or has no free text:

- **Interactive mode (default)**: use the `question` tool — "What's this tab re-keying to? (free text, or an issue-tracker reference like `ENG-1234`)"
- **Non-interactive mode (`--yes`)**: abort immediately with `ERROR: /fresh --yes requires a branch name or issue ref as input.` — the caller (autopilot) must always supply one.

## 1a. Non-interactive mode (`--yes`)

Under `--yes`, every `question`-tool use in this command is replaced by a deterministic rule. Importantly, `--yes` is **stricter** than the interactive default on dirty trees — it aborts on tracked changes rather than wiping them. The interactive human at a terminal has recourse (they can `cd` elsewhere, inspect the old branch, etc.); an autopilot loop does not, so the gate lives here.

| Decision | Interactive default (no flag) | `--confirm` | `--yes` behavior |
|---|---|---|---|
| Dirty tree, only untracked/gitignored debris | **Wipe silently** | Ask to discard | **Proceed** — `git clean -fdx` is safe for gitignored/untracked build artifacts |
| Dirty tree with TRACKED changes (modified/staged/deleted) | **Wipe silently** — human explicitly ran `/fresh` | Ask to discard | **Abort** with `ERROR: /fresh --yes refuses to discard tracked changes. Commit/stash and re-run, or run /fresh without --yes.` |
| Dirty tree with untracked NON-gitignored files | **Wipe silently** — human explicitly ran `/fresh` | Ask to discard | **Abort** with the file list. Non-gitignored untracked files are almost always intentional. |
| Unpushed commits on current branch | Proceed silently | Proceed silently | Proceed silently |
| Input empty | Ask for input | Ask for input | Abort |

The invariants:

- **Interactive default trusts the human.** The user typing `/fresh` has already decided they want a clean workspace. Prompting is friction, not safety — they can `git reflog` or `git checkout <old-branch>` if they realize they wiped something important, since unpushed commits stay reachable via the old branch ref.
- **`--yes` must never destroy work that a reasonable human would want to keep** when running unattended. Gitignored build artifacts are the only discard that's clearly safe without consent. Everything else halts the autopilot sequence so a human can inspect. The autopilot loop treats a `/fresh --yes` abort as a hard stop, not a "try next issue."
- **`--confirm` is the opt-in safety prompt** for humans who want the old ask-first behavior on a specific run.

To detect the tracked-vs-untracked split from `git status --porcelain`:
- Lines starting with ` M`, `M `, `MM`, `A `, `D `, ` D`, `R `, `C `, `U ` (or any non-`??` prefix) = tracked changes present
- Lines starting with `??` = untracked; run `git check-ignore --stdin` across them to split gitignored-debris from intentional-new-files

**Why safety gates are owned by `/fresh`, not the hook:** the `question` tool is available only to the PRIME agent; a bash hook cannot prompt. To keep `--yes` abort semantics deterministic (which autopilot relies on) and interactive-mode confirmations coherent, all dirty-tree gating runs in `/fresh` BEFORE dispatching to either path. The dispatch target (hook or built-in) always runs against a tree that either is clean, is only gitignored debris cleared for `git clean -fdx`, or has been confirmed-for-discard by the user.

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

Capture old branch name via `git branch --show-current` BEFORE any state changes — it's part of the summary.

The derived name is the **suggested** `NEW_BRANCH` passed to the hook (if one runs). A hook is free to override it — `/fresh` reads `git branch --show-current` post-dispatch to determine the actual post-reset branch and uses that in the summary.

## 3. Working-tree safety check (critical)

Run these and assemble a "what would be lost" picture:

```bash
DIRTY_FILES=$(git status --porcelain)
UNPUSHED_COMMITS=$(git log "@{upstream}..HEAD" --oneline 2>/dev/null || git log HEAD --oneline | head -20)
STALE_STASHES=$(git stash list | head -5)
```

**Decision matrix:**

| Condition | Interactive default | `--confirm` | `--yes` mode |
|---|---|---|---|
| Clean tree, tracked upstream | Proceed silently | Proceed silently | Proceed silently |
| Dirty tree: only gitignored/untracked debris | **Proceed silently** — wipe it | Confirm discard (see below) | **Proceed** — the dispatch target is expected to clean it, or the built-in will |
| Dirty tree: tracked changes (modified/staged/deleted) | **Proceed silently** — wipe it; show summary of what was discarded | Confirm discard (see below) | **Abort** with tracked-file list |
| Dirty tree: untracked non-gitignored files | **Proceed silently** — wipe it; show summary of what was discarded | Confirm discard (see below) | **Abort** with file list |
| Dirty tree and `--no-discard` passed (any mode) | Abort with the dirty list | Abort with the dirty list | Abort with the dirty list |
| Unpushed commits exist | **Proceed without asking** — old branch ref preserves them; summary mentions `Previous branch <old> kept N unpushed commits — recover with git checkout <old>` | Same | Same |

**Summary of what was discarded:** in the interactive default path (wipe without prompting), the final summary (§7) reports `Discarded: <N> files` with a short list (up to 10, truncated) so the user can see what went. This is the visible trace that replaces the pre-wipe prompt — you lose the prompt, you gain a visible post-hoc receipt.

**Destructive-discard confirmation — DO NOT USE unless the user's input contains the literal flag `--confirm`:**

> If you're reading this section without `--confirm` in the user's input, **skip it entirely**. You wipe silently. The prompt below is ONLY for the `--confirm` opt-in. An untracked file, a non-gitignored file, a file that "looks important" — none of those change this. `/fresh` without `--confirm` = wipe without asking.

Use the `question` tool with these exact contents (only reachable when `--confirm` was passed):

- Question: `Worktree is dirty. /fresh will hard-discard ALL uncommitted changes in this worktree. Proceed?`
- Header: `Discard uncommitted changes?`
- Options:
  - `Yes, discard everything` — proceeds to step 4 (dispatch)
  - `No, abort /fresh` — exits the command cleanly, zero changes made
  - `Show what would be lost first` — print `git status --short` output plus `git diff --stat HEAD`, then re-ask (recursive, but OK — the question tool handles this)

## 4. Dispatch: hook-present vs hook-absent

This is the branch point where the reset strategy is chosen. `/fresh` does NOT run any git state-changing commands itself in this section — it only decides which path runs.

**Hook discovery:**

```bash
HOOK_PATH="$WORKTREE_DIR/.glorious/hooks/fresh-reset"
```

Three discovery outcomes:

| Condition | Outcome |
|---|---|
| `-f "$HOOK_PATH"` false | **No hook.** Run the built-in flow (§5a). Silent — generic repos don't need a hook. |
| `-f "$HOOK_PATH"` true AND `-x "$HOOK_PATH"` false | **Hook disabled.** Emit a WARN in the summary (`hook (skipped — not executable, ran built-in instead — WARNING)`), then run the built-in flow. This preserves `chmod -x` as a deliberate kill-switch but makes the skip visible so users don't silently lose their hook. |
| `-f "$HOOK_PATH"` true AND `-x "$HOOK_PATH"` true | **Hook present and enabled.** If `--skip-hook` was passed: log `hook (skipped via --skip-hook)` and run the built-in flow (§5a). Otherwise: dispatch to the hook (§5b). |

### 5a. Built-in reset (hook absent, non-executable, or --skip-hook)

The default reset strategy. This is the long-running-worktree flow: discard any remaining dirt (the § 3 confirmation has already authorized this in interactive mode), fetch the latest base branch, and check out a new branch from it.

```bash
# Discard any confirmed-for-discard dirty state. In the clean-tree case these are no-ops.
git reset --hard HEAD
git clean -fdx
```

Note the `-x` on `clean`: removes files matched by `.gitignore` too (`.env`, `dist/`, `node_modules/.cache/`, leftover build artifacts). This is deliberate for the long-running-worktree model — a fresh task should get a pristine working tree. Projects that need per-task `.env` regeneration or dep installation should ship a hook (§5b) that does both the reset and the post-reset setup.

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

On `git checkout -b` failure (collision after §2's retry logic failed): this shouldn't happen given the earlier safeguards. If it does: abort with the error. Working tree is already clean, so the user is in a recoverable state.

`RESET_STATUS` for the summary is one of: `built-in (clean)` if the pre-dispatch tree was clean, `built-in (discarded N files)` if dirt was cleared.

### 5b. Hook reset (hook present + executable, no --skip-hook)

The project-specific reset strategy. The hook owns the entire reset: working-tree clean, branch switch, process/container cleanup, env regeneration, dep re-install — whatever the project needs.

**Environment variables passed in:**

- `WORKTREE_DIR` — absolute path of the current worktree (captured in §0)
- `WORKTREE_NAME` — basename of `WORKTREE_DIR` (useful for scoping things like `docker-compose -p <name>`)
- `OLD_BRANCH` — the branch name before /fresh ran (captured in §2)
- `NEW_BRANCH` — the **suggested** new branch name (derived in §2). The hook MAY override by checking out a different branch; `/fresh` reads `git branch --show-current` post-hook to discover the actual result.
- `BASE_BRANCH` — the base branch the new branch is intended to derive from (from §1 `--from` flag or repo default). Informational; hook may pick a different base.
- `FRESH_PASSTHROUGH_ARGS` — pass-through args joined with spaces (informational only, not parse-safe)

**Positional args:** the pass-through args from the command input, verbatim, so the hook can use `getopt` / `case` / etc.

**Invocation** — execute the hook directly so its shebang is respected (the hook author chose zsh, python, node, or anything else):

```bash
"$HOOK_PATH" "${PASSTHROUGH_ARGS[@]}"
```

(Do NOT force `bash "$HOOK_PATH"` — that breaks non-bash hooks.)

**Exit semantics:**

- Exit 0 → success, continue to §6. `RESET_STATUS` = `hook (exit 0)`.
- Exit non-zero → **warn, do not abort.** Still proceed to §6 so the summary prints with a prominent failure banner and `RESET_STATUS` = `hook (exit <code> — WARNING)`. Rationale: the hook may have done 80% of its work before failing; the summary makes the failure visible, and the human is the right gate for deciding whether to recover or abandon.

**Convention for hook output:**

Hooks MAY write a JSON summary to stdout's last line (e.g., `{"postgresPort": 5442, "projectName": "wt-abc123"}`). Parse if valid JSON and include in the final summary. This is **enrichment-only** — the JSON tail does NOT change `/fresh` control flow or override the post-hook `git branch --show-current` reading. There are no reserved keys.

**Post-hook state capture** — ALWAYS run after the hook exits, regardless of exit code:

```bash
ACTUAL_BRANCH=$(git branch --show-current)
```

`ACTUAL_BRANCH` is what goes into the summary's `New:` field. If `ACTUAL_BRANCH != NEW_BRANCH` (the hook overrode the suggestion), the summary surfaces both.

## 6. Summary (print to stderr for the human)

Assemble a compact summary. This is what the human sees.

```
✓ Worktree re-keyed
  Directory:     <WORKTREE_DIR>
  Previous:      <OLD_BRANCH> → New: <ACTUAL_BRANCH>
  Base:          <BASE_BRANCH> (requested)
  Discarded:     <"N files" if the tree was dirty, else "(clean)">
  Unpushed:      <"N commits preserved on <OLD_BRANCH>" if applicable, else "(none)">
  Reset:         <RESET_STATUS string>

<if ACTUAL_BRANCH != NEW_BRANCH:>
  Note: reset strategy switched to a different branch than requested (requested: <NEW_BRANCH>).

<if RESET_STATUS contains "WARNING":>
  ⚠️ Reset did not complete cleanly — check `git status` before resuming.

<if hook emitted a JSON summary, print each key-value one per line>
<if there are unpushed commits on the old branch:>
Recover previous work: git checkout <OLD_BRANCH>
```

**Do NOT print `cd <path>` or "start a new session" or any other "do this next" command.** The user is already in the tab where the work happens. The session continues in place — and immediately continues into §7 (PRIME kickoff) in the same turn.

## 7. Kick off the PRIME on the new task (in the SAME turn)

This is the piece that makes `/fresh` feel like "re-key and go" instead of "re-key and wait." After printing the summary, DO NOT stop and wait for a follow-up message. Continue in the same turn:

1. **Treat the user's original input (plus any tracker context you resolved in §2) as the new PRIME input** — same as if the user had just typed that request as a fresh prompt.
2. **Enter the PRIME arc from the top** — Phase 0 bootstrap probe, then Phase 1 intent classification, then Phase 1.5 framing (substantial requests only), etc.
3. **Do not re-prompt for confirmation of the task itself.** The user's request is already in hand. In `--confirm` mode you've already gated on discard; in default mode you haven't, but that's fine — the PRIME's own safety gates (e.g., the Phase 1.5 framing confirmation for low-confidence substantial requests) are the right place for task-level clarifiers, not a `/fresh` meta-prompt.

**Why in the same turn:** the user ran `/fresh <task>` expecting work to start, not a checkpoint. One command, one turn, one uninterrupted transition from old task to new.

**Interaction with `--yes` (autopilot sequence mode):** same behavior. `/fresh --yes <ref>` re-keys and continues inline into the PRIME arc on the new ref. `/autopilot`'s sequence loop drives the iteration — `/fresh` hands off to the PRIME in the same turn, the PRIME runs plan → build → verify → STOP, and the outer `/autopilot` loop pops the next ref.

**Exception — abort paths:** if `/fresh` aborts in §0 (not in a worktree), §1 (empty input), §3 (`--yes` + dirty tracked), or §3 (`--no-discard` + dirty), DO NOT enter §7. The whole point of an abort is that no work should start. Print the abort message and stop.

**Exception — reset-strategy failure with WARNING status:** if the reset hook exited non-zero, the summary prints the warning banner. Still enter §7, but make sure the user sees the banner before work begins — a WARNING status means the worktree state may be inconsistent with the requested task.

## Failure-mode reference

| Step | Failure / condition | Interactive default | `--confirm` | `--yes` |
|---|---|---|---|---|
| 0 (env check) | Not inside a worktree | Abort with guidance to create one first | Same | Same |
| 0 (env check) | Inside main checkout, not a worktree | Abort — `/fresh` is for worktrees only | Same | Same |
| 1 (parsing) | Empty input | Ask via `question` tool | Ask via `question` tool | **Abort** with `ERROR: /fresh --yes requires a ref/description.` |
| 2 (tracker lookup) | MCP/gh unavailable, issue not found | Fall back to free-text slug | Same | Same |
| 2 (name collision) | New branch name conflicts | Retry with `-YYMMDD`, then `-$EPOCHSECONDS` | Same | Same |
| 3 (dirty tree with tracked changes) | Working tree has modified/staged/deleted files | **Wipe silently**, surface discarded-file summary in §6 | Ask to discard | **Abort** with file list |
| 3 (dirty tree with untracked non-gitignored files) | New files not in `.gitignore` | **Wipe silently**, surface discarded-file summary in §6 | Ask to discard | **Abort** with file list |
| 3 (dirty tree, only gitignored debris) | Safe to clean | **Wipe silently** | Ask to discard | **Proceed** silently |
| 4 (dispatch) | Hook file present but non-executable | WARN, fall back to built-in (§5a) | Same | Same |
| 4 (dispatch) | `--skip-hook` with hook present | Log, fall back to built-in (§5a) | Same | Same |
| 5a (built-in fetch) | Network/auth failure | Fall back to local tip of base, warn, continue | Same | Same |
| 5a (built-in checkout) | Name collision despite §2 safeguards | Abort — shouldn't reach here | Same | Same |
| 5b (hook) | Hook exits non-zero | WARN, continue to §6; summary shows failure banner | Same | Same |
| 5b (hook) | Hook emits malformed JSON tail | Silent — enrichment is best-effort | Same | Same |
| 5b (hook) | Hook doesn't change branch (pure-cleanup) | `ACTUAL_BRANCH == OLD_BRANCH`; summary reflects that | Same | Same |
| 5b (hook) | Hook overrides `NEW_BRANCH` | `ACTUAL_BRANCH` from `git branch --show-current` goes into summary | Same | Same |
| 7 (PRIME kickoff) | Reset produced a WARNING status | Continue to §7, but make sure the warning banner is visible to the user before work starts | Same | Same |
| 7 (PRIME kickoff) | `/fresh` aborted earlier (no worktree, empty input, --yes + dirty tracked, --no-discard + dirty) | Do NOT enter §7 — print abort message and stop | Same | Same |

## Integration with `/autopilot` (sequence-of-issues mode)

When the user runs `/autopilot` with a project / milestone / queue reference, the autopilot command sequences through multiple issues and invokes `/fresh <ref> --yes` between each one. The contract across that boundary:

**From autopilot's side** (before calling `/fresh`):

- Autopilot pops the next ref from its queue.
- Autopilot pre-checks whether that ref already has an open or merged PR (via `gh pr list --search <ref>` or Linear MCP). If yes, skip silently, log, and pop the next ref. `/fresh` is not invoked for already-shipped work.
- Autopilot calls `/fresh <ref> --yes` only when the ref is genuinely open.

**From `/fresh`'s side** (this command):

- `--yes` suppresses every `question`-tool prompt. Autopilot cannot respond to them.
- If the working tree has tracked changes or untracked non-gitignored files, `/fresh --yes` aborts. Autopilot treats this as a **hard stop** for the sequence, not "try next issue" — dirty tracked work means something went wrong in the previous iteration that requires human attention. This safety gate is owned by `/fresh`, not the reset strategy, which is what makes `--yes` abort semantics deterministic across repos (a hook cannot override them).
- On success, `/fresh --yes` continues inline into the PRIME arc on the new ref (§7). The PRIME runs plan → build → verify → STOP. Control returns to `/autopilot`'s outer sequence loop, which pops the next ref and calls `/fresh --yes` again.

**Sequence-loop shape:**

```
autopilot queue    →    autopilot pops ref    →    /fresh <ref> --yes    →    /fresh re-keys:
                                                                                 - discards tree (via hook or built-in)
                                                                                 - fetches base, checks out new branch
                                                                                 - prints summary
                                                                                 - CONTINUES INLINE into PRIME (§7):
                                                                                   runs Phase 0 → 1 → 1.5 → …
                                                                                   plan → build → verify → STOP
                                                                               autopilot sees acceptance criteria all [x],
                                                                               pops next ref, loops
```

## Hook contract, for repo authors

A repo opts into a custom `/fresh` reset strategy by committing an executable file at `.glorious/hooks/fresh-reset` (committed to the repo, so it's automatically present in every worktree). It receives:

- **Env:** `WORKTREE_DIR`, `WORKTREE_NAME`, `OLD_BRANCH`, `NEW_BRANCH` (suggested), `BASE_BRANCH` (requested), `FRESH_PASSTHROUGH_ARGS`
- **Positional args:** the pass-through args from the command input

It is responsible for: discarding the working tree appropriately (e.g., `git reset --hard HEAD && git clean -fdx`), switching to the new branch (e.g., `git fetch origin "$BASE_BRANCH" && git checkout -b "$NEW_BRANCH" "origin/$BASE_BRANCH"`), and any project-specific cleanup (stopping docker/compose projects scoped to this worktree, killing dev servers matched by `/proc/<pid>/cwd` or PID files, freeing port slots, regenerating `.env`, re-installing deps if lockfiles changed).

It MUST NOT: touch any other worktree's directory/processes/containers, modify global state, or prompt the user (the `question` tool is agent-only; hooks run non-interactively). Scope filtering by `WORKTREE_NAME` or `WORKTREE_DIR` is mandatory if the hook uses broad tooling like `docker ps` or `ps`.

It SHOULD: exit 0 on success; exit non-zero on failure. Non-zero is treated as a warning by `/fresh` (not fatal) — the summary still prints with a failure banner so the user can see it. A partially-failed hook leaves the worktree in an unknown state; the banner surfaces this visibly.

It MAY: emit a single-line JSON object on stdout's last line for summary enrichment (e.g., `{"postgresPort": 5442}`). This is enrichment-only; it does NOT alter `/fresh` control flow.

Projects that want the built-in long-running-worktree flow ARE the default; they don't need a hook. Projects that want a hook for cleanup only, with the built-in flow still running, should copy the built-in commands (§5a) into their hook and add the cleanup on top — the two paths are mutually exclusive, so "augment" is achieved by the hook duplicating the built-in steps inline.

## One-sentence philosophy

`/fresh` is a re-key-and-go protocol with a pluggable reset strategy: it wipes the worktree without friction (the human running `/fresh` has already decided), fetches the fresh base, checks out a new branch, and continues inline into the PRIME on the new task — one command, one turn, one uninterrupted transition from old task to new. Repos can ship their own reset strategy at `.glorious/hooks/fresh-reset`; `/fresh` owns the invariants (safety gates, summary, PRIME kickoff) so those remain consistent across every repo that uses the harness.
