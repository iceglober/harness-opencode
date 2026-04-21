/**
 * `bunx @glorious/harness-opencode uninstall`
 *
 * Removes "@glorious/harness-opencode" from the user's opencode.json plugin
 * array. Writes a .bak backup before mutation. Does NOT touch skills (they
 * live in node_modules, removed by `bun remove`). Does NOT touch ~/.claude/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PLUGIN_NAME = "@glorious/harness-opencode";

function getOpencodeConfigPath(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "opencode.json");
}

export interface UninstallOptions {
  dryRun?: boolean;
}

export function uninstall(opts: UninstallOptions = {}): void {
  const { dryRun = false } = opts;
  const configPath = getOpencodeConfigPath();

  const c = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
  };

  const ok = (msg: string) => console.log(`${c.green}✓${c.reset} ${msg}`);
  const info = (msg: string) => console.log(`${c.blue}•${c.reset} ${msg}`);
  const warn = (msg: string) => console.log(`${c.yellow}!${c.reset} ${msg}`);

  console.log(`\n${c.blue}Uninstalling ${PLUGIN_NAME}${c.reset}\n`);

  if (!fs.existsSync(configPath)) {
    warn(`No opencode.json found at ${configPath} — nothing to do`);
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m Failed to read ${configPath}: ${e.message}`);
    process.exit(1);
  }

  let config: any;
  try {
    config = JSON.parse(raw);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m Invalid JSON in ${configPath}: ${e.message}`);
    process.exit(1);
  }

  const plugins: string[] = Array.isArray(config.plugin) ? config.plugin : [];

  // Find all entries that match our plugin name (bare or with version)
  const filtered = plugins.filter(
    (p) =>
      p !== PLUGIN_NAME &&
      !String(p).startsWith(`${PLUGIN_NAME}@`),
  );

  if (filtered.length === plugins.length) {
    warn(`"${PLUGIN_NAME}" not found in plugin array — nothing to remove`);
    return;
  }

  if (dryRun) {
    info(`[dry-run] Would remove "${PLUGIN_NAME}" from plugin array in ${configPath}`);
    return;
  }

  // Backup
  const bakPath = `${configPath}.bak.${Date.now()}-${process.pid}`;
  try {
    fs.copyFileSync(configPath, bakPath);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m Failed to write backup: ${e.message}`);
    process.exit(1);
  }

  config.plugin = filtered;

  const tmpPath = `${configPath}.uninstall.tmp.${Date.now()}-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tmpPath, configPath);
  } catch (e: any) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    console.error(`\x1b[31m✗\x1b[0m Failed to write config: ${e.message}`);
    process.exit(1);
  }

  ok(`Removed "${PLUGIN_NAME}" from ${configPath}`);
  info(`Backup: ${bakPath}`);
  console.log(`
To fully remove the package: bun remove @glorious/harness-opencode
`);
}
