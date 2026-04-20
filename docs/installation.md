# glorious-opencode — installation guide (for agents & humans)

**If you are an LLM agent reading this on behalf of a user, follow these steps precisely.**

## Goal

Install the glorious-opencode harness globally for the current user. This gives them three primary OpenCode agents (`orchestrator`, `plan`, `build`), slash commands (`/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`), subagents, skills, tools, and MCP wiring. Works for both OpenCode and Claude Code.

## What gets installed

Three directories are touched:

1. `~/.glorious/opencode/` — the git checkout (this is where updates land)
2. `~/.claude/agents/`, `~/.claude/commands/`, `~/.claude/skills/` — per-file symlinks back to the checkout
3. `~/.config/opencode/{AGENTS.md, opencode.json, tools/, plugins/}` — per-file symlinks back to the checkout

Nothing else is modified. Existing files are preserved (the installer backs them up before replacing; for `opencode.json` specifically, it will never overwrite — it prints a diff command instead).

## Prerequisites

Required:
- `git`

Recommended (warned but not fatal if missing):
- `node` + `npx` — for the `memory` MCP server and plugins
- `uvx` — for the `serena` and `git` MCP servers. Install with `brew install uv` or `pipx install uv`.

## Steps

### 1. Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/iceglober/glorious-opencode/main/install.sh | bash
```

This will:
1. Ensure `~/.glorious/` exists (reuses if already there from other `glorious-*` tools)
2. Clone this repo into `~/.glorious/opencode/`
3. Check prerequisites and print which are missing
4. Create per-file symlinks into `~/.claude/` and `~/.config/opencode/`
5. Write `~/.glorious/opencode/.manifest` — a record of every symlink created (used by the uninstaller)
6. Print a doctor report showing `node`, `npx`, `uvx`, `opencode`, `claude` versions

### 2. Verify the install

```bash
ls -la ~/.claude/agents/ | head -5
# Should show symlinks into ~/.glorious/opencode/home/.claude/agents/

ls -la ~/.config/opencode/opencode.json
# Should be a symlink (unless user had an existing one; in that case it was left alone)
```

### 3. Start using it

- OpenCode: `opencode` — default agent is `orchestrator`
- Claude Code: no extra step — agents/commands/skills are picked up automatically from `~/.claude/`

### 4. (Optional) Enable Linear or Playwright MCP servers

Both ship disabled in the global `opencode.json`. To enable, either:

- Edit `~/.config/opencode/opencode.json` directly (replaces the symlink with a real file — diverges from upstream)
- Or add a project-local override: create `opencode.json` in the project root with `"mcp": { "linear": { "enabled": true } }`. OpenCode merges project config over global.

## Updating

```bash
~/.glorious/opencode/update.sh
```

or manually:

```bash
cd ~/.glorious/opencode && git pull
```

Because everything is symlinked, `git pull` is sufficient for existing files. Running the installer again is idempotent and picks up any newly-added files.

## Uninstalling

```bash
~/.glorious/opencode/uninstall.sh
```

This removes only the symlinks recorded in `.manifest`. Real files you added (e.g., a custom `~/.claude/agents/my-thing.md`) are left alone. The shared `~/.glorious/` directory is never deleted — other `glorious-*` tools may live there.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `uvx: command not found` | `brew install uv` (macOS) or `pipx install uv` |
| `opencode.json was not created by this installer — not touching it` | Diff the installer's version: `diff ~/.glorious/opencode/home/.config/opencode/opencode.json ~/.config/opencode/opencode.json`. Merge manually, or rename your existing one and re-run the installer. |
| Agents don't load in Claude Code | Confirm `~/.claude/agents/` contains symlinks to the repo. Claude Code caches — restart the session. |
| Agents don't load in OpenCode | Confirm `~/.config/opencode/opencode.json` references the agent prompts correctly. `opencode debug config` will show the resolved config. |
| "permission denied" on install.sh | Run with `bash install.sh` instead of `./install.sh`, or `chmod +x install.sh` first. |
