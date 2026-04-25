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
import { select, checkbox, confirm } from "@inquirer/prompts";

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
    const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
    return plugins.some((p) => {
      const name = typeof p === "string" ? p : Array.isArray(p) ? p[0] : null;
      return name === PLUGIN_NAME || String(name ?? "").startsWith(`${PLUGIN_NAME}@`);
    });
  } catch {
    return false;
  }
}

/**
 * Interactive prompt: ask the user a yes/no question.
 * Returns true for "yes", false otherwise.
 * Non-interactive terminals (no TTY) return `false` immediately.
 */
export async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  return confirm({ message: question, default: false });
}

/**
 * Interactive prompt: present choices with arrow-key selection, return the
 * selected index. Returns `defaultIndex` for non-TTY.
 */
export async function promptChoice(
  question: string,
  choices: string[],
  defaultIndex = 0,
): Promise<number> {
  if (!process.stdin.isTTY) return defaultIndex;

  const answer = await select({
    message: question,
    choices: choices.map((label, i) => ({
      name: label,
      value: i,
    })),
    default: defaultIndex,
  });

  return answer;
}

/**
 * Interactive prompt: present a list of checkboxes, return selected indices.
 * Non-TTY returns the default-on items.
 */
export async function promptMulti(
  question: string,
  choices: { label: string; defaultOn: boolean }[],
): Promise<Set<number>> {
  if (!process.stdin.isTTY) {
    const defaults = new Set<number>();
    choices.forEach((c, i) => { if (c.defaultOn) defaults.add(i); });
    return defaults;
  }

  const answers = await checkbox({
    message: question,
    choices: choices.map((c, i) => ({
      name: c.label,
      value: i,
      checked: c.defaultOn,
    })),
  });

  return new Set(answers);
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
  await install({ nonInteractive: true });
}
