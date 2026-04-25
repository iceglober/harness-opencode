/**
 * Run-discovery helpers shared across CLI subcommands that need to
 * locate a state DB on disk.
 *
 * `<pilot>/runs/<runId>/state.db` is the canonical location. Discovery
 * is:
 *
 *   - If `--run <id>` is given: open `<pilot>/runs/<id>/state.db`.
 *   - Otherwise: list `<pilot>/runs/`, find the entry whose
 *     `state.db` has the newest mtime, return that.
 *
 * Returns the run ID, the absolute db path, and the run dir. Callers
 * open the DB themselves so they can choose `:memory:`-style options
 * if needed.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPilotDir, getStateDbPath, getRunDir } from "../paths.js";

export type DiscoveredRun = {
  runId: string;
  dbPath: string;
  runDir: string;
};

/**
 * Discover the run to operate on.
 *
 *   - `runId` provided → use it (validated for fs-safety by `getStateDbPath`).
 *   - `runId` absent  → newest run in `<pilot>/runs/` by mtime of
 *                       `state.db`.
 *
 * Throws with a descriptive message if no runs exist or the requested
 * run id has no state.db.
 */
export async function discoverRun(args: {
  cwd: string;
  runId?: string | undefined;
}): Promise<DiscoveredRun> {
  const cwd = args.cwd;
  if (args.runId !== undefined && args.runId.length > 0) {
    const dbPath = await getStateDbPath(cwd, args.runId);
    try {
      await fs.stat(dbPath);
    } catch {
      throw new Error(
        `pilot: no state.db for run ${JSON.stringify(args.runId)} (looked at ${dbPath})`,
      );
    }
    const runDir = await getRunDir(cwd, args.runId);
    return { runId: args.runId, dbPath, runDir };
  }

  // No id → scan runs dir.
  const pilot = await getPilotDir(cwd);
  const runsDir = path.join(pilot, "runs");
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    throw new Error(
      `pilot: no runs found at ${runsDir} (run \`pilot build\` first)`,
    );
  }
  let newest: { id: string; mtime: number; dbPath: string } | null = null;
  for (const id of entries) {
    const dbPath = path.join(runsDir, id, "state.db");
    let st;
    try {
      st = await fs.stat(dbPath);
    } catch {
      continue;
    }
    if (newest === null || st.mtimeMs > newest.mtime) {
      newest = { id, mtime: st.mtimeMs, dbPath };
    }
  }
  if (newest === null) {
    throw new Error(
      `pilot: no runs with a state.db found in ${runsDir} (was \`pilot build\` interrupted before saving state?)`,
    );
  }
  return {
    runId: newest.id,
    dbPath: newest.dbPath,
    runDir: path.join(runsDir, newest.id),
  };
}
