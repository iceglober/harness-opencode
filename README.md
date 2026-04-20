# glorious-opencode

A portable, opinionated agent harness for [OpenCode](https://opencode.ai) and [Claude Code](https://claude.com/code). Drop-in global install. Five-phase orchestrator, adversarial plan review, QA gate, hashline editing, MCP wiring, Claude Code fallbacks.

Part of the `glorious` ecosystem — installs alongside other `glorious-*` tools under `$HOME/.glorious/`.

## What you get

- **Primary agents** — `orchestrator` (five-phase end-to-end), `plan` (interactive planner), `build` (plan executor)
- **Subagents** — `gap-analyzer`, `plan-reviewer`, `qa-reviewer`, `code-searcher`, `lib-reader`, `architecture-advisor`, `agents-md-writer`, `docs-maintainer`
- **Slash commands** — `/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`
- **Generic skills** — `review-plan`, `web-design-guidelines`, `vercel-react-best-practices`, `vercel-composition-patterns`
- **OpenCode tools** — `ast_grep`, `tsc_check`, `eslint_check`, `todo_scan`, `comment_check`
- **OpenCode plugins**
  - Local: `notify` (OS notifications for question tool), `autopilot`
  - npm-delivered: [`opencode-hashline`](https://www.npmjs.com/package/opencode-hashline) (installed automatically into `~/.config/opencode/node_modules/`)
- **MCP server wiring** — `serena` (AST code intel), `memory` (cross-session SQLite), `git` (structured blame/log). `playwright` and `linear` defined but disabled — flip a flag to enable.
- **Claude Code parity** — tool-parity table so agents fall back gracefully on Claude Code (no `tsc_check`? use `pnpm typecheck`. No Serena? use `grep`.)
- **Hashline edit system** — line-reference prefixes that validate content hashes before every edit. No more stale-line errors.

## Install

```bash
# Method 1: one-shot via curl (recommended)
curl -fsSL https://raw.githubusercontent.com/iceglober/glorious-opencode/main/install.sh | bash

# Method 2: clone first, install from checkout
git clone https://github.com/iceglober/glorious-opencode.git ~/.glorious/opencode
bash ~/.glorious/opencode/install.sh
```

Both methods produce the same layout:

```
~/.glorious/
└── opencode/                      ← this repo (tracked via git pull)
    ├── install.sh
    ├── uninstall.sh
    ├── update.sh
    ├── .manifest                  ← records every symlink we created
    └── home/                      ← files to symlink into place
        ├── .claude/{agents,commands,skills}/…
        └── .config/opencode/{tools,plugins,AGENTS.md,opencode.json}

~/.claude/
├── agents/        ← symlinks into ~/.glorious/opencode/home/.claude/agents/
├── commands/      ← symlinks …
└── skills/        ← symlinks …

~/.config/opencode/
├── AGENTS.md       ← symlink
├── opencode.json   ← symlink (IF you had no existing one; see below)
├── package.json    ← symlink (dependencies for npm-delivered plugins)
├── node_modules/   ← created by `npm install` / `bun install` at install time
├── tools/          ← symlinks …
└── plugins/        ← symlinks …
```

### What the installer won't do

- **Never clobbers your existing `~/.config/opencode/opencode.json`.** If you already have one, the installer leaves it alone and prints the diff command so you can merge manually.
- **Never touches other `glorious-*` tools** living under `~/.glorious/`.
- **Per-file symlinks.** Any custom agent or command you drop into `~/.claude/agents/` sits happily alongside the managed ones. Only the files the installer created are tracked in `.manifest` — that's all the uninstaller will remove.

## Update

```bash
~/.glorious/opencode/update.sh
# or manually:
cd ~/.glorious/opencode && git pull
```

Because everything is symlinked, `git pull` is sufficient for existing files. Running `install.sh` again refreshes any new additions and is idempotent.

## Uninstall

```bash
~/.glorious/opencode/uninstall.sh
```

This removes only the symlinks recorded in `.manifest`. You'll be asked whether to also delete `~/.glorious/opencode/`. The shared `~/.glorious/` directory is never deleted — other `glorious-*` tools may live there.

## Usage

### OpenCode

After install, launch OpenCode in any repo:

```bash
opencode
```

Default agent is `orchestrator` — for most tasks, just describe what you want and it classifies + dispatches (five-phase flow for substantial work, direct action for trivial edits). Switch to the `plan` or `build` primary agent with Tab. Slash commands (`/ship`, `/autopilot`, `/review`, etc.) are available from any agent; they load prompts from `~/.claude/commands/`.

### Claude Code

Works identically — Claude Code reads from `~/.claude/agents/`, `~/.claude/commands/`, and `~/.claude/skills/` natively. The only difference is some OpenCode-specific tools (e.g., `tsc_check`) aren't available; agents fall back to their bash equivalents automatically (see `~/.config/opencode/AGENTS.md` → "Tool parity" section).

### Enabling Linear / Playwright MCPs

Both ship disabled. To enable, edit `~/.config/opencode/opencode.json` and flip `enabled: true` on the relevant `mcp` entry. Note: editing the file replaces the symlink with a real file. To stay in sync with upstream, consider doing the override in a project-local `opencode.json` instead — OpenCode merges project config over global.

## Prerequisites

- `git` (required)
- `npm` or `bun` (required — to install the `opencode-hashline` npm plugin into `~/.config/opencode/node_modules/`). If you have `node`, you have `npm`. For faster installs, `brew install bun`.
- `node` / `npx` (for the `memory` MCP server)
- `uvx` (for the `serena` and `git` MCP servers — install with `brew install uv` or `pipx install uv`)

The installer's doctor step reports which of these are missing.

## Philosophy

- **Five phases, one session.** `orchestrator` takes a request from intent → plan → execute → verify → handoff in one conversation. No hand-offs, no ceremony.
- **Adversarial gates.** Every plan goes through `@plan-reviewer` (returns `[OKAY]` or `[REJECT]`). Every implementation goes through `@qa-reviewer` before handoff.
- **Context isolation via subagents.** Large searches, planning, QA runs happen in subagent contexts so the orchestrator's context stays lean.
- **Human gate = `/ship`.** Agents commit freely, but never push or open PRs until you explicitly run `/ship`. Hard rules: no force push, no push to main/master, no merging without explicit user consent.
- **Question tool > free-text asks.** When an agent needs clarification, it fires an OS notification via the `question` tool so users who stepped away actually see it.

## Repo-specific extensions

This repo is intentionally generic. Project-specific skills / commands / agents belong in your repo's `.claude/` and `.opencode/` directories — OpenCode and Claude Code both merge project config over global. Drop a skill at `.claude/skills/my-domain/SKILL.md` and it's available in that project only.

## License

MIT
