/**
 * `pilot status [--run <id>] [--json]` — print run + task status.
 *
 * Default rendering (text):
 *
 *     Run <id>: <status>
 *       plan: <plan_path>
 *       slug: <plan_slug>
 *       started: <iso8601>  finished: <iso8601 | -->
 *       counts: succeeded=N failed=N blocked=N ...
 *
 *       Tasks (<N>):
 *         T1 [succeeded] attempts=1 cost=$0.42 branch=pilot/<slug>/T1
 *         T2 [failed]    attempts=3 cost=$1.10 last_error=verify failed...
 *         ...
 *
 * `--json` outputs a single JSON object with `run` + `tasks` for
 * scripting consumers. Schema mirrors the SQLite row shape from
 * `src/pilot/state/types.ts`.
 *
 * No filtering flags in v0.1; keep it boring. Filters can be layered
 * on later via `--task <id>` if needed.
 */

import { command, flag, option, optional, string } from "cmd-ts";
import { discoverRun } from "./discover.js";
import { openStateDb } from "../state/db.js";
import { getRun } from "../state/runs.js";
import { listTasks, countByStatus } from "../state/tasks.js";

export const statusCmd = command({
  name: "status",
  description: "Print the run + task status for a pilot run.",
  args: {
    run: option({
      long: "run",
      type: optional(string),
      description: "Run ID. Defaults to the newest run with a state.db.",
    }),
    json: flag({
      long: "json",
      description: "Emit JSON instead of human-readable text.",
    }),
  },
  handler: async ({ run, json }) => {
    const code = await runStatus({ runId: run, json });
    process.exit(code);
  },
});

export async function runStatus(opts: {
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
    const run = getRun(opened.db, discovered.runId);
    if (run === null) {
      process.stderr.write(
        `pilot status: run ${JSON.stringify(discovered.runId)} not in DB\n`,
      );
      return 1;
    }
    const tasks = listTasks(opened.db, discovered.runId);
    const counts = countByStatus(opened.db, discovered.runId);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ run, tasks, counts }, null, 2) + "\n",
      );
      return 0;
    }

    // Human-readable.
    const lines: string[] = [];
    lines.push(`Run ${run.id}: ${run.status}`);
    lines.push(`  plan: ${run.plan_path}`);
    lines.push(`  slug: ${run.plan_slug}`);
    lines.push(
      `  started: ${formatTs(run.started_at)}  ` +
        `finished: ${run.finished_at !== null ? formatTs(run.finished_at) : "--"}`,
    );
    lines.push(
      `  counts: succeeded=${counts.succeeded} failed=${counts.failed} blocked=${counts.blocked} ` +
        `aborted=${counts.aborted} pending=${counts.pending} ready=${counts.ready} running=${counts.running}`,
    );
    lines.push("");
    lines.push(`  Tasks (${tasks.length}):`);
    for (const t of tasks) {
      const cost = `$${t.cost_usd.toFixed(2)}`;
      const branch = t.branch ?? "-";
      const baseLine = `    ${t.task_id.padEnd(12)} [${t.status.padEnd(9)}] attempts=${t.attempts} cost=${cost} branch=${branch}`;
      lines.push(baseLine);
      if (t.last_error) {
        // Wrap long errors at 76 chars per indent level (4 + 4 = 8).
        for (const wrapped of wrap(`last_error: ${t.last_error}`, 76)) {
          lines.push(`        ${wrapped}`);
        }
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    opened.close();
  }
}

// --- Helpers ---------------------------------------------------------------

function formatTs(ms: number): string {
  return new Date(ms).toISOString();
}

function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if ((cur + " " + word).trim().length > width) {
      out.push(cur);
      cur = word;
    } else {
      cur = (cur + " " + word).trim();
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
