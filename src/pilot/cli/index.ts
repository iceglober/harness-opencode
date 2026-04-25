/**
 * Pilot subcommand tree (`bunx @glrs-dev/harness-opencode pilot ...`).
 *
 * Wired into the top-level CLI via `src/cli.ts`. Each `pilot <verb>`
 * lives in its own file and is composed here using `cmd-ts`'s
 * `subcommands` helper. The shape mirrors the top-level pattern: each
 * file exports a `command(...)` value; this index file glues them
 * together.
 *
 * Subcommands (Phase G of `PILOT_TODO.md`):
 *   - validate     Validate a pilot.yaml against schema, DAG, globs.
 *   - plan         Spawn the opencode TUI with the pilot-planner agent.
 *   - build        Run the pilot worker against a plan.
 *   - status       Print the current run's task statuses.
 *   - resume       Continue a partially-completed run.
 *   - retry        Reset a single task and re-run.
 *   - logs         Print events / verify outputs for a task.
 *   - worktrees    List / prune managed worktrees.
 *   - cost         Print per-task and total cost for a run.
 *
 * Every subcommand here is opinionated about its argv shape; this file
 * is wiring only.
 */

import { subcommands } from "cmd-ts";

import { validateCmd } from "./validate.js";
import { planCmd } from "./plan.js";
import { buildCmd } from "./build.js";
import { statusCmd } from "./status.js";
import { resumeCmd } from "./resume.js";
import { retryCmd } from "./retry.js";
import { logsCmd } from "./logs.js";
import { worktreesCmd } from "./worktrees.js";
import { costCmd } from "./cost.js";
import { planDirCmd } from "./plan-dir.js";

export const pilotSubcommand = subcommands({
  name: "pilot",
  description:
    "Pilot subsystem — plan, validate, build, and manage unattended task runs.",
  cmds: {
    validate: validateCmd,
    plan: planCmd,
    build: buildCmd,
    status: statusCmd,
    resume: resumeCmd,
    retry: retryCmd,
    logs: logsCmd,
    worktrees: worktreesCmd,
    cost: costCmd,
    "plan-dir": planDirCmd,
  },
});
