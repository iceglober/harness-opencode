/**
 * `pilot plan <input>` — launch the opencode TUI with the pilot-planner agent.
 *
 * Spawns:
 *
 *     opencode --agent pilot-planner --prompt "<initial-prompt>"
 *
 * with `--prompt` carrying a small kickoff message that names the input
 * (Linear ID, GitHub URL, free-form text). The user takes over from
 * there, working with the planner agent in their terminal until the
 * plan is saved. When the TUI exits, this command:
 *
 *   1. Scans the pilot plans dir for new `*.yaml` files (modified after
 *      the launch).
 *   2. Prints the newest one and a hint to run `pilot build`.
 *   3. Exits 0 if a new plan was found, 1 if not (the user closed the
 *      TUI without saving).
 *
 * The `--prompt` shape is per spike S1 (`docs/pilot/spikes/s1-opencode-cli-flags.md`):
 * the TUI accepts `--prompt <text>` for first-message injection.
 */

import { command, optional, positional, string, option } from "cmd-ts";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPlansDir } from "../paths.js";
import { requirePlugin } from "../../cli/plugin-check.js";

// --- Constants -------------------------------------------------------------

/**
 * Default agent the planner spawn uses. Hardcoded because pilot's
 * planner is the only sensible value here; if a user wants a different
 * agent, they can spawn opencode themselves.
 */
const PLANNER_AGENT = "pilot-planner";

// --- Public command --------------------------------------------------------

export const planCmd = command({
  name: "plan",
  description:
    "Launch opencode with the pilot-planner agent to author a pilot.yaml.",
  args: {
    input: positional({
      type: optional(string),
      displayName: "input",
      description:
        "Linear ID, GitHub issue/PR URL, or a short description of what to plan.",
    }),
    opencodeBin: option({
      long: "opencode-bin",
      type: optional(string),
      description: "Path to the opencode binary (defaults to `opencode` on PATH).",
    }),
  },
  handler: async ({ input, opencodeBin }) => {
    await requirePlugin();
    const code = await runPlan({ input, opencodeBin });
    process.exit(code);
  },
});

// --- Implementation --------------------------------------------------------

export async function runPlan(opts: {
  input?: string | undefined;
  opencodeBin?: string | undefined;
}): Promise<number> {
  const cwd = process.cwd();
  const plansDir = await getPlansDir(cwd);

  // Snapshot existing plans (and their mtimes) so we can detect what
  // was added/modified during the planner session.
  const before = await snapshotYamls(plansDir);

  const initialPrompt = buildInitialPrompt(opts.input);
  const bin = opts.opencodeBin ?? "opencode";

  const exit = await spawnTui({
    bin,
    args: ["--agent", PLANNER_AGENT, "--prompt", initialPrompt],
    cwd,
  });
  if (exit !== 0) {
    process.stderr.write(
      `pilot plan: opencode exited with code ${exit}\n`,
    );
    return exit;
  }

  // Find new or modified plans.
  const after = await snapshotYamls(plansDir);
  const newest = pickNewestNew(before, after);
  if (newest === null) {
    process.stderr.write(
      `pilot plan: opencode exited cleanly but no new plan was saved in ${plansDir}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Plan ready at ${newest.path}\n` +
      `Build with: bunx @glrs-dev/harness-opencode pilot build\n`,
  );
  return 0;
}

// --- Internals -------------------------------------------------------------

/**
 * Build the first message that's injected into the planner's session.
 * Keep this short — the planner's prompt + skill carry the methodology.
 * The kickoff just names the input so the agent knows where to start.
 */
function buildInitialPrompt(input: string | undefined): string {
  if (input === undefined || input.trim().length === 0) {
    return (
      `Start a new pilot plan. Ask me 1-3 clarifying questions about ` +
      `scope, success criteria, and constraints, then proceed.`
    );
  }
  return (
    `Start a new pilot plan for: ${input.trim()}\n\n` +
    `Use the pilot-planning skill. If the input is a Linear ID or ` +
    `GitHub URL, fetch the ticket via the appropriate MCP/tool. ` +
    `Ask me 1-3 clarifying questions before writing the YAML.`
  );
}

type YamlSnapshot = Map<string, number>; // path → mtimeMs

async function snapshotYamls(dir: string): Promise<YamlSnapshot> {
  const out: YamlSnapshot = new Map();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      out.set(full, st.mtimeMs);
    } catch {
      // ignore — file disappeared between readdir and stat
    }
  }
  return out;
}

/**
 * Pick the newest YAML that is either (a) brand new since the snapshot
 * or (b) had its mtime move forward. Returns null if no such file
 * exists.
 *
 * "Brand new" wins over "modified" — if a brand-new file exists, return
 * the newest of the brand-new set.
 */
function pickNewestNew(
  before: YamlSnapshot,
  after: YamlSnapshot,
): { path: string; mtimeMs: number } | null {
  const candidates: Array<{ path: string; mtimeMs: number; isNew: boolean }> =
    [];
  for (const [p, mtime] of after) {
    const prev = before.get(p);
    if (prev === undefined) {
      candidates.push({ path: p, mtimeMs: mtime, isNew: true });
    } else if (mtime > prev) {
      candidates.push({ path: p, mtimeMs: mtime, isNew: false });
    }
  }
  if (candidates.length === 0) return null;
  // Prefer brand-new files; among them, take the newest.
  const news = candidates.filter((c) => c.isNew);
  const pool = news.length > 0 ? news : candidates;
  pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { path: pool[0]!.path, mtimeMs: pool[0]!.mtimeMs };
}

/**
 * Spawn the opencode TUI and wait for it to exit. stdio is inherited
 * so the user interacts directly. Returns the exit code (or 1 if the
 * process emitted an `error` event).
 */
function spawnTui(args: {
  bin: string;
  args: string[];
  cwd: string;
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(args.bin, args.args, {
      cwd: args.cwd,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      process.stderr.write(
        `pilot plan: failed to spawn ${args.bin}: ${err.message}\n`,
      );
      resolve(1);
    });
  });
}
