# src/pilot — unattended task execution subsystem

The pilot decomposes a feature into a `pilot.yaml` DAG (planner agent), then executes tasks from the DAG unattended (builder agent), coordinated by a worker loop that manages git worktrees, opencode sessions, and a SQLite state store.

The root AGENTS.md covers the high-level registration model (rule 10). This file is the drill-down.

## Layout

```
pilot/
├── paths.ts          # ~/.glorious/opencode/<repo>/pilot/* resolution (mirrors plan-paths.ts)
├── plan/             # pilot.yaml schema (zod), loader, DAG builder, globs, slug
│   ├── schema.ts     # PlanSchema, TaskSchema, MilestoneSchema, DefaultsSchema
│   ├── load.ts       # parsePlan()
│   ├── dag.ts        # topological sort + ready-set
│   ├── globs.ts      # picomatch-based touches-scope matching
│   └── slug.ts       # deterministic task-id slugs
├── state/            # SQLite: runs/tasks/events + migrations + accessors
├── worktree/         # git worktree pool (git.ts + pool.ts)
├── opencode/         # opencode server lifecycle, SSE EventBus, builder prompts
├── verify/           # verify-runner (runs verify-command + enforces touches scope)
├── worker/           # worker.ts (main loop) + stop-detect.ts (STOP protocol)
├── scheduler/        # ready-set.ts (which tasks are ready to claim)
└── cli/              # `pilot <verb>` cmd-ts subcommands (see table below)
```

## Per-repo state layout (persistent, NOT under ~/.config/opencode)

```
~/.glorious/opencode/<repo>/pilot/
├── state.sqlite      # runs, tasks, events
├── runs/<run-id>/
│   ├── plan.yaml     # frozen copy of pilot.yaml for this run
│   └── tasks/<task-id>/
│       ├── session.jsonl    # opencode session events
│       ├── verify.log       # verify-runner output
│       └── status.json
└── worktrees/        # git worktrees managed by the pool
```

`<repo>` derives from `git rev-parse --git-common-dir` → per-repo key, same strategy as `src/plan-paths.ts`. Worktrees share the same pilot state.

## Invariants

1. **Builder never commits.** `src/plugins/pilot-plugin.ts` denies `git commit`/`push`/`tag`/`branch`/`checkout`/`switch`/`reset` for the builder session. The worker commits on its behalf after verify succeeds.
2. **Planner only edits plans.** Same plugin denies edit/write/patch/multiedit outside the plans directory for the planner session.
3. **Touches-scope enforced by verify-runner.** Every task declares globs it may modify; verify-runner rejects edits outside scope before advancing.
4. **State DB and worktrees are per-repo, not per-worktree.** Don't sprinkle state under individual worktree dirs.
5. **The plugin is the second fence.** Agent permission maps are the first; don't collapse them into one.

## CLI surface

`pilot` wires into the top-level cmd-ts tree in `src/cli.ts`.

| Verb | Purpose |
|---|---|
| `pilot plan` | Invoke pilot-planner → emit pilot.yaml |
| `pilot build` | Run the worker loop against a pilot.yaml |
| `pilot validate` | Lint a pilot.yaml without running it |
| `pilot status` | Inspect current run state |
| `pilot logs` | Tail task event log |
| `pilot resume` | Resume a run after human intervention |
| `pilot retry` | Retry a failed task |
| `pilot discover` | List known runs/tasks |
| `pilot worktrees` | Inspect worktree pool |
| `pilot cost` | Usage accounting |
| `pilot plan-dir` | Print the per-repo plan dir (used by the PRIME's bootstrap probe) |

## Adding a new verb

1. Add `src/pilot/cli/<verb>.ts` exporting a cmd-ts `command(...)`.
2. Register it in `src/pilot/cli/index.ts`'s `pilotSubcommand`.
3. Add a test in `test/pilot-cli-*.test.ts`.
4. State-touching verbs go through `src/pilot/state/` accessors, not inline SQL.

## Spikes

See `docs/pilot/spikes/` (S1-S6) for Phase-0 de-risking notes — opencode CLI flags, SDK session methods, SSE event shapes, session resumability, picomatch globs conflict, serve startup line. Read before touching `opencode/server.ts` or `opencode/events.ts`.

`PILOT_TODO.md` at the repo root tracks the v0.1+v0.2 combined-release ship checklist.
