# @glrs-dev/harness-opencode

Opinionated agent harness for [OpenCode](https://opencode.ai). Agents, tools, slash commands, and an unattended pilot mode — one package.

## Quick start

### CLI (recommended)

```bash
bun add -g @glrs-dev/harness-opencode
glrs-oc install-plugin
opencode
```

Gives you the full CLI (`glrs-oc`) plus all [plugin features](#what-the-plugin-provides) inside OpenCode.

### Plugin only

```bash
bunx @glrs-dev/harness-opencode install
opencode
```

No global install. All [plugin features](#what-the-plugin-provides) load automatically. You won't have the `glrs-oc` CLI, but pilot commands will offer to install the plugin if you add the CLI later.

---

## The Glorious workflow

### Interactive (plugin)

Open OpenCode in any repo. The `prime` agent handles everything end-to-end.

**Start a task from a ticket:**
```
/fresh ENG-1234
```
Wipes the worktree, creates a branch from the ticket ref, and begins the five-phase workflow: understand → plan → execute → verify → handoff.

**Start a task from a description:**
```
/fresh add rate limiting to the upload endpoint
```

**Go hands-off after the plan looks good:**
```
/autopilot ENG-1234
```
Runs the full workflow unattended. Stops when all acceptance criteria are checked off. You review, then `/ship`.

**Ship when done:**
```
/ship ~/.glorious/opencode/repo/plans/feat-rate-limit.md
```
Squashes commits, pushes, opens a PR with the plan as the body.

**Review a PR:**
```
/review 87
```
Read-only adversarial review. Fetches the diff, runs typecheck/lint, delegates to `@qa-reviewer`, outputs a structured verdict.

**Deep codebase research:**
```
/research how does authentication work in this codebase?
```
Spawns parallel subagents, synthesizes findings with exact file:line references.

### Unattended (pilot CLI)

For larger work that decomposes into a multi-task DAG. Each task runs in an isolated git worktree with its own verify commands.

```bash
# Plan interactively — spawns OpenCode TUI with the pilot-planner agent
glrs-oc pilot plan "Refactor the billing module into separate services"

# Validate the plan (schema, DAG, glob conflicts)
glrs-oc pilot validate

# Execute — fully unattended, isolated worktrees, topological order
glrs-oc pilot build

# Check progress
glrs-oc pilot status
```

See [Pilot mode](#pilot-mode) for the full command reference.

---

## What the plugin provides

14 agents, 7 slash commands, 5 tools, 5 MCPs, 5 skill bundles, 4 sub-plugins. Details below.

### Agents

| Agent | Tier | Role |
|-------|------|------|
| `prime` | deep | Five-phase end-to-end workflow (default agent) |
| `plan` | deep | Interactive planner with gap analysis and adversarial review |
| `build` | mid | Plan executor |
| `qa-reviewer` | mid | Fast adversarial code review |
| `qa-thorough` | deep | Full-suite adversarial review |
| `plan-reviewer` | deep | Adversarial plan review |
| `gap-analyzer` | deep | Identifies gaps in plans |
| `architecture-advisor` | deep | Architecture guidance |
| `code-searcher` | fast | Codebase search specialist |
| `docs-maintainer` | mid | Documentation updates |
| `lib-reader` | mid | Library/dependency reader |
| `agents-md-writer` | mid | AGENTS.md generation |
| `pilot-builder` | mid | Unattended task executor (pilot subsystem) |
| `pilot-planner` | deep | Decomposes work into pilot.yaml DAGs |

Tiers: **deep** = opus-class, **mid** = sonnet-class, **fast** = haiku-class. Override with [`harness.models`](#model-overrides).

### Slash commands

| Command | What it does |
|---------|-------------|
| `/fresh <ref>` | Wipe worktree, branch from ticket or description, start PRIME |
| `/autopilot <ref>` | Hands-off PRIME run; stops when acceptance criteria pass |
| `/ship <plan>` | Squash, push, open PR |
| `/review <target>` | Read-only adversarial review (PR#, SHA, branch, or file) |
| `/research <topic>` | Parallel codebase exploration with file:line citations |
| `/init-deep` | Generate hierarchical AGENTS.md files |
| `/costs` | Show running LLM spend totals |

### Tools

`ast_grep` · `tsc_check` · `eslint_check` · `todo_scan` · `comment_check`

### MCP servers

| Server | Status | Backend |
|--------|--------|---------|
| `serena` | enabled | AST code intelligence via `uvx` |
| `memory` | enabled | Per-repo JSON memory |
| `git` | enabled | Structured blame/log via `uvx` |
| `playwright` | disabled | Browser automation — enable in opencode.json |
| `linear` | disabled | Linear issue tracker — enable in opencode.json |

### Sub-plugins

- **autopilot** — idle-nudge loop driver (only activates via `/autopilot`)
- **notify** — OS notifications when the agent asks a question
- **cost-tracker** — LLM spend by provider/model at `~/.glorious/opencode/costs.json`
- **pilot-plugin** — runtime invariant enforcement for pilot agents

### Skills

`review-plan` · `web-design-guidelines` · `vercel-react-best-practices` · `vercel-composition-patterns` · `pilot-planning`

---

## Pilot mode

Runs a `pilot.yaml` task DAG fully unattended. Tasks have dependencies, touch-globs (file ownership), and verify commands. The worker executes them in topological order, each in an isolated git worktree.

**Prerequisites:** `git` >= 2.5, `opencode` on PATH. Plugin must be installed (auto-prompted if missing).

### Commands

| Command | Description |
|---------|-------------|
| `glrs-oc pilot plan [input]` | Spawn OpenCode TUI with `pilot-planner`. Input: Linear ID, GitHub URL, or text. |
| `glrs-oc pilot validate [path]` | Schema + DAG + glob validation. Defaults to newest plan. |
| `glrs-oc pilot build` | Execute the plan. `--plan <path>`, `--dry-run`, `--filter <id>`. |
| `glrs-oc pilot status` | Task statuses for the current run. `--run <id>`, `--json`. |
| `glrs-oc pilot resume` | Continue a partial run. Skips succeeded tasks. |
| `glrs-oc pilot retry <task>` | Reset one task to pending. `--run-now` to re-execute immediately. |
| `glrs-oc pilot logs <task>` | Events and verify output for a task. |
| `glrs-oc pilot worktrees list\|prune` | Manage pilot's git worktrees. |
| `glrs-oc pilot cost` | Per-task and total LLM cost. `--json`. |
| `glrs-oc pilot plan-dir` | Print the plans directory path. |

### State storage

```
~/.glorious/opencode/<repo>/pilot/
  plans/                  # YAML plans
  runs/<runId>/
    state.db              # SQLite (runs, tasks, events)
    workers/00.jsonl      # structured logs
  worktrees/<runId>/00/   # isolated git worktree
```

Repo identity derived from `git rev-parse --git-common-dir` — worktrees of the same repo share state. Override with `$GLORIOUS_PILOT_DIR`.

> **v0.1:** single worker only. `--workers >1` clamps to 1. Parallel scheduling deferred to v0.3+.

---

## Configuration

### Model overrides

Override all agents in a tier, or target specific agents, via `harness.models` in `opencode.json`:

```json
{
  "harness": {
    "models": {
      "deep": ["bedrock/claude-opus-4"],
      "mid": ["bedrock/claude-sonnet-4"],
      "fast": ["bedrock/claude-haiku-4"],
      "prime": ["my-custom-model"]
    }
  }
}
```

**Precedence:** per-agent `harness.models.X` > tier `harness.models.deep` > plugin default. Direct `agent.<name>.model` in opencode.json wins over all.

### Agent/command/MCP overrides

Your opencode.json values win. Example:

```json
{
  "agent": {
    "prime": { "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

### Enabling optional MCPs

```json
{
  "mcp": {
    "playwright": { "enabled": true },
    "linear": { "enabled": true }
  }
}
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `glrs-oc install-plugin [--pin] [--dry-run]` | Register plugin in opencode.json |
| `glrs-oc uninstall [--dry-run]` | Remove plugin from opencode.json |
| `glrs-oc doctor` | Check installation health |
| `glrs-oc pilot <verb>` | [Pilot mode](#pilot-mode) |
| `glrs-oc plan-dir` | Print repo-shared plan directory |
| `glrs-oc plan-check <path>` | Validate legacy markdown plan files |

`install` is an alias for `install-plugin`.

---

## Maintenance

**Update:**
```bash
bun update -g @glrs-dev/harness-opencode
```

**Pin version:** `glrs-oc install-plugin --pin`

**Rollback:** `npm deprecate @glrs-dev/harness-opencode@<broken> "<reason>"` — then ship a patch.

**Uninstall:**
```bash
glrs-oc uninstall                           # remove from opencode.json
bun remove -g @glrs-dev/harness-opencode    # remove CLI
```

## Prerequisites

- [OpenCode](https://opencode.ai)
- `bun`
- `uvx` for serena + git MCPs (`brew install uv`)
- `node`/`npx` for memory MCP
- `git` >= 2.5 for pilot worktrees

## Privacy & Telemetry

**Update check.** Daily version check against `registry.npmjs.org`. Opt out: `HARNESS_OPENCODE_UPDATE_CHECK=0`.

**Telemetry.** `@glrs-dev/harness-opencode` collects anonymous usage data via [Aptabase](https://aptabase.com) to help improve reliability. The data is opt-out, contains no personal information, and has no stable user identifier — Aptabase tracks anonymous sessions only.

**What gets sent:** package version, OS, Node version, which tools were invoked (hashline, serena, memory, custom tools), tool durations, file extensions of edited files (e.g. `.ts`), edit success/failure outcomes, and hashline mismatch rates.

**What never gets sent:** file paths, file contents, code, prompts, model outputs, error messages, project names, git remotes, usernames, or anything that could identify a user or codebase.

To disable, set any of these in your shell:

```bash
export HARNESS_OPENCODE_TELEMETRY=0
export DO_NOT_TRACK=1                   # standard cross-tool opt-out
```

Telemetry is also automatically disabled when `CI=true`.

## Migrating from clone+symlink install

See [docs/migration-from-clone-install.md](docs/migration-from-clone-install.md).

## Contributing

Read [`AGENTS.md`](./AGENTS.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md). All user-visible PRs need a changeset (`bunx changeset`).

## License

MIT
