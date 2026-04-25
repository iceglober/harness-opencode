# Plugin Architecture

## How registration works

`@glrs-dev/harness-opencode` is an OpenCode plugin. OpenCode loads it from `node_modules` at startup and calls the plugin's `config` hook before the first session message reaches the LLM.

The `config` hook receives the full `Config` object by reference and mutates it in place:

```ts
config: async (config) => {
  // Agents: user-wins (user's opencode.json overrides our defaults)
  config.agent = { ...ourAgents, ...(config.agent ?? {}) };

  // Commands: user-wins
  config.command = { ...ourCommands, ...(config.command ?? {}) };

  // MCPs: user-wins
  config.mcp = { ...ourMcp, ...(config.mcp ?? {}) };

  // Skills: push our bundled path first (plugin-wins on name collision)
  config.skills = {
    paths: [getSkillsRoot(), ...(config.skills?.paths ?? [])],
    urls: config.skills?.urls ?? [],
  };
}
```

## Precedence

| Content type | Precedence | Mechanism |
|---|---|---|
| Agents | **User wins** | `{ ...ourAgents, ...(input.agent ?? {}) }` — user's opencode.json overrides |
| Commands | **User wins** | Same pattern |
| MCPs | **User wins** | Same pattern |
| Skills | **Plugin wins** | `config.skills.paths` entries are scanned LAST by OpenCode's skill scanner; last-seen wins on name collision |

Skills are read-only by design. Users who need to customize a bundled skill should fork the package, modify the skill, publish their fork, and swap the plugin entry.

## Skills path resolution

Skills are bundled in `dist/skills/` alongside the plugin's `dist/index.js`. The path is resolved at runtime using `import.meta.url`:

```ts
export function getSkillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "skills");
}
```

This works because tsup emits ESM and `dist/index.js` lives alongside `dist/skills/`. No `createRequire` or `require.resolve` needed — verified empirically against OpenCode 1.14.19.

## Type-surface escape hatches

The `@opencode-ai/plugin` v1 SDK type for `Config` is narrower than the runtime zod schema. Known gaps:

- `permission.external_directory` — the type declares it as `"ask" | "allow" | "deny"` but the runtime accepts a path-keyed map `{ "~/.glorious/worktrees/**": "allow" }`.
- Per-tool-name permission keys in `AgentConfig` — `ast_grep: "allow"`, `tsc_check: "allow"`, etc. are not in the generated type but the runtime accepts them via the `[key: string]: unknown` index signature.
- `skills.paths` — present in v2 SDK types, may not be in v1.

All escape hatches use `as unknown as Config` or `(config as any)` at the call site. Each is documented here and in the source code.

## Update notification

The plugin checks `registry.npmjs.org/@glrs-dev/harness-opencode/latest` once per day (rate-limited via `~/.cache/glrs-dev/update-check.json`). If a newer version is available, it emits a TUI toast via `client.tui.showToast`.

Opt out: `export HARNESS_OPENCODE_UPDATE_CHECK=0`.

## Memory MCP path resolution

The `memory` MCP uses the bundled `dist/bin/memory-mcp-launcher.sh`. The launcher is resolved at MCP-spawn time (not plugin init) via a `node -e require.resolve(...)` snippet in the MCP command array. This preserves the per-worktree cwd-walking behavior of the original launcher.

## Prompt files

Agent and command prompts are read at runtime via `readFileSync` (not static imports). Bun's markdown handling converts `.md` imports to HTML, which breaks frontmatter parsing. The `readPrompt()` helper in `src/agents/index.ts` tries the bundled `dist/agents/prompts/` path first, then falls back to `src/agents/prompts/` for development.

## Permission resolution: why `bash` uses object-form allow-lists

**Core finding (v0.7.0):** agent-level scalar `bash: "allow"` does NOT win against OpenCode's upstream defaults. An upstream layer — suspected to be the built-in subagent mode's permission defaults — injects `{permission: "bash", pattern: "*", action: "ask"}` into the effective ruleset. Because `Permission.evaluate` in `packages/opencode/src/permission/index.ts` walks the merged ruleset top-to-bottom and the LAST matching rule wins, and because our scalar `bash: "allow"` expands to `{bash, *, allow}` (the same wildcard pattern as upstream's ask), the merge-position of the two rules determines the winner. The live log trace at `~/.local/share/opencode/log/2026-04-24T014426.log` lines 40292–40293 (ruleset) and 46605–46606 (evaluated rule) shows the upstream `{bash, *, ask}` landing AFTER our agent's scalar allow and winning.

**Why specific-pattern allows win.** `Permission.fromConfig` sorts top-level permission keys so wildcard-in-name entries (`"*": ...`) come first and specific-name entries (`"bash": ...`) come second. Within a single permission block (e.g. inside our agent's `bash:` object), the flattened rules end up in the order Object.entries emits them — specific patterns sort later than the `"*"` key because they have non-wildcard content. The upstream rule is a wildcard; our specific patterns like `"git merge-base *"` sort AFTER it in the merged ruleset and win via last-match-wins for the commands they cover.

**Consequence for maintainers.** Every agent that runs bash AND needs to silence ask-prompts MUST use an object-form `bash:` with enumerated specific-pattern allows. The shared constants live in `src/agents/index.ts`:

- `CORE_BASH_ALLOW_LIST` — ~50 non-destructive command patterns (`ls *`, `tail *`, `pnpm lint *`, `git merge-base *`, `bunx *`, etc.) that cover the reported pain points. Every entry is specific enough to beat the wildcard upstream.
- `CORE_DESTRUCTIVE_BASH_DENIES` — non-negotiable denies (`rm -rf /*`, `chmod *`, `sudo *`, `git push --force*` + explicit re-allow of `--force-with-lease`). Every bash-capable agent carries these.

Applied to: `prime`, `build`, `qa-reviewer`, `qa-thorough`. Deny-everything agents (`plan-reviewer`, `code-searcher`, `gap-analyzer`, `architecture-advisor`, `lib-reader`) keep `bash: "deny"` scalar — that shape DOES win because `deny` stops evaluation regardless of ordering. `agents-md-writer` keeps `bash: "ask"` scalar since explicit confirmation is the intent.

**Do NOT simplify back to scalar `allow` without reading the logs.** Two prior fixes (commits `c9a288d`, `3483448`) tried the scalar form and shipped regressions. If you're tempted to clean up the enumerated allow-list as "redundant" with `"*": "allow"`, STOP — run the `HARNESS_OPENCODE_PERM_DEBUG=1` probe to capture the live ruleset OpenCode sees, then convince yourself the specific patterns are actually redundant before removing them. They almost certainly aren't.

## Diagnostic probe: `HARNESS_OPENCODE_PERM_DEBUG=1`

When this env var equals `"1"`, the `config` hook writes a JSON snapshot of every agent's final permission block to `$XDG_STATE_HOME/harness-opencode/perm-debug.json` (or `~/.local/state/harness-opencode/perm-debug.json` as a fallback). Silent and zero-overhead when unset.

Payload shape:

```json
{
  "timestamp": "2026-04-24T...Z",
  "pluginVersion": "0.7.0",
  "agents": ["prime", "plan", "build", "qa-reviewer", ...],
  "agentPermissions": {
    "qa-reviewer": { "edit": "deny", "bash": { "*": "allow", "tail *": "allow", ... }, ... },
    ...
  },
  "globalPermission": { "external_directory": { "~/.glorious/worktrees/**": "allow", ... } }
}
```

Use it to verify that OpenCode is receiving the permission shape you expect. The previous two bash-prompt fix attempts shipped without this instrument and guessed wrong about the root cause twice. Any future permission-resolution mystery should start with turning the probe on and inspecting the snapshot.
