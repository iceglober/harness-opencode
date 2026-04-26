# src/plugins — sub-plugins

OpenCode's plugin model allows multiple plugin objects. We ship one user-facing plugin (`src/index.ts`) and compose several sub-plugins here, each hooking into a specific lifecycle event.

## Current inventory

| File | Hook(s) | Purpose |
|---|---|---|
| `autopilot.ts` | `event` (session.idle) | Nudges PRIME to keep going in `/autopilot` mode until `## Acceptance criteria` checkboxes are all `[x]`. |
| `pilot-plugin.ts` | `tool.execute.before` | Enforces builder/planner invariants at runtime. Detects pilot sessions by title match (`pilot/<runId>/<taskID>`), then denies `git commit`/`push`/`tag`/`branch`/`checkout`/`switch`/`reset` for the builder, and denies edit/write/patch/multiedit outside the plans directory for the planner. Second fence behind the agents' permission maps. |
| `notify.ts` | `event` (question, idle) | Fires OS notifications so the user sees prompts when their terminal is off-screen. |
| `cost-tracker.ts` | `event` (session.*) | Tallies token usage per session + writes `costs.jsonl` / summary files for `pilot cost` / `/costs` consumption. |
| `dotenv.ts` | _none_ (module-init) | Parses `.env` / `.env.local` into `process.env` at plugin load so OpenCode's `{env:VAR}` MCP-config interpolation resolves. Shell env always wins. |
| `telemetry.ts` | `tool.execute.before`, `tool.execute.after`, `event` | Opt-in anonymous usage telemetry. No-op when `DISABLED` (set by `src/telemetry.ts` from env). |
| `tool-hooks.ts` | `tool.execute.after` | Post-edit verification loop: after a TS/JS edit, runs `tsc --noEmit` and surfaces NEW errors only. Also caps output for `eslint_check`/`tsc_check`/`comment_check`/`todo_scan`. |

## Convention

Each sub-plugin is a default-exported `Plugin` function (from `@opencode-ai/plugin`) that returns an object of hooks:

```ts
import type { Plugin } from "@opencode-ai/plugin";

const plugin: Plugin = async (ctx) => {
  return {
    event: async ({ event }) => { /* ... */ },
    "tool.execute.before": async ({ tool, agent, args }) => { /* ... */ },
  };
};

export default plugin;
```

The root `src/index.ts` re-exports these as an array (`plugin = [autopilot, notify, ...]`), which OpenCode composes internally.

## Adding a sub-plugin

1. Write `src/plugins/<name>.ts` with a default-exported `Plugin`.
2. Add it to the export array in `src/index.ts`.
3. Add a test in `test/<name>-plugin.test.ts` (pattern: import default, invoke with a fake ctx, assert hook behavior).
4. Verify `test/plugin-entry-single-default-export.test.ts` still passes — the root plugin entry must have exactly one default export.
5. Verify `test/plugin-hooks-no-undefined.test.ts` still passes — no hook key may resolve to `undefined` at runtime.

## Gotchas

- **Throwing from `tool.execute.before` is the documented "deny this tool execution" signal.** See `autopilot.ts` and `pilot-plugin.ts` for patterns. Swallow unrelated errors; rethrow the denial.
- **`telemetry.ts` must be a silent no-op when disabled.** Check `DISABLED` from `src/telemetry.ts` early and return `{}`.
- **Per-session state lives in closure or in SQLite, not in module-scope variables.** Plugins get re-instantiated per session; module-scope state leaks across.
- **Don't import from `src/pilot/*` here unless you're `pilot-plugin.ts`.** Other sub-plugins should stay subsystem-agnostic.
