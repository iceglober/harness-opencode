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
