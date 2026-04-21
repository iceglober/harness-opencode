/**
 * `bunx @glorious/harness-opencode doctor`
 *
 * Checks the installation health and reports per-check green/yellow/red.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

const PLUGIN_NAME = "@glorious/harness-opencode";

function getOpencodeConfigPath(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "opencode.json");
}

function cmd(command: string): string | null {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function which(bin: string): boolean {
  return cmd(`which ${bin}`) !== null;
}

export function doctor(): void {
  const c = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    bold: "\x1b[1m",
  };

  const ok = (msg: string) => console.log(`${c.green}✓${c.reset} ${msg}`);
  const warn = (msg: string) => console.log(`${c.yellow}!${c.reset} ${msg}`);
  const fail = (msg: string) => console.log(`${c.red}✗${c.reset} ${msg}`);

  console.log(`\n${c.bold}Doctor — ${PLUGIN_NAME}${c.reset}\n`);

  // 1. OpenCode CLI
  const ocVersion = cmd("opencode --version 2>/dev/null | head -1");
  if (ocVersion) {
    ok(`opencode ${ocVersion}`);
  } else {
    fail("opencode CLI not found — install from https://opencode.ai");
  }

  // 2. Plugin in opencode.json
  const configPath = getOpencodeConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const plugins: string[] = Array.isArray(config.plugin) ? config.plugin : [];
      const hasPlugin = plugins.some(
        (p) => p === PLUGIN_NAME || String(p).startsWith(`${PLUGIN_NAME}@`),
      );
      if (hasPlugin) {
        ok(`"${PLUGIN_NAME}" present in opencode.json plugin array`);
      } else {
        warn(`"${PLUGIN_NAME}" NOT in opencode.json plugin array — run: bunx ${PLUGIN_NAME} install`);
      }
    } catch {
      fail(`opencode.json at ${configPath} has invalid JSON`);
    }
  } else {
    warn(`No opencode.json at ${configPath} — run: bunx ${PLUGIN_NAME} install`);
  }

  // 3. MCP backends
  if (which("uvx")) {
    ok("uvx (serena + git MCPs)");
  } else {
    warn("uvx not found — serena and git MCPs won't work. Install: brew install uv");
  }

  if (which("node") && which("npx")) {
    ok(`node ${cmd("node --version") ?? ""} + npx (memory MCP)`);
  } else {
    warn("node/npx not found — memory MCP won't work");
  }

  // 4. plan-check CLI
  const planCheckResult = cmd(`bunx ${PLUGIN_NAME} plan-check --help 2>/dev/null`);
  if (planCheckResult !== null) {
    ok("plan-check CLI invokable");
  } else {
    warn("plan-check CLI not invokable — try: bun install");
  }

  // 5. bun / npm
  if (which("bun")) {
    ok(`bun ${cmd("bun --version") ?? ""}`);
  } else if (which("npm")) {
    ok(`npm ${cmd("npm --version") ?? ""} (install bun for faster installs)`);
  } else {
    fail("Neither bun nor npm found — cannot install plugins");
  }

  console.log();
}
