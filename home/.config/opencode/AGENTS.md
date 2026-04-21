# GLOBAL AGENT CONFIG

This file is read by every OpenCode / Claude Code session that runs with `glorious-opencode` installed. Per-repo `AGENTS.md` files override or extend these conventions.

## When to use ast_grep vs grep

Use `ast_grep` when the search is structural:
- "find all React components that use `useEffect` with no dependency array"
- "find all functions that take a callback as the last argument"
- "find all `as any` casts in our type assertions"

Use `grep` when the search is textual:
- "find all references to `API_KEY`"
- "find all TODO comments"
- "find this exact string"

For refactors: always run `ast_grep` with `dryRun: true` first, review the matches, then re-run with `dryRun: false`.

Example patterns:
- `console.log($MSG)` — find all `console.log` calls, capturing the argument
- `useEffect($BODY)` — find `useEffect` calls with no dependency array (1 arg)
- `useEffect($BODY, $DEPS)` — find `useEffect` with deps (2 args)
- `as any` — find unsafe type casts
- `function $NAME($$$ARGS) { $$$BODY }` — match all function declarations

## MCP server usage guidance

Three local-only MCP servers ship enabled by default:

- `serena` — AST-aware code intelligence via tree-sitter + LSP
- `memory` — per-engineer JSON store across sessions. A launcher (`~/.config/opencode/bin/memory-mcp-launcher.sh`) sets `MEMORY_FILE_PATH` to `<repo-toplevel>/.agent/memory.json`, shared across worktrees of the same repo, with a narrow `memory.json` entry auto-added to `.agent/.gitignore` on first use. Outside a git repo it falls back to `~/.config/opencode/memory/fallback.json`. Set `MEMORY_MCP_LAUNCHER_DEBUG=1` to log the resolved path to stderr.
- `git` — structured blame/log/bisect

Two more are defined but disabled; enable in your project's `opencode.json` if you want them:

- `playwright` — browser automation (enable for UI/e2e work)
- `linear` — remote MCP at `mcp.linear.app` (enable if you use Linear)

### When to prefer which

| Query | Tool |
|---|---|
| "Where is function X defined?" | `serena_find_symbol` |
| "What's in this file?" | `serena_get_symbols_overview` |
| "Who calls X?" | `serena_find_referencing_symbols` |
| "What's the blame on this line?" | `git` MCP |
| "What did I learn about this repo last session?" | `memory` |
| "Find all TODO comments" | `grep` (textual, not structural) |
| "Is `createUser` still exported from `src/auth`?" | `serena_get_symbols_overview` (not `grep "^export"`) |

**Rule of thumb:** prefer `serena` over `grep`/`ast_grep` for symbol resolution on TypeScript/Python code — tree-sitter + LSP is more precise. Use `memory` to accumulate repo-specific learnings ("prefer X pattern over Y here"). Use `git` MCP when history/blame matters for a decision, not for ordinary read-only queries (plain `git log`/`git blame` via bash is cheaper).

## Tool parity: Claude Code vs OpenCode

Several tools referenced in agent prompts are OpenCode-native. Claude Code users won't have them. Agents should fall back gracefully without asking the user.

| Agent prompt references | OpenCode tool | Claude Code fallback |
|---|---|---|
| `serena_find_symbol`, `serena_get_symbols_overview`, `serena_find_referencing_symbols` | Serena MCP | `grep` / `read` + manual symbol inspection |
| `ast_grep` | Custom tool at `~/.config/opencode/tools/ast_grep.ts` | `grep` with regex (less precise on structural queries) |
| `tsc_check` | Custom tool wrapping `tsc --noEmit` | `npm run typecheck` / `pnpm typecheck` via bash |
| `eslint_check` | Custom tool wrapping `eslint --format json` | `npm run lint` / `pnpm lint` via bash |
| `todo_scan`, `comment_check` | Custom tools wrapping `rg` | `grep` / `rg` directly |
| `memory_*` | `@modelcontextprotocol/server-memory` | Claude Code has `auto memory` at `~/.claude/projects/.../memory/` |
| `question` tool | OpenCode native | `AskUserQuestion` tool in Claude Code |

The slash commands (`/ship`, `/autopilot`, `/review`, `/init-deep`, `/research`) work in either tool. Primary agents (`orchestrator`, `plan`, `build`) are OpenCode-specific modes — switch between them with Tab in OpenCode. Claude Code users can delegate to these agents via the Task tool (they're regular subagents in `~/.claude/agents/`).

**Agents: if you reference a tool that isn't available in your runtime, fall back to the Claude Code equivalent above without asking the user. Don't block on a missing tool.**

## Skill-paired specialist agents (pattern)

OpenCode doesn't support "skill brings its own MCP" natively — MCP config is static per-server. The pragmatic equivalent is **skill-paired specialist agents**:

1. A `~/.claude/skills/<skill-name>/SKILL.md` captures domain knowledge + when to invoke
2. A `~/.claude/agents/<specialist>.md` subagent loads that skill and has the MCP/tool permissions it needs
3. Generalist agents (orchestrator, build) delegate to `@<specialist>` when the skill's domain comes up

Example: a `ui-testing` skill holds Playwright conventions and gets paired with a `@ui-test-runner` subagent that has `playwright: allow` in its permission block. Other agents don't see Playwright tools — only the specialist does. Context savings are real without the plugin-complexity tax.

When adding a new MCP server that's only needed for narrow work, prefer spinning up a specialist agent that has it scoped rather than granting it to every generalist.

## Agent autonomy: workflow-mechanics decisions

Users install this harness so agents handle *mechanics* on their behalf. Branch placement, worktree isolation, ticket-to-branch mapping, stacked-PR routing, base-branch choice — the agent decides, announces in one line of chat, and continues. **Never put a workflow-mechanics menu in front of the user.**

Canonical source of the rule (heuristic, edge cases, abort conditions): `~/.claude/agents/orchestrator.md` → "Workflow-mechanics decisions". The plan, build, and autopilot agents point back to that same section so the rule lives in one place.

Quick summary:

- **Trivial request** (< 20 lines, 1 file, no behavior change) → stay on current branch, always. A typo fix on `main` stays on `main`.
- **Substantial on default branch** → auto-invoke `/fresh` if `gsag` is installed; else create a branch locally. Announce which.
- **Substantial on a clean feature branch, unrelated work** → switch to a new branch from the default. Announce.
- **Dirty tree on the branch you'd need to leave** → abort with a one-sentence reason. User commits/stashes and re-runs. Never auto-stash.
- **Substantial on a matching feature branch** → stay. No announcement.

Announcement format: plain chat, prefixed `→ Workflow:`. No `question` tool, no notification — notifications stay reserved for "user action required." Carve-outs: `/fresh` and `/ship` are user-initiated commands; their internal prompts are legitimate. This rule governs *agent-initiated* decisions only.

Rationale: every second the user spends tabbing back to approve "which branch?" is a second stolen from the reason they ran autopilot. The question tool is for decisions only a human can make; branch placement isn't one of them.

## Autopilot activation

The `autopilot.ts` plugin is **opt-in**. It stays dormant on every normal orchestrator or build session and only enables its nudge-processing when one of these activation signals is detected:

1. **Explicit `/autopilot` invocation.** The slash-command text appears in a user message as `/autopilot`, and `home/.claude/commands/autopilot.md` also emits the literal phrase `AUTOPILOT mode` into the orchestrator's prompt. The plugin scans for either marker in any user message.
2. **Fresh-handoff transition.** A freshly-written `.agent/fresh-handoff.md` (mtime advanced, iterations still 0) implies autopilot — `/plan-loop` is the only writer of that file and exists to hand off to autopilot runs.

If neither signal is present, the plugin observes `session.idle` and `chat.message` events and does nothing. A plain orchestrator session with a plan full of unchecked acceptance criteria will never receive an `[autopilot]` nudge — nudges require explicit activation.

Once activated, the `enabled` flag on the session's state is sticky: user messages reset the iteration counter (the user's input always wins over in-flight verification state), but they do not disable autopilot. The only exits are max-iteration cap, successful completion, or ending the session. All nudges are debounced (30s) to prevent duplicate fires under rapid idle events.

## Autopilot completion protocol

When running under `/autopilot`, the orchestrator signals Phase-4 completion by emitting the literal ASCII token `<promise>DONE</promise>` on its own line. The `autopilot.ts` plugin detects that tag and injects a continuation prompt asking the orchestrator to delegate to the `@autopilot-verifier` subagent. The verifier returns exactly one of two sentinel tokens on its own line at the start of its response: `[AUTOPILOT_VERIFIED]` (proceed to Phase 5 handoff) or `[AUTOPILOT_UNVERIFIED]` followed by numbered reasons (orchestrator addresses each literally and re-emits `<promise>DONE</promise>`). The contract is "treat the verifier's verdict as ground truth; do not argue" — if the verifier rejects, fix the work, do not rebut. Sentinels are case-sensitive and must appear as the first non-whitespace content on their line; the plugin scans for them only after the DONE-promise message to avoid user-quoted-transcript false positives. The human gate remains `/ship` — the verifier's `[AUTOPILOT_VERIFIED]` unlocks the Phase-5 handoff message, not an auto-ship.

## Hashline reference

See `~/.claude/docs/hashline.md` for the full line-reference / edit-protocol spec (`#HL <line>:<hash>`, `hashline_edit` tool, file-revision guards, safe-reapply, error codes). The spec is also auto-injected by the OpenCode runtime as a `<system-reminder>` on edit turns, so you'll typically have it in context regardless.

## JSON tool calls

When making function calls using tools that accept array or object parameters, structure them as JSON:

```
example_complex_tool([
  {"color": "orange", "options": {"option_key_1": true, "option_key_2": "value"}},
  {"color": "purple", "options": {"option_key_1": true, "option_key_2": "value"}}
])
```
