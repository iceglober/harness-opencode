# @glrs-dev/harness-opencode

An opinionated OpenCode agent harness delivered as a single npm package. Two ways to use it:

| Path | Install | What you get |
|------|---------|-------------|
| **Plugin only** | `bunx @glrs-dev/harness-opencode install` | Agents, slash commands, tools, MCPs, and skills in your OpenCode sessions. No CLI needed. |
| **CLI** | `bun add -g @glrs-dev/harness-opencode` | Everything above, plus the `glrs-oc` command for pilot mode (unattended task execution) and other utilities. |

Both paths ship in the same package. The CLI path is a superset — it can install the plugin for you (`glrs-oc install-plugin`), and pilot commands will prompt to install the plugin automatically if it's missing.

---

## Path A: Plugin only

If you just want the agents and tools inside OpenCode:

```bash
bunx @glrs-dev/harness-opencode install
opencode
```

Done. The installer adds one entry to `~/.config/opencode/opencode.json`. OpenCode loads the plugin on startup. No global install, no CLI on PATH.

### What the plugin provides

- **14 agents** — `orchestrator` (five-phase end-to-end), `plan` (interactive planner), `build` (plan executor), `qa-reviewer`, `qa-thorough`, `plan-reviewer`, `gap-analyzer`, `code-searcher`, `architecture-advisor`, `docs-maintainer`, `lib-reader`, `agents-md-writer`, `pilot-builder`, `pilot-planner`
- **7 slash commands** — `/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`, `/fresh`, `/costs`
- **5 custom tools** — `ast_grep`, `tsc_check`, `eslint_check`, `todo_scan`, `comment_check`
- **5 MCP servers** — `serena` (AST code intel), `memory` (per-repo JSON memory), `git` (structured blame/log). `playwright` and `linear` defined but disabled by default.
- **5 skill bundles** — `review-plan`, `web-design-guidelines`, `vercel-react-best-practices`, `vercel-composition-patterns`, `pilot-planning`
- **4 sub-plugins** — `autopilot` (opt-in completion loop), `notify` (OS notifications), `cost-tracker` (LLM spend tracking), `pilot-plugin` (runtime invariant enforcement)

### Customize

**Agents, commands, MCPs:** your `opencode.json` overrides win. To swap the orchestrator model:

```json
{
  "agent": {
    "orchestrator": {
      "model": "anthropic/claude-sonnet-4-6"
    }
  }
}
```

**Model tiers:** override all agents in a tier at once via `harness.models`:

```json
{
  "harness": {
    "models": {
      "deep": ["bedrock/claude-opus-4"],
      "mid": ["bedrock/claude-sonnet-4"],
      "fast": ["bedrock/claude-haiku-4"]
    }
  }
}
```

Per-agent overrides in `harness.models` win over tier. Direct `agent.<name>.model` overrides in `opencode.json` win over everything.

**Skills:** read-only by design (they live in `node_modules`). To customize, fork the package.

---

## Path B: CLI install

If you want pilot mode or the utility commands:

```bash
bun add -g @glrs-dev/harness-opencode
```

This puts `glrs-oc` (and `harness-opencode`) on your PATH. You can then install the plugin via the CLI:

```bash
glrs-oc install-plugin
```

Or skip that step — pilot commands (`plan`, `build`, `resume`, `retry`) will detect that the plugin is missing and offer to install it for you.

### CLI commands

| Command | Description |
|---------|-------------|
| `glrs-oc install-plugin` | Register the plugin in opencode.json (same as `bunx ... install`). |
| `glrs-oc doctor` | Check installation health (OpenCode, plugin, MCPs, git, pilot agents). |
| `glrs-oc pilot <verb>` | Pilot subsystem — see below. |
| `glrs-oc plan-dir` | Print the repo-shared plan directory path. |
| `glrs-oc plan-check <path>` | Parse a plan file's plan-state fence (legacy markdown plans). |
| `glrs-oc uninstall` | Remove the plugin from opencode.json. |

`install` is kept as an alias for `install-plugin` for backwards compatibility.

### Pilot mode

The pilot subsystem runs a `pilot.yaml` task DAG fully unattended. You define tasks with dependencies, touch-globs, and verify commands; the pilot worker executes them in topological order using isolated git worktrees.

**Prerequisites:** `git` >= 2.5, `opencode` CLI on PATH, plugin installed (auto-prompted if missing).

**Quick start:**

```bash
# 1. Create a plan interactively (spawns OpenCode TUI with the pilot-planner agent)
glrs-oc pilot plan "Add user auth with OAuth"

# 2. Validate the plan (schema, DAG cycles, glob conflicts)
glrs-oc pilot validate

# 3. Run the plan (single worker, isolated worktrees, fully unattended)
glrs-oc pilot build

# 4. Check progress
glrs-oc pilot status
```

**Pilot verbs:**

| Verb | Description |
|------|-------------|
| `plan [input]` | Spawn the OpenCode TUI with the `pilot-planner` agent. Input can be a Linear ID, GitHub URL, or text description. |
| `validate [path]` | Validate a `pilot.yaml` against schema, DAG, and glob rules. Defaults to newest plan. |
| `build` | Run the pilot worker against a plan. `--plan <path>`, `--dry-run`, `--filter <id>`. |
| `status` | Print the current run's task statuses. `--run <id>`, `--json`. |
| `resume` | Continue a partially-completed run. Skips succeeded tasks. |
| `retry <task-id>` | Reset a single task to pending and optionally re-run. `--run-now`. |
| `logs <task-id>` | Print events and verify outputs for a task. |
| `worktrees list\|prune` | List or prune git worktrees managed by pilot. |
| `cost` | Print per-task and total LLM cost for a run. `--json`. |
| `plan-dir` | Print the resolved plan directory path (creates if missing). |

**State storage:**

All pilot state lives under `~/.glorious/opencode/<repo>/pilot/`:

```
pilot/
  plans/                  # YAML plans (input artifacts)
  runs/<runId>/
    state.db              # SQLite (runs, tasks, events)
    workers/00.jsonl      # per-worker structured logs
  worktrees/<runId>/00/   # git worktree for task execution
```

The `<repo>` segment is derived from `git rev-parse --git-common-dir`, so worktrees of the same repo share state. Override with `$GLORIOUS_PILOT_DIR`.

> **v0.1 limitation:** single worker only. `--workers >1` clamps to 1. Multi-worker parallel scheduling is deferred to v0.3+.

---

## Maintenance

### Update

```bash
# Global CLI
bun update -g @glrs-dev/harness-opencode

# Or if using floating semver in opencode.json, OpenCode's internal bun install handles it on startup.
```

### Pin to a specific version

```bash
glrs-oc install-plugin --pin
```

Injects `"@glrs-dev/harness-opencode@<current-version>"` into your plugin array.

### Rollback a broken release

```bash
npm deprecate @glrs-dev/harness-opencode@<broken> "<reason>"
```

Then ship a patch. Users on floating semver auto-recover on next `bun update`.

### Uninstall

```bash
# Remove plugin from opencode.json
glrs-oc uninstall

# Remove the global CLI
bun remove -g @glrs-dev/harness-opencode
```

## Migrating from the old clone+symlink install

If you were using the previous `install.sh`-based harness, see [docs/migration-from-clone-install.md](docs/migration-from-clone-install.md).

## Privacy

The plugin checks `registry.npmjs.org` once per day for newer versions. No analytics, no telemetry, no identifiers beyond what `fetch()` sends. Opt out: `export HARNESS_OPENCODE_UPDATE_CHECK=0`.

## Prerequisites

- [OpenCode](https://opencode.ai)
- `bun` (for plugin installation and CLI)
- `uvx` (for serena + git MCPs — `brew install uv`)
- `node`/`npx` (for memory MCP)
- `git` >= 2.5 (for pilot worktrees)

## Contributing

Pull requests welcome. Read [`AGENTS.md`](./AGENTS.md) for plugin architecture, type-surface escape hatches, and the zero-user-filesystem-writes invariant.

All user-visible PRs require a changeset: `bunx changeset` before opening the PR. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT
