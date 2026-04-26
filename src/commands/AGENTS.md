# src/commands — slash command definitions + prompts

Slash commands (`/ship`, `/fresh`, `/autopilot`, `/review`, `/research`, `/init-deep`, `/costs`) live here.

## Layout

```
commands/
├── index.ts          # createCommands() — Record<string, CommandConfig>
└── prompts/          # One <name>.md per command
```

## Convention

Same pattern as `src/agents/`, simpler:

1. **`prompts/<name>.md`** — YAML frontmatter (`description`) + the template body. The body may reference `$ARGUMENTS` for pass-through args from the slash invocation.
2. **`createCommands()` entry** — reads the prompt via `readPrompt(...)` and registers under the command key.

## Adding a new slash command

1. Write `prompts/<name>.md`.
2. In `index.ts`: add `const <name>Prompt = readPrompt("<name>.md")` and a `<name>: { template: <name>Prompt }` entry in `createCommands()`.
3. `bun run build && bun run typecheck`.
4. If the command has a **fallback contract** (TUI dispatch miss → PRIME executes inline), note it in the prime.md "Slash-command fallback" section and add a test case to `test/prime-command-fallback.test.ts`.

## Gotchas

- Prompts are read at runtime (root rule 7 — no static `import` of `.md`).
- `test/prompts-no-dangling-paths.test.ts` enforces no refs to `~/.claude` or `~/.config/opencode` anywhere under `src/commands/prompts/`.
