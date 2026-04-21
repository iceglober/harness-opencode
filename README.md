# @glorious/harness-opencode

An opinionated OpenCode agent harness — orchestrator, plan, build, QA, skills, MCP wiring, hashline editing. Delivered as a single npm plugin.

## What is it?

`@glorious/harness-opencode` is an OpenCode plugin that registers agents, slash commands, custom tools, MCP servers, and skills at runtime via the OpenCode plugin `config` hook. Zero files are written to your `~/.config/opencode/` directory (except a single plugin-array entry in `opencode.json`).

**Phase A (current):** OpenCode-only. Claude Code support is Phase B.

## What you get

- **Primary agents** — `orchestrator` (five-phase end-to-end), `plan` (interactive planner), `build` (plan executor)
- **Subagents** — `gap-analyzer`, `plan-reviewer`, `qa-reviewer`, `autopilot-verifier`, `code-searcher`, `lib-reader`, `architecture-advisor`, `docs-maintainer`, `agents-md-writer`
- **Slash commands** — `/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`, `/fresh`, `/costs`
- **Generic skills** — `review-plan`, `web-design-guidelines`, `vercel-react-best-practices`, `vercel-composition-patterns`
- **OpenCode tools** — `ast_grep`, `tsc_check`, `eslint_check`, `todo_scan`, `comment_check`
- **Bundled sub-plugins** — `notify` (OS notifications for question tool), `autopilot` (opt-in completion-tag loop driver with skeptical verifier gate — only activates on explicit `/autopilot` invocation, never on normal orchestrator sessions), `cost-tracker` (running LLM spend by provider/model at `~/.glorious/opencode/costs.json`; view with `/costs`; disable with `GLORIOUS_COST_TRACKER=0`, override path with `GLORIOUS_COST_TRACKER_DIR`)
- **MCP server wiring** — `serena` (AST code intel), `memory` (per-repo JSON memory, worktree-shared), `git` (structured blame/log). `playwright` and `linear` defined but disabled — flip a flag to enable.
- **Hashline edit system** — line-reference prefixes that validate content hashes before every edit. Requires `opencode-hashline` (separate plugin, auto-preserved by our installer).

## Install

```bash
bunx @glorious/harness-opencode install
```

This adds `"@glorious/harness-opencode"` to your `~/.config/opencode/opencode.json` `plugin` array non-destructively. Your existing plugins and settings are preserved. A `.bak.<epoch>-<pid>` backup is written before any mutation.

Or add it manually:

```json
{
  "plugin": ["@glorious/harness-opencode"]
}
```

## Update

```bash
bun update @glorious/harness-opencode
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

## Rollback

To pin to a specific version:

```bash
bunx @glorious/harness-opencode install --pin
```

This injects `"@glorious/harness-opencode@<current-version>"` into your plugin array. OpenCode's plugin loader accepts `name@version` and `name@^semver` specifiers.

For a broken release: `npm deprecate @glorious/harness-opencode@<broken> "<reason>"` + patch publish. Users on floating semver auto-recover on next `bun update`.

## Uninstall

```bash
bunx @glorious/harness-opencode uninstall
```

Removes the plugin entry from `opencode.json`. Skills live in `node_modules` — removed by `bun remove @glorious/harness-opencode`.

## Migrating from the old clone+symlink install

If you were using the previous `install.sh`-based harness (the `~/.glorious/opencode/` clone), see [docs/migration-from-clone-install.md](docs/migration-from-clone-install.md).

## Privacy

The plugin checks `registry.npmjs.org` once per day to see if a newer version is available. No analytics, no telemetry, no identifiers beyond what `fetch()` sends. Opt out: `export GLORIOUS_HARNESS_UPDATE_CHECK=0`.

## Prerequisites

- OpenCode (install from https://opencode.ai)
- `bun` or `npm` (for plugin installation)
- `uvx` (for serena + git MCPs — `brew install uv`)
- `node`/`npx` (for memory MCP)

## Contributing

Pull requests welcome. Before submitting, read [`AGENTS.md`](./AGENTS.md) — it covers the plugin architecture, type-surface escape hatches, and the zero-user-filesystem-writes invariant.

## License

MIT
