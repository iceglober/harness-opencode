---
"@glrs-dev/harness-opencode": minor
---

Pilot UX overhaul: interactive plan picker, positional path resolution, and streaming progress.

- **`pilot build` plan selection** now accepts a positional arg that resolves smartly: absolute path, cwd-relative, plans-dir-relative (with or without `.yaml`/`.yml` suffix). When no arg is given and stdin is a TTY, an `@inquirer/prompts` `select()` picker lists plans from the plans dir sorted by mtime (newest first), labelled with filename + plan name + relative time. `--plan <path>` still works for scripts. Non-TTY with no args falls back to "newest in plans dir" (unchanged v0.1 behavior).
- **Streaming per-task progress** on stderr during `pilot build`. Lines like `[HH:MM:SS] task.started T1`, `task.verify.passed T1`, `task.succeeded T1 in 42s`, `run.progress 2/7 succeeded`. Suppressed by `--quiet`. Chatty kinds (`task.session.created`, `task.attempt`) stay in the DB; `pilot logs --run` surfaces them. stdout stays clean for the final summary.
- **Task-level `context:` field** on `pilot.yaml` tasks — optional rich markdown block rendered into the builder's kickoff as a `## Context` section between verify and the task directive. Planner skill gets a new rule (`rules/task-context.md`) and pilot-planner.md tells the planner to populate it for non-trivial tasks. Cover outcome, rationale, code pointers, acceptance shorthand.
- Exit code change: missing plan via `--plan <path>` now exits 2 (resolution surface) instead of 1 (generic error). Consistent with schema-invalid plans.
