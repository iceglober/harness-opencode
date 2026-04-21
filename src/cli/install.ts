/**
 * `bunx @glrs-dev/harness-opencode install`
 *
 * Adds "@glrs-dev/harness-opencode" to the user's opencode.json plugin array
 * via non-destructive merge. Preserves all existing plugins and user keys.
 * Writes a .bak.<epoch>-<pid> backup before every mutation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mergeConfig, seedConfig } from "./merge-config.js";

const PLUGIN_NAME = "@glrs-dev/harness-opencode";
const PACKAGE_VERSION = "0.1.0"; // updated by release pipeline

function getOpencodeConfigPath(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "opencode.json");
}

/** Minimal seed config when the user has no opencode.json. */
function minimalSeedConfig(pluginEntry: string): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginEntry],
  };
}

export interface InstallOptions {
  dryRun?: boolean;
  pin?: boolean;
}

export function install(opts: InstallOptions = {}): void {
  const { dryRun = false, pin = false } = opts;
  const configPath = getOpencodeConfigPath();
  const pluginEntry = pin ? `${PLUGIN_NAME}@${PACKAGE_VERSION}` : PLUGIN_NAME;

  const c = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    dim: "\x1b[2m",
  };

  const ok = (msg: string) => console.log(`${c.green}✓${c.reset} ${msg}`);
  const info = (msg: string) => console.log(`${c.blue}•${c.reset} ${msg}`);
  const warn = (msg: string) => console.log(`${c.yellow}!${c.reset} ${msg}`);

  console.log(`\n${c.blue}Installing ${PLUGIN_NAME}${c.reset}\n`);

  // Case 1: no opencode.json yet — seed it
  if (!fs.existsSync(configPath)) {
    if (dryRun) {
      info(`[dry-run] Would create ${configPath} with plugin entry "${pluginEntry}"`);
    } else {
      seedConfig(minimalSeedConfig(pluginEntry) as any, configPath);
      ok(`Created ${configPath} with plugin entry "${pluginEntry}"`);
    }
    printNextSteps();
    return;
  }

  // Case 2: opencode.json exists — merge non-destructively
  const srcJson = minimalSeedConfig(pluginEntry) as any;

  try {
    const result = mergeConfig(srcJson, configPath, dryRun);

    if (!result.changed) {
      ok(`${configPath} already contains "${pluginEntry}" — nothing to do`);
      for (const w of result.warnings) warn(w);
    } else {
      if (dryRun) {
        info(`[dry-run] Would merge into ${configPath}:`);
        for (const a of result.additions) info(`  ${a}`);
      } else {
        ok(`Merged into ${configPath}`);
        info(`Backup: ${result.bakPath}`);
        for (const a of result.additions) info(`  ${a}`);
      }
      for (const w of result.warnings) warn(w);
    }
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
    process.exit(1);
  }

  printNextSteps();
}

function printNextSteps(): void {
  console.log(`
Next steps:
  1. Start OpenCode: opencode
  2. Agents, commands, tools, and skills load automatically.
  3. To enable Linear MCP: edit ~/.config/opencode/opencode.json and set "linear".enabled=true.
  4. To update: bun update @glrs-dev/harness-opencode
  5. To uninstall: bunx @glrs-dev/harness-opencode uninstall
`);
}
