/**
 * `pilot plan-dir` — print the per-repo pilot plans directory.
 *
 * Mirrors the top-level `harness-opencode plan-dir` but for the pilot
 * subsystem's plan dir specifically. The path resolves to:
 *
 *     <pilot-base>/<repo-folder>/pilot/plans
 *
 * (See `src/pilot/paths.ts::getPlansDir` for the full resolution rules.)
 *
 * Used by the `pilot-planner` agent to decide where to save its YAML
 * plans. The agent's bash permission allow-list explicitly allows
 * this subcommand (see `PILOT_PLANNER_PERMISSIONS` in
 * `src/agents/index.ts`).
 *
 * Side effect: creates the directory if missing. No migration runs
 * here — pilot is brand-new in v0.1, no legacy state to absorb.
 */

import { command } from "cmd-ts";
import { getPlansDir } from "../paths.js";

export const planDirCmd = command({
  name: "plan-dir",
  description:
    "Print the pilot plans directory for the current worktree (creates it if missing).",
  args: {},
  handler: async () => {
    try {
      const cwd = process.cwd();
      const dir = await getPlansDir(cwd);
      process.stdout.write(dir + "\n");
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pilot plan-dir: ${msg}\n`);
      process.exit(1);
    }
  },
});
