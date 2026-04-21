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
- `memory` — per-engineer SQLite across sessions (file: `.agent/memory.json`, should be gitignored per-repo)
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

## Hashline — Line Reference System

File contents are annotated with hashline prefixes in the format `#HL <line>:<hash>|<content>`.
The hash length adapts to file size: 3 chars for files ≤4096 lines, 4 chars for larger files.

### Example (small file, 3-char hashes):
```
function hello() {
  return "world";
}
```

### Example (large file, 4-char hashes):
```
import { useState } from 'react';

export function App() {
```

### How to reference lines

You can reference specific lines using their hash tags (e.g., `2:f1c` or `2:f12c`). When editing files, you may include or omit the hash prefixes — they will be stripped automatically.

### Edit operations using hash references

**Preferred tool-based edit (hash-aware):**
- Use the `hashline_edit` tool with refs like `startRef: "2:f1c"` and optional `endRef`.
- This avoids fragile old_string matching because edits are resolved by hash references.

**Replace a single line:**
- "Replace line 2:f1c" — target a specific line unambiguously

**Replace a block of lines:**
- "Replace block from 1:a3f to 3:0e7" — replace a range of lines

**Insert content:**
- "Insert after 3:0e7" — insert new lines after a specific line
- "Insert before 1:a3f" — insert new lines before a specific line

**Delete lines:**
- "Delete lines from 2:f1c to 3:0e7" — remove a range of lines

### Hash verification rules

- **Always verify** that the hash reference matches the current line content before editing.
- If a hash doesn't match, the file may have changed since you last read it — re-read the file first.
- Hash references include both the line number AND the content hash, so `2:f1c` means "line 2 with hash f1c".
- If you see a mismatch, do NOT proceed with the edit — re-read the file to get fresh references.

### File revision (`#HL REV:<hash>`)

- When files are read, the first line may contain a file revision header: `#HL REV:<8-char-hex>`.
- This is a hash of the entire file content. Pass it as the `fileRev` parameter to `hashline_edit` to verify the file hasn't changed.
- If the file was modified between read and edit, the revision check fails with `FILE_REV_MISMATCH` — re-read the file.

### Safe reapply (`safeReapply`)

- Pass `safeReapply: true` to `hashline_edit` to enable automatic line relocation.
- If a line moved (e.g., due to insertions above), safe reapply finds it by content hash.
- If exactly one match is found, the edit proceeds at the new location.
- If multiple matches exist, the edit fails with `AMBIGUOUS_REAPPLY` — re-read the file.

### Structured error codes

- `HASH_MISMATCH` — line content changed since last read
- `FILE_REV_MISMATCH` — file was modified since last read
- `AMBIGUOUS_REAPPLY` — multiple candidate lines found during safe reapply
- `TARGET_OUT_OF_RANGE` — line number exceeds file length
- `INVALID_REF` — malformed hash reference
- `INVALID_RANGE` — start line is after end line
- `MISSING_REPLACEMENT` — replace/insert operation without replacement content

### Best practices

- Use hash references for all edit operations to ensure precision.
- When making multiple edits, work from bottom to top to avoid line number shifts.
- For large replacements, use range references (e.g., `1:a3f to 10:b2c`) instead of individual lines.
- Use `fileRev` to guard against stale edits on critical files.
- Use `safeReapply: true` when editing files that may have shifted due to earlier edits.

## JSON tool calls

When making function calls using tools that accept array or object parameters, structure them as JSON:

```
example_complex_tool([
  {"color": "orange", "options": {"option_key_1": true, "option_key_2": "value"}},
  {"color": "purple", "options": {"option_key_1": true, "option_key_2": "value"}}
])
```
