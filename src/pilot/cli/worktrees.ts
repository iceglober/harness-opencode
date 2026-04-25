/**
 * `pilot worktrees <list|prune> [--run <id>]` — manage on-disk worktrees.
 *
 * v0.1 is single-worker, so each run has at most one worktree at
 * `<runDir>/worktrees/<runId>/00`. The list is short; the prune is a
 * matter of removing worktrees whose tasks succeeded (default) or
 * unconditionally (`--all`).
 *
 * The DEFAULT prune behavior is conservative: it removes worktrees only
 * when EVERY task on that worktree's branch is in a terminal state AND
 * the run as a whole succeeded. Failed worktrees are preserved by
 * default for inspection. `--all` overrides that.
 */

import { command, flag, option, optional, string, subcommands } from "cmd-ts";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { discoverRun } from "./discover.js";
import { openStateDb } from "../state/db.js";
import { listTasks } from "../state/tasks.js";
import { getRun } from "../state/runs.js";
import {
  gitWorktreeList,
  gitWorktreeRemove,
} from "../worktree/git.js";

const listSubcmd = command({
  name: "list",
  description: "List worktrees registered with the repo (filter to pilot ones).",
  args: {
    run: option({
      long: "run",
      type: optional(string),
      description: "Run ID for context. Defaults to the newest run.",
    }),
  },
  handler: async ({ run }) => {
    const code = await runWorktreesList({ runId: run });
    process.exit(code);
  },
});

const pruneSubcmd = command({
  name: "prune",
  description: "Remove worktrees from succeeded tasks (default) or all (--all).",
  args: {
    run: option({
      long: "run",
      type: optional(string),
      description: "Run ID. Defaults to the newest run.",
    }),
    all: flag({
      long: "all",
      description:
        "Remove every pilot worktree for this run, even failed/aborted ones.",
    }),
    dryRun: flag({
      long: "dry-run",
      description: "Print what would be removed without removing.",
    }),
  },
  handler: async ({ run, all, dryRun }) => {
    const code = await runWorktreesPrune({ runId: run, all, dryRun });
    process.exit(code);
  },
});

export const worktreesCmd = subcommands({
  name: "worktrees",
  description: "Inspect and prune pilot-managed git worktrees.",
  cmds: {
    list: listSubcmd,
    prune: pruneSubcmd,
  },
});

// --- list ------------------------------------------------------------------

export async function runWorktreesList(opts: {
  runId?: string | undefined;
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

  const all = await gitWorktreeList(process.cwd());
  // Filter: pilot worktrees live under <runDir>/worktrees/<runId>/.
  const wtBase = path.join(discovered.runDir, "..");
  // ^ NB: <runDir> is `<pilot>/runs/<runId>`. The worktree lives at
  //   `<pilot>/worktrees/<runId>/00`, NOT a sibling under runDir. Get
  //   pilot from runDir's grandparent.
  const pilotDir = path.dirname(path.dirname(discovered.runDir));
  const wtPrefix = path.join(pilotDir, "worktrees", discovered.runId);
  const filtered = all.filter((w) => w.path.startsWith(wtPrefix));
  void wtBase; // keep for future per-run filter refinements

  if (filtered.length === 0) {
    process.stdout.write(
      `pilot worktrees list: no pilot worktrees for run ${discovered.runId}\n`,
    );
    return 0;
  }
  for (const w of filtered) {
    process.stdout.write(
      `${w.path}\t${w.head.slice(0, 7)}\t${w.branch ?? "(detached)"}\n`,
    );
  }
  return 0;
}

// --- prune ----------------------------------------------------------------

export async function runWorktreesPrune(opts: {
  runId?: string | undefined;
  all?: boolean;
  dryRun?: boolean;
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
  let candidates: string[];
  try {
    const tasks = listTasks(opened.db, discovered.runId);
    const run = getRun(opened.db, discovered.runId);

    // Build the candidate set:
    //   --all            → every worktree we can find for this run.
    //   default          → only worktrees whose tasks succeeded AND the
    //                      whole run completed cleanly.
    if (opts.all) {
      candidates = tasks
        .map((t) => t.worktree_path)
        .filter((p): p is string => p !== null);
    } else {
      // Conservative default: keep failed/blocked/aborted worktrees.
      // Only prune when run completed AND every task on this worktree
      // succeeded.
      const safeStatuses = run?.status === "completed";
      candidates = tasks
        .filter((t) => safeStatuses && t.status === "succeeded")
        .map((t) => t.worktree_path)
        .filter((p): p is string => p !== null);
    }
  } finally {
    opened.close();
  }

  // Dedupe (multiple tasks may share a worktree path on a single-worker
  // run that recycled).
  const uniq = [...new Set(candidates)];

  if (uniq.length === 0) {
    process.stdout.write(
      `pilot worktrees prune: nothing to prune for run ${discovered.runId}` +
        (opts.all ? "" : " (use --all to force)") +
        "\n",
    );
    return 0;
  }

  if (opts.dryRun) {
    process.stdout.write("Would remove:\n");
    for (const p of uniq) process.stdout.write(`  ${p}\n`);
    return 0;
  }

  let removed = 0;
  let errors = 0;
  for (const p of uniq) {
    try {
      await gitWorktreeRemove({
        repoPath: process.cwd(),
        worktreePath: p,
      });
      // Also remove the on-disk dir if git's remove left it (it shouldn't).
      try {
        await fs.rm(p, { recursive: true, force: true });
      } catch {
        // ignore — the dir was already cleaned up.
      }
      removed++;
    } catch (err) {
      errors++;
      process.stderr.write(
        `pilot worktrees prune: failed to remove ${p}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  process.stdout.write(
    `pilot worktrees prune: removed ${removed}/${uniq.length} (${errors} errors)\n`,
  );
  return errors > 0 ? 1 : 0;
}
