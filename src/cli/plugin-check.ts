/**
 * Shared helpers for checking whether the plugin is registered in
 * the user's opencode.json plugin array.
 *
 * Used by:
 *   - `doctor` (health check)
 *   - pilot subcommand guard (auto-install prompt)
 *   - `install-plugin` / `install` (idempotent entry point)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

const PLUGIN_NAME = "@glrs-dev/harness-opencode";

export function getOpencodeConfigPath(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "opencode.json");
}

/**
 * Returns true if the plugin is present in the opencode.json plugin array.
 * Returns false if the config doesn't exist, has no plugin array, or
 * the plugin isn't listed.
 */
export function isPluginInstalled(): boolean {
  const configPath = getOpencodeConfigPath();
  if (!fs.existsSync(configPath)) return false;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const plugins: string[] = Array.isArray(config.plugin) ? config.plugin : [];
    return plugins.some(
      (p) => p === PLUGIN_NAME || String(p).startsWith(`${PLUGIN_NAME}@`),
    );
  } catch {
    return false;
  }
}

/**
 * Interactive prompt: ask the user a yes/no question on stdin/stdout.
 * Returns true for "y"/"yes" (case-insensitive), false otherwise.
 * Non-interactive terminals (no TTY) return `false` immediately.
 */
export function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // prompts go to stderr so stdout stays clean for piping
  });

  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Guard for pilot subcommands. Checks whether the plugin is installed
 * in opencode.json. If not:
 *   - In interactive mode: prompts the user and auto-installs if they say yes.
 *   - In non-interactive mode: prints an error and exits 1.
 *
 * Returns normally if the plugin is installed (or was just installed).
 * Calls process.exit(1) if the user declines or install fails.
 */
export async function requirePlugin(): Promise<void> {
  if (isPluginInstalled()) return;

  const c = {
    reset: "\x1b[0m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
  };

  console.error(
    `${c.yellow}!${c.reset} The OpenCode plugin is not installed. ` +
      `Pilot commands need the plugin to register the pilot-builder and pilot-planner agents.`,
  );

  if (!process.stdin.isTTY) {
    console.error(
      `${c.red}✗${c.reset} Non-interactive terminal. Run: glrs-oc install-plugin`,
    );
    process.exit(1);
  }

  const yes = await promptYesNo("Install the plugin now?");
  if (!yes) {
    console.error(
      `${c.red}✗${c.reset} Plugin required. Run: glrs-oc install-plugin`,
    );
    process.exit(1);
  }

  // Dynamic import to avoid circular dependency with install.ts
  const { install } = await import("./install.js");
  install();
}
