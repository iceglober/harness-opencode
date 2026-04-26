# glorious-opencode — repo context for agents working on this repo

You are editing the **@glrs-dev/harness-opencode** npm plugin — an OpenCode agent harness delivered as a single npm package. This is meta-work: changes here propagate to every user on their next `bun update`.

## What this repo is

An npm-published OpenCode plugin. Not a bash installer. Not a git-clone-into-$HOME harness.

```
glorious-opencode/
├── src/
│   ├── index.ts              # Plugin entry — config hook, tools, events
│   ├── cli.ts                # CLI entry (cmd-ts: harness-opencode <subcommand>)
│   ├── agents/               # Agent definitions + prompts
│   │   ├── index.ts          # createAgents() — returns Record<string, AgentConfig>
│   │   ├── prompts/*.md      # Agent prompt files (read at runtime via readFileSync)
│   │   └── shared/           # Shared content (workflow-mechanics rule)
│   ├── commands/             # Slash command definitions + prompts
│   ├── skills/               # Bundled skill directories (copied to dist/skills/)
│   ├── tools/                # Custom tool implementations
│   ├── plugins/              # Sub-plugins (autopilot, notify, cost-tracker, pilot-plugin)
│   ├── mcp/                  # MCP server configuration
│   ├── bin/                  # Shell scripts (memory-mcp-launcher.sh, plan-check.sh)
│   ├── cli/                  # Top-level CLI subcommands (install, uninstall, doctor, merge-config)
│   └── pilot/                # Pilot subsystem (autonomous task execution)
│       ├── plan/             # pilot.yaml schema + loader + DAG + globs + slug
│       ├── state/            # SQLite state (runs/tasks/events) + accessors
│       ├── worktree/         # git wrappers + worktree pool
│       ├── opencode/         # opencode server lifecycle + EventBus + prompts
│       ├── verify/           # verify-runner + touches enforcement
│       ├── worker/           # main worker loop + STOP detection
│       ├── scheduler/        # ready-set / cascade-fail
│       ├── cli/              # `pilot <verb>` cmd-ts subcommands
│       └── paths.ts          # ~/.glorious/opencode/<repo>/pilot/* path resolution
├── test/                     # bun:test test files
├── docs/                     # Architecture docs and spike notes
│   └── pilot/spikes/         # Phase-0 de-risking notes (S1-S6)
├── dist/                     # Build output (gitignored)
├── PILOT_TODO.md             # Pilot subsystem ship checklist
├── package.json              # npm package metadata
├── tsconfig.json             # TypeScript config
└── tsup.config.ts            # Build config (tsup)
```

## Rules when editing this repo

1. **Zero user-filesystem-writes invariant.** The plugin MUST NOT write to `~/.config/opencode/agents/`, `~/.config/opencode/commands/`, `~/.config/opencode/skills/`, `~/.config/opencode/tools/`, or `~/.claude/`. The only permitted filesystem mutations are: (a) the CLI's `install` subcommand writing to `~/.config/opencode/opencode.json` (plugin-array entry, non-destructive merge), and (b) the pilot subsystem writing under `~/.glorious/opencode/<repo>/pilot/` (state DB, worktrees, logs, plans). Skills live in `node_modules` (read-only by design).

2. **Type-surface escape hatches are permitted where the SDK is narrower than the runtime.** Known gaps: `permission.external_directory` path-keyed maps; per-tool-name permission keys in `AgentConfig` (`ast_grep`, `tsc_check`, etc.); `skills.paths` (v2 SDK type, may not be in v1). Use `as unknown as Config` / narrow module augmentation. Document each escape hatch in `docs/plugin-architecture.md`.

3. **No postinstall side-effects.** `bun add @glrs-dev/harness-opencode` MUST NOT touch `~/.config/opencode/`. All filesystem mutation happens only via `bunx @glrs-dev/harness-opencode install`.

4. **Merge policy for opencode.json (CLI install subcommand).** The installer adds missing keys from our shipped defaults, preserves all user values verbatim, and writes a `.bak.<epoch>-<pid>` sibling before every mutation. It never overwrites a key the user has set, and never deletes keys. Arrays are treated as leaves (user's array wins) except the top-level `plugin` array, which is unioned-by-value so our plugin name lands even when a user has a custom plugin list. Scalar-vs-object collisions preserve the user's scalar and emit a WARN. The merge logic lives at `src/cli/merge-config.ts` and is codified by the fixture suite at `test/fixtures/merge-config/`; `bun test test/merge-config.test.ts` runs the tests.

5. **Skills precedence is plugin-wins.** OpenCode's skill scanner processes hardcoded paths (`~/.config/opencode/skills/`, `.opencode/skills/`, etc.) FIRST, then `config.skills.paths` entries LAST, and the LAST-SEEN location wins on name collision. Plugin-pushed `skills.paths` entries therefore shadow user-dropped hardcoded-path overrides. This is intentional: skills are read-only by design. Users who need to customize a skill fork the package.

6. **Agents/commands/MCPs use user-wins precedence.** `input.agent = { ...ourAgents, ...(input.agent ?? {}) }` — user's opencode.json overrides take effect. Same for commands and MCPs.

7. **Prompt files are read at runtime via `readFileSync`.** Do NOT use static `import` for `.md` files — bun's markdown handling converts them to HTML. Use the `readPrompt()` helper pattern in `src/agents/index.ts`.

8. **No dangling path references in prompts.** Every file under `src/agents/prompts/`, `src/commands/prompts/`, and `src/skills/**/*.md` must not contain `~/.claude`, `home/.claude`, `~/.config/opencode`, or `home/.config/opencode`. CI enforces this via `test/prompts-no-dangling-paths.test.ts`.

9. **Rollback recipe for maintainers.** For a broken release: `npm deprecate @glrs-dev/harness-opencode@<broken> "<reason>; use <fix>"`, then ship the fix via the normal flow — `bunx changeset` (pick `patch`, describe the fix), merge, then merge the auto-opened "Version Packages" PR. Users on floating semver auto-recover on next `bun update`.

10. **Pilot subsystem registers via the standard surfaces.** `pilot-builder` and `pilot-planner` agents register through `createAgents()` like every other agent. The `pilot-planning` skill ships in `src/skills/` and bundles to `dist/skills/` like every other skill. The CLI subcommands wire into the top-level cmd-ts tree under the `pilot` key. The `pilot-plugin.ts` is a sub-plugin that hooks `tool.execute.before` to enforce builder/planner invariants at runtime (alongside the agents' permission maps). The pilot subsystem's PERSISTENT state — SQLite DB, git worktrees, JSONL logs, YAML plans — lives under `~/.glorious/opencode/<repo>/pilot/`, NOT under `~/.config/opencode/`. Per-repo derivation mirrors `src/plan-paths.ts`'s `getRepoFolder` (the `git rev-parse --git-common-dir` strategy).

## When adding a new agent

1. Add the prompt markdown to `src/agents/prompts/<name>.md` with YAML frontmatter (`name`, `description`, `mode`, `model`).
2. Add a `readPrompt("<name>.md")` call and an entry in `createAgents()` in `src/agents/index.ts`.
3. Add a test case in `test/agents.test.ts`.
4. Run `bun run build && bun run typecheck && bun test`.

## When adding a new skill

1. Create `src/skills/<name>/SKILL.md` with required frontmatter (`name` matching dirname, `description`).
2. The build's `onSuccess` step copies `src/skills/` to `dist/skills/` automatically.
3. Add a file-count assertion in `test/skills-bundle.test.ts`.
4. Run `bun run build && bun test test/skills-bundle.test.ts`.

## When adding a new slash command

1. Add the prompt markdown to `src/commands/prompts/<name>.md`.
2. Add a `readPrompt("<name>.md")` call and an entry in `createCommands()` in `src/commands/index.ts`.
3. Run `bun run build && bun run typecheck`.

## Testing changes

```bash
bun run build          # Build dist/
bun run typecheck      # TypeScript type check
bun test               # Run all tests
npm publish --dry-run  # Verify tarball contents
```

## Releasing

Releases are automated via [Changesets](https://github.com/changesets/changesets). Do not run `npm publish` manually.

- Every user-visible PR must include a changeset (`bunx changeset` → pick bump level → describe).
- On merge to `main`, `.github/workflows/release.yml` opens or updates a "Version Packages" PR that bumps `package.json`, rewrites `CHANGELOG.md`, and consumes the changeset files.
- Merging the Version Packages PR triggers `changeset publish`, which runs `npm publish` with provenance and pushes the `@glrs-dev/harness-opencode@<version>` tag.
- The `npm-publish` GitHub environment gates every publish with maintainer approval.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full contributor flow and bump-level cheat sheet.

## Per-directory AGENTS.md

Drill into these for the details of a specific surface:

- `src/agents/AGENTS.md` — agent prompt/permission/tier convention
- `src/commands/AGENTS.md` — slash-command prompt convention
- `src/skills/AGENTS.md` — skill-dir convention and the vercel-*/AGENTS.md landmine
- `src/pilot/AGENTS.md` — pilot subsystem (state, worker, worktree pool, CLI, per-repo paths)
- `src/plugins/AGENTS.md` — sub-plugin pattern and current inventory

## Philosophy

This is meant to feel inevitable, not clever. If you're tempted to add a "cool" feature, ask: does it reduce the friction of getting a fresh engineer running the five-phase workflow? If no, leave it out. The value is in the defaults being good and the install being boring.
