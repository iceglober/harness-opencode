/**
 * `bunx @glrs-dev/harness-opencode doctor`
 *
 * Checks the installation health and reports per-check green/yellow/red.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { validateModelOverride } from "../model-validator.js";

const PLUGIN_NAME = "@glrs-dev/harness-opencode";

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
      const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
      let pluginOptions: Record<string, unknown> | null = null;
      const hasPlugin = plugins.some((p) => {
        if (typeof p === "string") {
          return p === PLUGIN_NAME || p.startsWith(`${PLUGIN_NAME}@`);
        }
        if (Array.isArray(p)) {
          const [name, opts] = p as [unknown, unknown];
          const match =
            name === PLUGIN_NAME ||
            String(name ?? "").startsWith(`${PLUGIN_NAME}@`);
          if (match && opts && typeof opts === "object") {
            pluginOptions = opts as Record<string, unknown>;
          }
          return match;
        }
        return false;
      });
      if (hasPlugin) {
        ok(`"${PLUGIN_NAME}" present in opencode.json plugin array`);
      } else {
        warn(`"${PLUGIN_NAME}" NOT in opencode.json plugin array — run: bunx ${PLUGIN_NAME} install`);
      }

      // 2b. Validate any model overrides the user has configured.
      // Sources, in precedence order: plugin-tuple options.models, legacy
      // top-level config.harness.models. We walk both so a stale legacy
      // config is still surfaced.
      const modelSources: Array<{ label: string; block: unknown }> = [];
      if (pluginOptions && typeof (pluginOptions as { models?: unknown }).models === "object") {
        modelSources.push({
          label: "plugin options.models",
          block: (pluginOptions as { models: unknown }).models,
        });
      }
      const legacyHarness = (config as { harness?: { models?: unknown } }).harness;
      if (legacyHarness && typeof legacyHarness.models === "object") {
        modelSources.push({
          label: "harness.models (legacy)",
          block: legacyHarness.models,
        });
      }

      if (modelSources.length > 0) {
        const invalid: Array<{ keyPath: string; value: string; suggestion?: string; reason?: string }> = [];
        for (const { label, block } of modelSources) {
          if (!block || typeof block !== "object") continue;
          for (const [key, rawValue] of Object.entries(block as Record<string, unknown>)) {
            const candidate: unknown = Array.isArray(rawValue) ? rawValue[0] : rawValue;
            if (typeof candidate !== "string") continue;
            const result = validateModelOverride(candidate);
            if (!result.valid) {
              invalid.push({
                keyPath: `${label}.${key}`,
                value: candidate,
                suggestion: result.suggestion,
                reason: result.reason,
              });
            }
          }
        }
        if (invalid.length === 0) {
          ok("model overrides look valid");
        } else {
          for (const entry of invalid) {
            fail(`invalid model override at ${entry.keyPath}: "${entry.value}"`);
            if (entry.reason) {
              console.log(`    ${c.yellow}reason:${c.reset} ${entry.reason}`);
            }
            if (entry.suggestion) {
              console.log(
                `    ${c.yellow}fix:${c.reset}    remove this key, or replace with \`${entry.suggestion}\``,
              );
            } else {
              console.log(
                `    ${c.yellow}fix:${c.reset}    remove this key, or run \`bunx ${PLUGIN_NAME} install\` to pick a current preset`,
              );
            }
          }
        }
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

  // 6. Pilot subsystem prerequisites.
  console.log();
  console.log(`${c.bold}Pilot subsystem${c.reset}`);

  // git is required for the worktree pool (Phase C1).
  if (which("git")) {
    const gitVer = cmd("git --version") ?? "";
    // Confirm `git worktree --help` works on this version (the pool's
    // load-bearing operation). If the user has a truly ancient git,
    // the worktree command isn't available.
    const worktreeHelp = cmd("git worktree --help 2>&1 | head -1");
    if (worktreeHelp && !worktreeHelp.toLowerCase().includes("not a git command")) {
      ok(`git ${gitVer} (worktree available)`);
    } else {
      fail(`git ${gitVer} but \`git worktree\` is unavailable — pilot needs a recent git (>=2.5)`);
    }
  } else {
    fail("git not found — pilot subsystem requires git for worktree management");
  }

  // bash is required for the verify-runner (Phase D4).
  if (which("bash")) {
    ok("bash (verify-runner shell)");
  } else {
    fail("bash not found — pilot's verify commands run via `bash -c`");
  }

  // Pilot agents resolved in opencode config? Cheap probe: `opencode agent list`.
  const agentList = cmd("opencode agent list 2>/dev/null");
  if (agentList !== null) {
    if (agentList.includes("pilot-builder")) {
      ok("pilot-builder agent registered");
    } else {
      warn(
        "pilot-builder agent NOT in `opencode agent list` — plugin may not be loaded; run: bunx " +
          PLUGIN_NAME +
          " install",
      );
    }
    if (agentList.includes("pilot-planner")) {
      ok("pilot-planner agent registered");
    } else {
      warn(
        "pilot-planner agent NOT in `opencode agent list` — plugin may not be loaded; run: bunx " +
          PLUGIN_NAME +
          " install",
      );
    }
  } else {
    warn(
      "could not run `opencode agent list` — skipping pilot agent registration check",
    );
  }

  console.log();
}
