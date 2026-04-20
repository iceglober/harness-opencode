# Claude Code fallbacks

Some of the agents in this harness reference OpenCode-native tools. When run under Claude Code, those tools don't exist — but agents should fall back to the equivalent command without asking the user.

This is the same table that lives in `~/.config/opencode/AGENTS.md`, reproduced here for reference.

| Agent prompt references | OpenCode tool | Claude Code fallback |
|---|---|---|
| `serena_find_symbol`, `serena_get_symbols_overview`, `serena_find_referencing_symbols` | Serena MCP | `grep` / `read` + manual symbol inspection |
| `ast_grep` | Custom tool at `~/.config/opencode/tools/ast_grep.ts` | `grep` with regex (less precise on structural queries) |
| `tsc_check` | Custom tool wrapping `tsc --noEmit` | `npm run typecheck` / `pnpm typecheck` via bash |
| `eslint_check` | Custom tool wrapping `eslint --format json` | `npm run lint` / `pnpm lint` via bash |
| `todo_scan`, `comment_check` | Custom tools wrapping `rg` | `grep` / `rg` directly |
| `memory_*` | `@modelcontextprotocol/server-memory` | Claude Code has `auto memory` at `~/.claude/projects/.../memory/` |
| `question` tool | OpenCode native | `AskUserQuestion` tool in Claude Code |

## Slash commands

All slash commands (`/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`) work in both tools — they're markdown files in `~/.claude/commands/` and both tools read that directory.

## Primary agents

`orchestrator`, `plan`, and `build` are OpenCode-specific "mode" abstractions (each has its own model, permissions, temperature). Switch between them with Tab in OpenCode.

Claude Code doesn't have agent modes in the same way, but the corresponding markdown files live at `~/.claude/agents/` and act as delegatable subagents via the Task tool (`@orchestrator`, `@plan`, `@build`). The `orchestrator` prompt is designed to drive a full session end-to-end, so for most Claude Code sessions you just describe what you want and let `@orchestrator` classify + dispatch.

No config change needed.
