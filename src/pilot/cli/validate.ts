/**
 * `pilot validate` — schema + DAG + glob check on a `pilot.yaml` plan.
 *
 * Three layers of validation:
 *
 *   1. **Schema** (`loadPlan`) — Zod-based; YAML parse + structural
 *      shape. Errors here are fatal and exit 2.
 *   2. **DAG** (`validateDag`) — duplicate IDs, self-loops, dangling
 *      `depends_on`, cycles. Fatal; exit 2.
 *   3. **Glob conflicts** (`findTouchConflicts`) — pairs of tasks whose
 *      `touches:` overlap. WARN only by default (v0.1 runs serial so
 *      conflicts can't actually race). Promote to errors with `--strict`.
 *
 * Path argument:
 *   - Optional positional. If omitted, validate the newest `*.yaml` in
 *     the pilot plans dir (resolved via `getPlansDir(cwd)`).
 *   - If a directory is given, validate the newest `*.yaml` inside it.
 *
 * Output format:
 *   - One error per line: `<kind>: <path-into-doc>: <message>`
 *   - Validates pass quietly to support shell-friendly chains
 *     (`pilot validate && pilot build`).
 *
 * Exit codes:
 *   - 0: all checks passed (or only non-strict warnings).
 *   - 1: I/O error reading the plan file.
 *   - 2: validation error.
 */

import { command, optional, positional, string, flag } from "cmd-ts";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { loadPlan } from "../plan/load.js";
import { validateDag, formatDagError } from "../plan/dag.js";
import { findTouchConflicts, validateTouchSet } from "../plan/globs.js";
import { getPlansDir } from "../paths.js";

// --- Public handler --------------------------------------------------------

export const validateCmd = command({
  name: "validate",
  description: "Validate a pilot.yaml plan (schema + DAG + glob conflicts).",
  args: {
    planPath: positional({
      type: optional(string),
      displayName: "plan-path",
      description:
        "Path to a pilot.yaml file or a dir containing one. Defaults to the newest *.yaml in the pilot plans dir.",
    }),
    strict: flag({
      long: "strict",
      description:
        "Treat glob-conflict warnings as errors (exit 2 if any pair of tasks has overlapping `touches:`).",
    }),
    quiet: flag({
      long: "quiet",
      short: "q",
      description: "Suppress success output (errors still print to stderr).",
    }),
  },
  handler: async ({ planPath, strict, quiet }) => {
    const code = await runValidate({ planPath, strict, quiet });
    process.exit(code);
  },
});

// --- Implementation --------------------------------------------------------

/**
 * Internal entry point — separated from the CLI handler so the pilot
 * `build` subcommand can reuse the validation pipeline without
 * spawning a subprocess.
 *
 * Returns the exit code rather than calling process.exit directly, so
 * tests can assert on the result instead of catching a process.exit.
 */
export async function runValidate(opts: {
  planPath?: string | undefined;
  strict?: boolean;
  quiet?: boolean;
}): Promise<number> {
  const { strict = false, quiet = false } = opts;

  // 1. Resolve the actual plan file path.
  let absPath: string;
  try {
    absPath = await resolvePlanPath(opts.planPath);
  } catch (err) {
    process.stderr.write(
      `pilot validate: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // 2. Load + schema-validate.
  const loaded = await loadPlan(absPath);
  if (!loaded.ok) {
    const label =
      loaded.kind === "fs"
        ? "file"
        : loaded.kind === "yaml"
          ? "yaml"
          : "schema";
    for (const e of loaded.errors) {
      process.stderr.write(`${label}: ${e.path}: ${e.message}\n`);
    }
    return loaded.kind === "fs" ? 1 : 2;
  }

  // 3. DAG validation.
  const dag = validateDag(loaded.plan);
  if (!dag.ok) {
    for (const e of dag.errors) {
      process.stderr.write(`dag: ${formatDagError(e)}\n`);
    }
    return 2;
  }

  // 4. Per-task touch-pattern wellformedness.
  let touchSetErrors = 0;
  for (let i = 0; i < loaded.plan.tasks.length; i++) {
    const t = loaded.plan.tasks[i]!;
    const r = validateTouchSet(t.touches);
    if (!r.ok) {
      process.stderr.write(
        `touches: tasks[${i}].touches[${r.index}] (${JSON.stringify(r.pattern)}): ${r.message}\n`,
      );
      touchSetErrors++;
    }
  }
  if (touchSetErrors > 0) return 2;

  // 5. Cross-task touches conflicts (warn or error per --strict).
  const conflicts = findTouchConflicts(loaded.plan.tasks);
  if (conflicts.length > 0) {
    const stream = strict ? process.stderr : process.stderr;
    const label = strict ? "touches-conflict (error)" : "touches-conflict (warn)";
    for (const c of conflicts) {
      stream.write(`${label}: ${c.a} ↔ ${c.b}\n`);
    }
    if (strict) return 2;
  }

  // Success.
  if (!quiet) {
    process.stdout.write(
      `ok: ${loaded.absPath} — ${loaded.plan.tasks.length} tasks, ` +
        `${dag.topo.length} in topo order` +
        (loaded.plan.milestones.length > 0
          ? `, ${loaded.plan.milestones.length} milestones`
          : "") +
        (conflicts.length > 0
          ? `, ${conflicts.length} touches-conflict warning${conflicts.length === 1 ? "" : "s"}`
          : "") +
        "\n",
    );
  }
  return 0;
}

// --- Path resolution -------------------------------------------------------

/**
 * Resolve the user-supplied (or absent) plan path to a concrete file.
 *
 *   - Explicit file path → resolve to absolute, return.
 *   - Explicit directory path → find newest `*.yaml` inside, return.
 *   - Omitted → use `getPlansDir(cwd)`, find newest `*.yaml` inside.
 *
 * Throws with a descriptive message if the target is missing or empty.
 */
async function resolvePlanPath(input: string | undefined): Promise<string> {
  if (input !== undefined && input.length > 0) {
    const resolved = path.resolve(input);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (err) {
      throw new Error(
        `cannot stat ${JSON.stringify(resolved)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (stat.isFile()) return resolved;
    if (stat.isDirectory()) return findNewestYaml(resolved);
    throw new Error(
      `${JSON.stringify(resolved)} is neither a file nor a directory`,
    );
  }
  const dir = await getPlansDir(process.cwd());
  return findNewestYaml(dir);
}

async function findNewestYaml(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    throw new Error(
      `cannot read directory ${JSON.stringify(dir)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const yamls = entries.filter(
    (n) => n.endsWith(".yaml") || n.endsWith(".yml"),
  );
  if (yamls.length === 0) {
    throw new Error(`no *.yaml files in ${JSON.stringify(dir)}`);
  }

  // Find newest by mtime.
  let newest: { name: string; mtime: number } | null = null;
  for (const name of yamls) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    const mtime = stat.mtimeMs;
    if (newest === null || mtime > newest.mtime) {
      newest = { name, mtime };
    }
  }
  if (newest === null) {
    throw new Error(`no readable *.yaml files in ${JSON.stringify(dir)}`);
  }
  return path.join(dir, newest.name);
}
