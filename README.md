# glorious-opencode

A portable, opinionated agent harness for [OpenCode](https://opencode.ai) and [Claude Code](https://claude.com/code). Drop-in global install. Five-phase orchestrator, adversarial plan review, QA gate, hashline editing, MCP wiring, Claude Code fallbacks.

Part of the `glorious` ecosystem — installs alongside other `glorious-*` tools under `$HOME/.glorious/`.

## What you get

- **Primary agents** — `orchestrator` (five-phase end-to-end), `plan` (interactive planner), `build` (plan executor)
- **Subagents** — `gap-analyzer`, `plan-reviewer`, `qa-reviewer`, `code-searcher`, `lib-reader`, `architecture-advisor`, `agents-md-writer`, `docs-maintainer`
- **Slash commands** — `/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`, `/fresh`
- **Generic skills** — `review-plan`, `web-design-guidelines`, `vercel-react-best-practices`, `vercel-composition-patterns`
- **OpenCode tools** — `ast_grep`, `tsc_check`, `eslint_check`, `todo_scan`, `comment_check`
- **OpenCode plugins**
  - Local: `notify` (OS notifications for question tool), `autopilot`, `auto-update` (opportunistic self-update at session start — see [docs/installation.md#auto-update](docs/installation.md#auto-update))
  - npm-delivered: [`opencode-hashline`](https://www.npmjs.com/package/opencode-hashline) (installed automatically into `~/.config/opencode/node_modules/`)
- **MCP server wiring** — `serena` (AST code intel), `memory` (cross-session SQLite), `git` (structured blame/log). `playwright` and `linear` defined but disabled — flip a flag to enable.
- **Claude Code parity** — tool-parity table so agents fall back gracefully on Claude Code (no `tsc_check`? use the project's typecheck command via bash. No Serena? use `grep`.)
- **Hashline edit system** — line-reference prefixes that validate content hashes before every edit. No more stale-line errors.
- **Tracker/host-agnostic commands** — `/autopilot`, `/review`, `/ship` detect and use whatever issue tracker (Linear, GitHub, Jira, Atlassian, …) and git host (GitHub, GitLab, Bitbucket, Gitea) you have configured. No hardcoding, no "Linear-only" surprises.
- **Pre-authorized worktree paths** — global `permission.external_directory` default allows `~/.glorious/worktrees/**` so `/fresh` doesn't re-prompt "Always allow" on every new worktree. See [docs/permissions.md](docs/permissions.md).

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
├── opencode.json   ← symlink (or merged real file if you customized yours — see below)
├── package.json    ← symlink (dependencies for npm-delivered plugins)
├── node_modules/   ← created by `npm install` / `bun install` at install time
├── tools/          ← symlinks …
└── plugins/        ← symlinks …
```

### What the installer won't do

- **Never overwrites your `~/.config/opencode/opencode.json` values.** If you have an existing one, the installer *merges* missing keys from our shipped version into yours non-destructively — user values always win, we only add what's absent, and a `.bak.<epoch>-<pid>` sibling is written before every mutation. See [docs/permissions.md](docs/permissions.md) for what gets merged and [AGENTS.md](AGENTS.md) for the full merge policy.
- **Never touches other `glorious-*` tools** living under `~/.glorious/`.
- **Per-file symlinks.** Any custom agent or command you drop into `~/.claude/agents/` sits happily alongside the managed ones. Only the files the installer created are tracked in `.manifest` — that's all the uninstaller will remove.

## Update

Auto-update is on by default — the `auto-update` plugin checks for new commits once a day and applies them at session start, before your first message reaches the agent. No cron, no daemon, runs only when you're using OpenCode. Full details and opt-out (`export GLORIOUS_OPENCODE_AUTO_UPDATE=0`) in [docs/installation.md#auto-update](docs/installation.md#auto-update).

To force an update manually:

```bash
~/.glorious/opencode/update.sh
# or:
cd ~/.glorious/opencode && git pull && ./install.sh
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

Default agent is `orchestrator`. For most tasks, just describe what you want — it classifies the request and runs the five-phase flow (intent → plan → execute → verify → handoff) for substantial work, or acts directly for trivial edits. Switch to the `plan` or `build` primary agent with Tab when you want tighter scope.

Slash commands are available from any agent; they load prompts from `~/.claude/commands/`:
- `/autopilot <arg>` — self-driving run. Pass a ticket ref (any tracker), a task description, or a question.
- `/review [target]` — adversarial read-only review of a PR, current branch, commit range, or file.
- `/ship <plan-path>` — finalize, commit, push, and open a PR/MR. Human-gated via the `question` tool at each step.
- `/research <topic>` — deep codebase exploration via parallel subagents.
- `/init-deep` — generate hierarchical `AGENTS.md` files for the current repo.
- `/fresh <free text or issue ref>` — create a fresh worktree with an inferred branch name, then dispatch to the repo-specific `.glorious/hooks/fresh` if present. Requires `gsag` (gs-agentic). See [docs/fresh.md](docs/fresh.md).

### Claude Code

Claude Code reads agents, commands, and skills from `~/.claude/` natively — no config needed. A few differences from OpenCode:

- OpenCode's primary-agent modes (`orchestrator`, `plan`, `build`) don't exist in Claude Code. Use the Task tool to delegate: `@orchestrator`, `@plan`, `@build`. Most sessions just invoke `@orchestrator` and let it drive.
- OpenCode-native tools (`tsc_check`, `eslint_check`, `ast_grep`, `hashline_edit`) aren't available. Agents fall back to the bash equivalents (`pnpm typecheck` / `npm run lint` / `grep` / standard `edit`) automatically. See `~/.config/opencode/AGENTS.md` → "Tool parity" section for the full mapping.
- The `question` tool (OS-notification prompts) maps to Claude Code's `AskUserQuestion`.

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
- **Probe, don't prescribe.** Commands detect whatever tracker/host/language toolchain you have and adapt. Agents don't assume `pnpm` or `gh` or Linear — they discover from `package.json`, `git remote`, configured MCPs.

## Repo-specific extensions

This repo is intentionally generic. Project-specific skills / commands / agents belong in your repo's `.claude/` and `.opencode/` directories — OpenCode and Claude Code both merge project config over global. Drop a skill at `.claude/skills/my-domain/SKILL.md` and it's available in that project only.

## Roadmap

See [open issues](https://github.com/iceglober/glorious-opencode/issues) tagged `review-followup` for the known-good follow-up work: automated install/uninstall test matrix, orphan detection on update, `--doctor` subcommand, `.manifest` location refactor, etc.

## Contributing

Pull requests welcome. Before submitting, read [`AGENTS.md`](./AGENTS.md) — it covers the two-plugin model (local `.ts` vs npm-delivered), the per-file symlink discipline, and the portability rules the installer scripts follow (POSIX-bash-portable, dry-run honored everywhere, never clobber existing user config).

## License

MIT
