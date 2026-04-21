# Migrating from the clone+symlink model to the npm plugin

**Status (as of this commit):** `glorious-opencode` is pivoting to a single npm-delivered OpenCode plugin. The current clone+symlink installer (`install.sh`, `update.sh`, `uninstall.sh`, and `~/.glorious/opencode/`) is being retired.

This commit is a **pre-pivot warning commit**. Nothing has moved yet. This doc is here so your next `update.sh` / auto-update run prints a pointer to the plan and you have time to prepare.

## When the pivot lands

In the coming weeks, a single PR will land on `main` that:

- Deletes `install.sh`, `update.sh`, `uninstall.sh`, `.manifest`, and the entire `home/` tree from this repo.
- Replaces them with a TypeScript OpenCode plugin published to npm as `@glorious/harness-opencode`.
- Leaves a tiny 7-line `install.sh` redirect stub at the repo root so the old `curl | bash` one-liner keeps working — it just prints the migration command and exits cleanly.

**The pivot commit will be preceded by a tag** named `v0-legacy-clone-install` on the commit immediately before it. That tag will be promoted to a GitHub Release whose assets include the final `install.sh`, `update.sh`, and `uninstall.sh` — so you can always retrieve them later to cleanly uninstall the old model even after they're removed from `main`.

## What you need to do

**Right now: nothing.** You can keep using the clone+symlink install. It will continue to work until the pivot PR merges.

**When the pivot lands**, your existing install will stop receiving updates via `auto-update.ts` (the plugin itself gets deleted). At that point:

### Step 1: clean up the old install

```bash
# Download the final-legacy uninstall.sh from the v0-legacy-clone-install release
curl -fsSL https://github.com/iceglober/glorious-opencode/releases/download/v0-legacy-clone-install/uninstall.sh -o /tmp/legacy-uninstall.sh
bash /tmp/legacy-uninstall.sh
```

### Step 2: remove any dangling symlinks

If OpenCode or Claude Code misbehaves after the pull, it's probably because the uninstaller was unable to clean some files (user-customized, non-symlink content the uninstaller intentionally preserves). Remove any remaining dangling symlinks with:

```bash
find ~/.claude ~/.config/opencode -xtype l -delete
```

`-xtype l` matches dangling symlinks; `-delete` removes them. Safe on both BSD (macOS) and GNU (Linux) `find`.

### Step 3: install the npm plugin

```bash
bunx @glorious/harness-opencode install
```

This CLI adds `@glorious/harness-opencode` to your `~/.config/opencode/opencode.json` `plugin` array (non-destructively — your existing plugins are preserved, `.bak` created before any write). Skills, agents, and commands are registered at runtime from the npm package; nothing is written to `~/.config/opencode/skills/` or similar.

### Step 4: start OpenCode

The plugin is loaded by OpenCode's startup. Agents, commands, tools, MCPs, and skills appear on first session start.

## If you run into trouble

- **`update.sh` fails after the pivot pull with ENOENT**: the script file itself was deleted. Either re-run `curl | bash` (the redirect stub will point you here), or manually follow the three steps above.
- **`opencode` fails to start with a dangling-symlink error**: run step 2 above.
- **You want to keep using the clone+symlink install indefinitely**: pin your local checkout to the `v0-legacy-clone-install` tag (`cd ~/.glorious/opencode && git checkout v0-legacy-clone-install`). It will stop receiving updates but will continue to work.

## Why this change

- The clone+symlink model makes every shipped file a symlink into a git-tracked tree. User edits through any of those symlinks (most commonly `opencode.json`) write through to the repo and abort the next `git pull --ff-only`. This is a structural bug, not fixable without moving delivery off git.
- npm delivery eliminates ~2,400 lines of installer/updater/migration shell.
- The OpenCode plugin `config` hook lets us register agents, commands, MCPs, tools, and skills at runtime from a node_modules-owned read-only bundle. No files are written to user space except a single plugin-array entry in `opencode.json`.
- Updates become standard npm semver: `bun update @glorious/harness-opencode`. No cron, no daemon, no state file, no dirty-tree gates.
- Claude Code support is deferred to a Phase B release with a separate CLI subcommand that writes agent/command/skill files into `~/.claude/`. Until that ships, this plugin is OpenCode-only.

See `.agent/plans/pivot-npm-plugin.md` in the repo for the full plan.
