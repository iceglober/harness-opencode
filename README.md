# @glrs-dev/harness-opencode

An opinionated OpenCode agent harness — orchestrator, plan, build, QA, skills, MCP wiring, hashline editing. Delivered as a single npm plugin.

## What is it?

`@glrs-dev/harness-opencode` is an OpenCode plugin that registers agents, slash commands, custom tools, MCP servers, and skills at runtime via the OpenCode plugin `config` hook. Zero files are written to your `~/.config/opencode/` directory (except a single plugin-array entry in `opencode.json`).

**Phase A (current):** OpenCode-only. Claude Code support is Phase B.

## What you get

- **Primary agents** — `orchestrator` (five-phase end-to-end), `plan` (interactive planner), `build` (plan executor)
- **Pilot agents** — `pilot-builder` (unattended task executor, mid tier), `pilot-planner` (decomposes tickets into a `pilot.yaml` DAG, deep tier)
- **Subagents** — `gap-analyzer`, `plan-reviewer`, `qa-reviewer`, `code-searcher`, `lib-reader`, `architecture-advisor`, `docs-maintainer`, `agents-md-writer`
- **Slash commands** — `/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`, `/fresh`, `/costs`
- **Generic skills** — `review-plan`, `web-design-guidelines`, `vercel-react-best-practices`, `vercel-composition-patterns`
- **Pilot skills** — `pilot-planning` (7-rule decomposition framework for YAML plan authoring)
- **OpenCode tools** — `ast_grep`, `tsc_check`, `eslint_check`, `todo_scan`, `comment_check`
- **Bundled sub-plugins** — `notify` (OS notifications for question tool), `autopilot` (opt-in completion-tag loop driver with skeptical verifier gate — only activates on explicit `/autopilot` invocation, never on normal orchestrator sessions), `cost-tracker` (running LLM spend by provider/model at `~/.glorious/opencode/costs.json`; view with `/costs`; disable with `GLORIOUS_COST_TRACKER=0`, override path with `GLORIOUS_COST_TRACKER_DIR`), `pilot-plugin` (runtime invariant enforcement for pilot builder/planner agents)
- **Pilot CLI** — `bunx @glrs-dev/harness-opencode pilot <verb>` with verbs: `validate`, `plan`, `build`, `status`, `resume`, `retry`, `logs`, `worktrees`, `cost`, `plan-dir`
- **MCP server wiring** — `serena` (AST code intel), `memory` (per-repo JSON memory, worktree-shared), `git` (structured blame/log). `playwright` and `linear` defined but disabled — flip a flag to enable.
- **Hashline edit system** — line-reference prefixes that validate content hashes before every edit. Requires `opencode-hashline` (separate plugin, auto-preserved by our installer).

## Install

```bash
bunx @glrs-dev/harness-opencode install
```

This adds `"@glrs-dev/harness-opencode"` to your `~/.config/opencode/opencode.json` `plugin` array non-destructively. Your existing plugins and settings are preserved. A `.bak.<epoch>-<pid>` backup is written before any mutation.

Or add it manually:

```json
{
  "plugin": ["@glrs-dev/harness-opencode"]
}
```

## Update

```bash
bun update @glrs-dev/harness-opencode
```

Or if you're using floating semver in your `opencode.json`, OpenCode's internal `bun install` step handles it on startup.

## Customize

**Agents, commands, MCPs:** user's `opencode.json` overrides take precedence over plugin-injected defaults. To override the orchestrator model:

```json
{
  "agent": {
    "orchestrator": {
      "model": "anthropic/claude-sonnet-4-6"
    }
  }
}
```

**Skills:** skills are read-only by design (they live in `node_modules`, owned by npm). To customize a skill, fork this package, modify the skill, publish your fork, and swap the plugin entry.

## Pilot subsystem

The pilot subsystem runs a `pilot.yaml` task DAG against a real OpenCode server, fully unattended. You define tasks with dependencies, touch-globs, and verify commands; the pilot worker executes them in topological order using isolated git worktrees.

### Quick start

```bash
# 1. Create a plan interactively (spawns OpenCode TUI with the pilot-planner agent)
bunx @glrs-dev/harness-opencode pilot plan

# 2. Validate the plan (schema, DAG cycles, glob conflicts)
bunx @glrs-dev/harness-opencode pilot validate pilot.yaml

# 3. Run the plan
bunx @glrs-dev/harness-opencode pilot build pilot.yaml

# 4. Check progress
bunx @glrs-dev/harness-opencode pilot status
```

### CLI verbs

| Verb | Description |
|------|-------------|
| `validate` | Validate a `pilot.yaml` against schema, DAG, and glob rules |
| `plan` | Spawn the OpenCode TUI with the `pilot-planner` agent |
| `build` | Run the pilot worker against a plan |
| `status` | Print the current run's task statuses |
| `resume` | Continue a partially-completed run |
| `retry` | Reset a single task and re-run |
| `logs` | Print events / verify outputs for a task |
| `worktrees` | List / prune managed worktrees |
| `cost` | Print per-task and total cost for a run |
| `plan-dir` | Print the resolved plan directory path |

Persistent state (SQLite DB, git worktrees, JSONL logs, YAML plans) lives under `~/.glorious/opencode/<repo>/pilot/`.

> **v0.1 limitation:** single-worker only. `--workers >1` clamps to 1. Multi-worker pool, conflict-aware parallel scheduling, and cost-cap preemption are deferred to v0.3+.

## Rollback

To pin to a specific version:

```bash
bunx @glrs-dev/harness-opencode install --pin
```

This injects `"@glrs-dev/harness-opencode@<current-version>"` into your plugin array. OpenCode's plugin loader accepts `name@version` and `name@^semver` specifiers.

For a broken release: `npm deprecate @glrs-dev/harness-opencode@<broken> "<reason>"` + patch publish. Users on floating semver auto-recover on next `bun update`.

## Uninstall

```bash
bunx @glrs-dev/harness-opencode uninstall
```

Removes the plugin entry from `opencode.json`. Skills live in `node_modules` — removed by `bun remove @glrs-dev/harness-opencode`.

## Migrating from the old clone+symlink install

If you were using the previous `install.sh`-based harness (the `~/.glorious/opencode/` clone), see [docs/migration-from-clone-install.md](docs/migration-from-clone-install.md).

## Privacy

The plugin checks `registry.npmjs.org` once per day to see if a newer version is available. No analytics, no telemetry, no identifiers beyond what `fetch()` sends. Opt out: `export HARNESS_OPENCODE_UPDATE_CHECK=0`.

## Prerequisites

- OpenCode (install from https://opencode.ai)
- `bun` or `npm` (for plugin installation)
- `uvx` (for serena + git MCPs — `brew install uv`)
- `node`/`npx` (for memory MCP)

## Contributing

Pull requests welcome. Before submitting, read [`AGENTS.md`](./AGENTS.md) — it covers the plugin architecture, type-surface escape hatches, and the zero-user-filesystem-writes invariant.

## License

MIT
