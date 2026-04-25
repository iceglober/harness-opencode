/**
 * `pilot logs <task-id> [--run <id>] [--json]` — print events for a task.
 *
 * Reads the events table for the (run, task) pair and renders one line
 * per event in chronological order:
 *
 *     <iso-timestamp>  <kind>   <payload-summary>
 *
 * `--json` emits a JSON array of decoded events for scripting consumers.
 *
 * The payload-summary is best-effort — common kinds get specific
 * formatting (`task.verify.failed → "exit N: <command>"`), unknown kinds
 * fall through to a JSON-stringified payload truncated to ~120 chars.
 *
 * Includes a hint pointing at the worker's JSONL log path (Phase E1's
 * `<runDir>/workers/00.jsonl`) for callers who want raw verify output
 * — pilot's events table is structured but doesn't carry full verify
 * stdout/stderr (that's the JSONL's job).
 */

import { command, flag, option, optional, positional, string } from "cmd-ts";
import { discoverRun } from "./discover.js";
import { openStateDb } from "../state/db.js";
import { getTask } from "../state/tasks.js";
import { readEventsDecoded } from "../state/events.js";
import { getWorkerJsonlPath } from "../paths.js";

export const logsCmd = command({
  name: "logs",
  description: "Print structured events for a task.",
  args: {
    taskId: positional({
      type: string,
      displayName: "task-id",
    }),
    run: option({
      long: "run",
      type: optional(string),
      description: "Run ID. Defaults to the newest run.",
    }),
    json: flag({
      long: "json",
      description: "Emit JSON array instead of human-readable text.",
    }),
  },
  handler: async ({ taskId, run, json }) => {
    const code = await runLogs({ taskId, runId: run, json });
    process.exit(code);
  },
});

export async function runLogs(opts: {
  taskId: string;
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
    const task = getTask(opened.db, discovered.runId, opts.taskId);
    if (task === null) {
      process.stderr.write(
        `pilot logs: task ${JSON.stringify(opts.taskId)} not found in run ${discovered.runId}\n`,
      );
      return 1;
    }
    const events = readEventsDecoded(opened.db, {
      runId: discovered.runId,
      taskId: opts.taskId,
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(events, null, 2) + "\n");
      return 0;
    }

    process.stdout.write(
      `Task ${opts.taskId} (status=${task.status}, attempts=${task.attempts}, cost=$${task.cost_usd.toFixed(2)})\n`,
    );
    if (task.session_id) {
      process.stdout.write(`  session: ${task.session_id}\n`);
    }
    if (task.branch) {
      process.stdout.write(`  branch:  ${task.branch}\n`);
    }
    if (task.worktree_path) {
      process.stdout.write(`  wt:      ${task.worktree_path}\n`);
    }
    // Worker JSONL: <runDir>/workers/00.jsonl by default. We don't
    // know which worker ran this task (v0.1 is single-worker, so it's
    // always 00). Print the canonical path.
    const jsonl = await getWorkerJsonlPath(
      process.cwd(),
      discovered.runId,
      0,
    );
    process.stdout.write(`  jsonl:   ${jsonl}\n`);
    process.stdout.write(`  events (${events.length}):\n`);

    for (const e of events) {
      process.stdout.write(
        `    ${formatTs(e.ts)}  ${e.kind.padEnd(28)}  ${summarizePayload(e.kind, e.payload)}\n`,
      );
    }
    return 0;
  } finally {
    opened.close();
  }
}

function formatTs(ms: number): string {
  return new Date(ms).toISOString();
}

function summarizePayload(kind: string, payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (kind === "task.verify.failed") {
    const p = payload as {
      command?: string;
      exitCode?: number;
      timedOut?: boolean;
      aborted?: boolean;
    };
    return (
      `exit ${p.exitCode ?? "?"}` +
      (p.timedOut ? " (timed out)" : "") +
      (p.aborted ? " (aborted)" : "") +
      `: ${p.command ?? ""}`
    );
  }
  if (kind === "task.touches.violation") {
    const p = payload as { violators?: string[] };
    return `violators: ${(p.violators ?? []).join(", ")}`;
  }
  if (kind === "task.session.created") {
    const p = payload as { sessionId?: string; branch?: string };
    return `session=${p.sessionId ?? "?"} branch=${p.branch ?? "?"}`;
  }
  if (kind === "task.succeeded") {
    const p = payload as { commit?: string | null; changed?: string[] };
    return `commit=${p.commit ?? "(no diff)"} changed=${(p.changed ?? []).length}`;
  }
  if (kind === "task.failed") {
    const p = payload as { phase?: string; reason?: string };
    return `phase=${p.phase ?? ""} ${p.reason ?? ""}`;
  }
  if (kind === "task.attempt") {
    const p = payload as { attempt?: number; of?: number };
    return `${p.attempt ?? "?"} / ${p.of ?? "?"}`;
  }
  // Default: stringify, truncate.
  let s: string;
  try {
    s = JSON.stringify(payload);
  } catch {
    s = String(payload);
  }
  if (s.length > 120) s = s.slice(0, 117) + "...";
  return s;
}
