/**
 * `pilot cost [--run <id>] [--json]` — print per-task and total cost.
 *
 * Reads `tasks.cost_usd` for each task in the run and emits:
 *
 *     T1  succeeded  $0.42
 *     T2  failed     $1.10
 *     T3  pending    $0.00
 *     ---
 *     total          $1.52
 *
 * `--json` emits `{ runId, total, tasks: [{ id, status, costUsd }] }`.
 *
 * Cost values come from the worker's `pollCost` updates, which are
 * best-effort. v0.1 is reporting-only — no cost-cap preemption.
 */

import { command, flag, option, optional, string } from "cmd-ts";
import { discoverRun } from "./discover.js";
import { openStateDb } from "../state/db.js";
import { listTasks } from "../state/tasks.js";

export const costCmd = command({
  name: "cost",
  description: "Print per-task and total cost for a run.",
  args: {
    run: option({
      long: "run",
      type: optional(string),
      description: "Run ID. Defaults to the newest run.",
    }),
    json: flag({
      long: "json",
      description: "Emit JSON instead of human-readable text.",
    }),
  },
  handler: async ({ run, json }) => {
    const code = await runCost({ runId: run, json });
    process.exit(code);
  },
});

export async function runCost(opts: {
  runId?: string | undefined;
  json?: boolean;
}): Promise<number> {
  let discovered;
  try {
    discovered = await discoverRun({
      cwd: process.cwd(),
      runId: opts.runId,
    });
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const opened = openStateDb(discovered.dbPath);
  try {
    const tasks = listTasks(opened.db, discovered.runId);
    const total = tasks.reduce((acc, t) => acc + t.cost_usd, 0);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            runId: discovered.runId,
            total,
            tasks: tasks.map((t) => ({
              id: t.task_id,
              status: t.status,
              costUsd: t.cost_usd,
            })),
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    for (const t of tasks) {
      process.stdout.write(
        `${t.task_id.padEnd(12)}  ${t.status.padEnd(10)}  $${t.cost_usd.toFixed(2)}\n`,
      );
    }
    process.stdout.write("---\n");
    process.stdout.write(`${"total".padEnd(24)}  $${total.toFixed(2)}\n`);
    return 0;
  } finally {
    opened.close();
  }
}
