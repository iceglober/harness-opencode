---
"@glrs-dev/harness-opencode": minor
---

Add the pilot subsystem (v0.1+v0.2) — autonomous task execution from a YAML plan.

**New CLI surface**: `bunx @glrs-dev/harness-opencode pilot <verb>` with verbs `validate`, `plan`, `build`, `status`, `resume`, `retry`, `logs`, `worktrees`, `cost`, and `plan-dir`. Migrated the entire CLI to `cmd-ts` for declarative argument parsing and auto-generated `--help`.

**Two new agents** registered via `createAgents()`:

- **`pilot-builder`** (mid tier, `claude-sonnet-4-6`): unattended task executor. Runs one task at a time inside a per-task git worktree. Permission map denies `git commit/push/tag/branch/checkout/switch/restore/reset` and `gh pr/release` so the worker — not the agent — owns commits. Also denies the `question` tool (unattended invariant). Uses the STOP protocol when blocked.

- **`pilot-planner`** (deep tier, `claude-opus-4-7`): interactive planner. Decomposes a Linear ticket / GitHub issue / free-form description into a `pilot.yaml` task DAG. Edits restricted to the pilot plans directory by both the agent's permission map and the new `pilot-plugin` runtime hook (belt-and-suspenders).

**One new skill** (`src/skills/pilot-planning/`): SKILL.md + 7 rules covering first-principles task framing, decomposition, verify-command design, touches-scope tightness, DAG shape, milestone grouping, and self-review.

**One new sub-plugin** (`src/plugins/pilot-plugin.ts`): hooks `tool.execute.before` to enforce builder/planner invariants at runtime. Classifies sessions by title prefix (`pilot/<runId>/<taskId>`) and working directory; non-pilot sessions pass through unchanged.

**Persistent state** lives under `~/.glorious/opencode/<repo>/pilot/` (NOT in `~/.config/opencode/`) — SQLite state DB, git worktrees, JSONL worker logs, YAML plan artifacts. Per-repo derivation matches `src/plan-paths.ts`.

**Doctor** (`bunx @glrs-dev/harness-opencode doctor`) now reports git/bash availability and pilot agent registration status.

**Tested**: 740+ tests, all green. Pre-implementation spikes documented under `docs/pilot/spikes/`.

**Known limitations** (deferred to v0.3+):
- Single-worker only (`--workers >1` clamps to 1 with a warning).
- No PR creation (pilot stops at committed branches; use `/ship` separately).
- No cost-cap preemption (cost is reporting-only).
- No Slack notifications, no Ink TUI for `pilot status --watch`.
