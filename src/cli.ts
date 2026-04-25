#!/usr/bin/env node
/**
 * @glrs-dev/harness-opencode CLI entry point.
 *
 * Built on `cmd-ts` for declarative argument parsing, type-safe option
 * shapes, and consistent --help output across every subcommand. Each
 * subcommand lives in its own file under `src/cli/...` (top-level) or
 * `src/pilot/cli/...` (pilot subsystem); this file is wiring only.
 *
 * Top-level commands (legacy hand-rolled CLI, now ported):
 *   - install      Add the plugin to opencode.json
 *   - uninstall    Remove the plugin from opencode.json
 *   - doctor       Check installation health
 *   - plan-check   Parse plan-state fence (legacy markdown plans)
 *   - plan-dir     Print the repo-shared plan dir
 *
 * Pilot subsystem commands (Phase G1+):
 *   - pilot ...    See `src/pilot/cli/index.ts`
 */

import {
  binary,
  command,
  flag,
  option,
  optional,
  positional,
  restPositionals,
  string,
  subcommands,
  run,
} from "cmd-ts";

import { install } from "./cli/install.js";
import { uninstall } from "./cli/uninstall.js";
import { doctor } from "./cli/doctor.js";
import { planCheck } from "./bin/plan-check.js";
import { getPlanDir, migratePlans } from "./plan-paths.js";
import { pilotSubcommand } from "./pilot/cli/index.js";

const VERSION = "0.1.0";

// --- Subcommand definitions ------------------------------------------------

const installCmd = command({
  name: "install",
  description:
    'Add "@glrs-dev/harness-opencode" to your opencode.json plugin array.',
  args: {
    dryRun: flag({
      long: "dry-run",
      description: "Preview changes without writing.",
    }),
    pin: flag({
      long: "pin",
      description: "Pin to the current exact version (e.g. @0.1.0).",
    }),
  },
  handler: ({ dryRun, pin }) => {
    install({ dryRun, pin });
  },
});

const uninstallCmd = command({
  name: "uninstall",
  description:
    'Remove "@glrs-dev/harness-opencode" from your opencode.json plugin array.',
  args: {
    dryRun: flag({
      long: "dry-run",
      description: "Preview changes without writing.",
    }),
  },
  handler: ({ dryRun }) => {
    uninstall({ dryRun });
  },
});

const doctorCmd = command({
  name: "doctor",
  description:
    "Check installation health (OpenCode CLI, plugin registration, MCP backends).",
  args: {},
  handler: () => {
    doctor();
  },
});

/**
 * `plan-check` keeps its legacy CLI surface — it accepts `--run <path>`,
 * `--check <path>`, or just `<path>`. The underlying `planCheck` helper
 * does its own argv parsing and process.exit, so we forward all
 * positional + restPositionals as a single string array.
 *
 * cmd-ts's strict-mode option-recognition would reject unknown flags
 * here; we sidestep that by treating the whole thing as a rest-args
 * passthrough. The `--run` / `--check` behavior is already covered by
 * tests of `planCheck` directly.
 */
const planCheckCmd = command({
  name: "plan-check",
  description: "Parse a plan file's plan-state fence (legacy markdown plans).",
  args: {
    run: option({
      long: "run",
      type: optional(string),
      description: "Print verify commands for pending items, one per line.",
    }),
    check: option({
      long: "check",
      type: optional(string),
      description: "Structural validation; exits 1 if any item is invalid.",
    }),
    rest: restPositionals({
      type: string,
      displayName: "plan-path",
      description:
        "Path to a plan markdown file. Required unless --run / --check is given.",
    }),
  },
  handler: ({ run, check, rest }) => {
    // Reconstruct the legacy argv that `planCheck` expects.
    const legacy: string[] = [];
    if (run !== undefined) {
      legacy.push("--run", run);
    } else if (check !== undefined) {
      legacy.push("--check", check);
    } else {
      legacy.push(...rest);
    }
    planCheck(legacy);
    // planCheck calls process.exit internally on success.
  },
});

const planDirCmd = command({
  name: "plan-dir",
  description:
    "Print the repo-shared plan directory for the current worktree (resolves + creates + migrates legacy).",
  args: {},
  handler: async () => {
    try {
      const cwd = process.cwd();
      const planDir = await getPlanDir(cwd);
      await migratePlans(cwd, planDir);
      process.stdout.write(planDir + "\n");
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`plan-dir: ${msg}\n`);
      process.exit(1);
    }
  },
});

// --- Top-level subcommand tree --------------------------------------------

const cli = subcommands({
  name: "harness-opencode",
  description: "OpenCode agent harness CLI.",
  version: VERSION,
  cmds: {
    install: installCmd,
    uninstall: uninstallCmd,
    doctor: doctorCmd,
    "plan-check": planCheckCmd,
    "plan-dir": planDirCmd,
    pilot: pilotSubcommand,
  },
});

// `binary(cli)` strips Node's `[node, script, ...args]` boilerplate so
// `process.argv` is rewritten to just user-supplied args before parsing.
// This matches what `bunx @glrs-dev/harness-opencode <cmd>` callers expect.
//
// The `void` is to suppress the floating-promise warning — `run` returns
// a Promise that resolves after the handler completes; we don't need to
// await it because handlers either call process.exit themselves OR we
// let Node's normal exit flow run.
void run(binary(cli), process.argv);

// Avoid unused-positional import warning. `positional` may be used by
// future subcommands; we keep it imported for ergonomic reuse.
void positional;
