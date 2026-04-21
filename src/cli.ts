#!/usr/bin/env node
/**
 * @glrs-dev/harness-opencode CLI
 *
 * Commands:
 *   install [--dry-run] [--pin]   Add plugin to opencode.json
 *   uninstall [--dry-run]         Remove plugin from opencode.json
 *   doctor                        Check installation health
 *   plan-check [--run|--check] <path>  Parse plan-state fence
 *   --help, -h                    Show help
 *   --version, -v                 Show version
 */

import { install } from "./cli/install.js";
import { uninstall } from "./cli/uninstall.js";
import { doctor } from "./cli/doctor.js";
import { planCheck } from "./bin/plan-check.js";

const VERSION = "0.1.0";

const HELP = `
@glrs-dev/harness-opencode — OpenCode agent harness CLI

Usage:
  bunx @glrs-dev/harness-opencode <command> [options]

Commands:
  install [--dry-run] [--pin]
      Add "@glrs-dev/harness-opencode" to your opencode.json plugin array.
      --dry-run  Preview changes without writing.
      --pin      Pin to the current exact version (e.g. @0.1.0).

  uninstall [--dry-run]
      Remove "@glrs-dev/harness-opencode" from your opencode.json plugin array.

  doctor
      Check installation health (OpenCode CLI, plugin registration, MCP backends).

  plan-check [--run|--check] <plan-path>
      Parse a plan file's plan-state fence.
      (no flag)  Print summary: total/done/pending/invalid counts.
      --run      Print verify commands for pending items (one per line).
      --check    Structural validation; exits 1 if any item is invalid.

  --help, -h     Show this help.
  --version, -v  Show version.
`;

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (command === "install") {
  const dryRun = args.includes("--dry-run");
  const pin = args.includes("--pin");
  install({ dryRun, pin });
  process.exit(0);
}

if (command === "uninstall") {
  const dryRun = args.includes("--dry-run");
  uninstall({ dryRun });
  process.exit(0);
}

if (command === "doctor") {
  doctor();
  process.exit(0);
}

if (command === "plan-check") {
  planCheck(args.slice(1));
  // planCheck calls process.exit internally
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
console.error(`Run with --help for usage.`);
process.exit(2);
