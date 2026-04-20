# `/fresh` — fresh worktree + repo-specific provisioning

`/fresh` creates a new git worktree, infers a descriptive branch name from free text or an issue-tracker reference, and dispatches to a repo-specific hook for any custom provisioning.

The command itself is intentionally generic. All repo-specific logic (spinning up databases, copying config, seeding test data, etc.) lives in the consuming repo's `.glorious/hooks/fresh` executable.

## Basic use

```bash
/fresh add SAML support            # → feat/saml-support branch
/fresh fix null pointer            # → fix/null-pointer branch
/fresh ENG-1234                    # → Linear branchName (if Linear MCP enabled)
/fresh ENG-1234 --from release/v3  # same, off release branch
/fresh investigate perf --clean    # and prune stale worktrees after
```

## The hook contract

When `/fresh` finishes creating + renaming the worktree, it checks for `<new-worktree>/.glorious/hooks/fresh`. If that path exists and is executable, `/fresh` invokes it and passes:

**Environment variables:**

| Variable | Description |
|---|---|
| `WORKTREE_DIR` | Absolute path to the new worktree |
| `WORKTREE_NAME` | Directory basename (e.g. `wt-260419-134521-xyz`) |
| `BRANCH_NAME` | Final branch name (after rename) |
| `BASE_BRANCH` | What the worktree was based on (e.g. `main`) |
| `FRESH_PASSTHROUGH_ARGS` | Space-joined pass-through args (informational) |

**Positional args:** everything not consumed by `/fresh`'s core flags (`--from`, `--clean`) is forwarded to the hook verbatim. Use `getopts` or a `case` loop inside the hook to parse your own flags (e.g. `--with-db`).

**Exit codes:**

- `0` — success; `/fresh` continues to the summary step.
- non-zero — warning; `/fresh` prints the hook's output, the worktree is still valid, and the user can re-run the hook manually.

**Optional output:** if the hook writes a single-line JSON object to the **last line of stdout**, `/fresh` will parse it and include it in the summary. Example: `{"postgresPort": 5442, "dbRunning": true}`.

## Hook template

```bash
#!/usr/bin/env bash
# .glorious/hooks/fresh
#
# Runs after a new worktree is created via /fresh.
# Env: WORKTREE_DIR, WORKTREE_NAME, BRANCH_NAME, BASE_BRANCH, FRESH_PASSTHROUGH_ARGS
# Args: $@ = pass-through args from /fresh (repo-specific flags)

set -euo pipefail

# --- Parse pass-through args ---

WITH_DB=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-db) WITH_DB=true; shift ;;
    --*) shift ;;   # silently ignore unknown flags so /fresh can add flags later
    *) shift ;;
  esac
done

# --- Standard post-create tasks ---

cd "$WORKTREE_DIR"

# Install dependencies (whatever your toolchain needs)
if [[ -f package.json ]]; then
  command -v pnpm >/dev/null && pnpm install --frozen-lockfile \
    || command -v npm >/dev/null && npm ci \
    || true
fi

# Copy local config (never from parent .env — inherits stale values)
[[ -f .env.example ]] && [[ ! -f .env ]] && cp .env.example .env || true

# Your repo-specific provisioning here:
# - allocate ports from a shared lock namespace
# - spin up containers
# - run migrations
# - seed test data
# - etc.

# Optional: emit a JSON summary on the last line of stdout
printf '{"ready": true}\n'
```

Mark it executable and commit it:

```bash
chmod +x .glorious/hooks/fresh
git add .glorious/hooks/fresh
```

New worktrees created with `/fresh` will invoke it automatically.

## Standardised sub-commands (optional)

`/fresh` may call the hook with a reserved first argument to request a specific phase. Hooks should check for these and no-op if unrecognised:

| Sub-command | When called | Purpose |
|---|---|---|
| (none — default) | After worktree creation | Standard post-create provisioning |
| `pre-delete` | Before `gsag wt delete` during `/fresh --clean` | Give the hook a chance to clean up external resources (containers, DBs, volumes) before the worktree is removed |

Pattern:

```bash
case "${1:-post-create}" in
  pre-delete)
    # Tear down resources owned by this worktree
    ;;
  post-create|*)
    # Normal provisioning (default)
    ;;
esac
```

## Worked example: repo with per-branch Postgres

Suppose your repo needs an isolated Postgres container per worktree (so concurrent agents don't step on each other's DB state).

1. Put the provisioning logic in a `scripts/sh/workspace-up.sh` in your repo — that script claims a port slot, runs `docker run postgres:18`, runs migrations.
2. Add `scripts/sh/workspace-down.sh` that stops the container + preserves port reservation.
3. Write `.glorious/hooks/fresh`:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail

   WITH_DB=false
   PHASE="${1:-post-create}"
   # shift off the phase if it was one of our reserved names
   [[ "$PHASE" == "post-create" || "$PHASE" == "pre-delete" ]] && shift || true

   while [[ $# -gt 0 ]]; do
     case "$1" in
       --with-db) WITH_DB=true; shift ;;
       *) shift ;;
     esac
   done

   case "$PHASE" in
     pre-delete)
       # Called before /fresh --clean removes this worktree
       bash "$WORKTREE_DIR/scripts/sh/workspace-down.sh" --worktree-dir "$WORKTREE_DIR"
       ;;
     post-create)
       cd "$WORKTREE_DIR"
       [[ -f package.json ]] && pnpm install --frozen-lockfile
       [[ -f .env.example && ! -f .env ]] && cp .env.example .env

       # Always reserve a port slot + patch .env
       bash "$WORKTREE_DIR/scripts/sh/workspace-init-env.sh" --worktree-dir "$WORKTREE_DIR"

       # Optionally spin up Postgres
       if [[ "$WITH_DB" == "true" ]]; then
         bash "$WORKTREE_DIR/scripts/sh/workspace-up.sh" --worktree-dir "$WORKTREE_DIR"
       fi

       # Summary line for /fresh to display
       port=$(python3 -c "import json; print(json.load(open('$WORKTREE_DIR/.workspace-ready'))['pgPort'])" 2>/dev/null || echo null)
       printf '{"postgresPort": %s, "dbRunning": %s}\n' "$port" "$WITH_DB"
       ;;
   esac
   ```

Now `/fresh add SAML support` reserves a port; `/fresh add SAML support --with-db` reserves AND starts Postgres; `/fresh --clean` tears down the DB before deleting the worktree.

## Why this design

- **Generic core.** The common parts of "start fresh work" (create worktree, name the branch sensibly, optionally clean up stale ones) are universal; they belong in `glorious-opencode`.
- **Repo-specific provisioning via hook.** Every repo's "what does a fresh workspace need" story is different. A hook keeps `/fresh` simple while giving each repo full control.
- **Pass-through args.** `/fresh` doesn't need to know about `--with-db` or `--with-redis` or `--skip-seeds`. The hook owns those flags.
- **Fail-open on hook errors.** A misbehaving hook shouldn't prevent the worktree from existing. The user can always re-run the hook manually after fixing it.
