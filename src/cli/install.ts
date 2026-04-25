/**
 * `glrs-oc install-plugin` / `glrs-oc install`
 *
 * Interactive plugin installer. When run in a TTY, walks the user through:
 *   1. Plugin registration (always)
 *   2. Model provider selection (Anthropic direct, AWS Bedrock, or custom)
 *   3. MCP server toggles (playwright, linear)
 *
 * Idempotent: reads the existing config first and only prompts for keys
 * that aren't already set. Re-running shows a summary of current config
 * and skips questions whose answers are already in opencode.json.
 *
 * Non-interactive (no TTY or --non-interactive): registers the plugin
 * with defaults and skips all prompts.
 *
 * Adds configuration to `~/.config/opencode/opencode.json` via non-
 * destructive merge. Preserves all existing user keys. Writes a
 * `.bak.<epoch>-<pid>` backup before every mutation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { mergeConfig, seedConfig } from "./merge-config.js";
import { promptChoice, promptMulti } from "./plugin-check.js";
import {
  readOurPackageVersion,
  refreshPluginCache,
  inspectCachePin,
  getOpenCodeCachePackageDir,
} from "../auto-update.js";

const PLUGIN_NAME = "@glrs-dev/harness-opencode";

// --- ANSI helpers ----------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

const ok = (msg: string) => console.log(`${c.green}✓${c.reset} ${msg}`);
const info = (msg: string) => console.log(`${c.blue}•${c.reset} ${msg}`);
const warn = (msg: string) => console.log(`${c.yellow}!${c.reset} ${msg}`);

// --- Model provider presets ------------------------------------------------

interface ModelPreset {
  label: string;
  deep: string;
  mid: string;
  fast: string;
}

const MODEL_PRESETS: ModelPreset[] = [
  {
    label: "Anthropic API (direct)",
    deep: "anthropic/claude-opus-4-7",
    mid: "anthropic/claude-sonnet-4-6",
    fast: "anthropic/claude-haiku-4-5",
  },
  {
    label: "AWS Bedrock",
    deep: "bedrock/claude-opus-4",
    mid: "bedrock/claude-sonnet-4",
    fast: "bedrock/claude-haiku-4",
  },
  {
    label: "Google Vertex AI",
    deep: "vertex/claude-opus-4",
    mid: "vertex/claude-sonnet-4",
    fast: "vertex/claude-haiku-4",
  },
];

// --- MCP toggle definitions ------------------------------------------------

interface McpToggle {
  name: string;
  label: string;
  defaultOn: boolean;
}

const MCP_TOGGLES: McpToggle[] = [
  { name: "playwright", label: "Playwright — browser automation", defaultOn: false },
  { name: "linear", label: "Linear — issue tracker integration", defaultOn: false },
];

// --- Helpers ---------------------------------------------------------------

/**
 * Read the plugin's version from its package.json.
 */
function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "package.json"),
    path.join(here, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === PLUGIN_NAME && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Could not locate ${PLUGIN_NAME}'s package.json to read version`,
  );
}

function getOpencodeConfigPath(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "opencode.json");
}

/**
 * Refresh the OpenCode plugin cache if it exists and is stale.
 *
 * The cache at ~/.cache/opencode/packages/@glrs-dev/harness-opencode@latest/
 * can get stuck with an exact pin to an old version and no node_modules/.
 * When that happens, the plugin never loads (no code to run), and the
 * in-plugin auto-update never fires. This function breaks the deadlock
 * by rewriting the cache pin to match the version we're running as.
 */
async function refreshPluginCacheIfStale(): Promise<void> {
  try {
    const cacheDir = getOpenCodeCachePackageDir();
    const pin = await inspectCachePin(cacheDir);

    if (pin.kind !== "exact") return; // no cache, non-exact, or not our package

    const ourVersion = readOurPackageVersion(import.meta.url);
    if (pin.version === ourVersion) return; // already current

    const result = await refreshPluginCache(pin.version, ourVersion);
    if (result.outcome === "refreshed") {
      ok(`Plugin cache updated: ${result.fromVersion} → ${result.toVersion}`);
    }
  } catch {
    // Best-effort — never break install over a cache issue.
  }
}

/**
 * Safely read and parse the existing opencode.json, or return null.
 */
function readExistingConfig(configPath: string): Record<string, any> | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Detect the current model provider from an existing config's
 * `harness.models` block, if any. Returns a human-readable label.
 */
function detectModelProvider(existing: Record<string, any> | null): string | null {
  const models = existing?.harness?.models;
  if (!models) return null;

  const deep = Array.isArray(models.deep) ? models.deep[0] : models.deep;
  if (typeof deep !== "string") return null;

  for (const preset of MODEL_PRESETS) {
    if (deep === preset.deep) return preset.label;
  }
  return `custom (${deep})`;
}

/**
 * Detect which optional MCPs are already configured in the existing config.
 */
function detectEnabledMcps(existing: Record<string, any> | null): Set<string> {
  const enabled = new Set<string>();
  const mcp = existing?.mcp;
  if (!mcp || typeof mcp !== "object") return enabled;

  for (const toggle of MCP_TOGGLES) {
    if (mcp[toggle.name]?.enabled === true) {
      enabled.add(toggle.name);
    }
  }
  return enabled;
}

// --- Install logic ---------------------------------------------------------

export interface InstallOptions {
  dryRun?: boolean;
  pin?: boolean;
  nonInteractive?: boolean;
}

export async function install(opts: InstallOptions = {}): Promise<void> {
  const { dryRun = false, pin = false, nonInteractive = false } = opts;
  const configPath = getOpencodeConfigPath();
  const pluginEntry = pin ? `${PLUGIN_NAME}@${readPackageVersion()}` : PLUGIN_NAME;
  const interactive = !nonInteractive && process.stdin.isTTY === true;

  // Read existing config to detect what's already configured.
  const existing = readExistingConfig(configPath);
  const hasPlugin = existing
    ? (Array.isArray(existing.plugin) ? existing.plugin : []).some(
        (p: string) => p === PLUGIN_NAME || String(p).startsWith(`${PLUGIN_NAME}@`),
      )
    : false;
  const existingProvider = detectModelProvider(existing);
  const existingMcps = detectEnabledMcps(existing);
  const hasModels = !!existing?.harness?.models;

  console.log(`\n${c.bold}${c.blue}@glrs-dev/harness-opencode${c.reset} setup\n`);

  // Show current state
  if (hasPlugin) {
    ok("Plugin already registered");
  }
  if (existingProvider) {
    ok(`Models: ${existingProvider}`);
  }
  if (existingMcps.size > 0) {
    ok(`MCPs: ${[...existingMcps].join(", ")} enabled`);
  }
  if (hasPlugin && (existingProvider || hasModels)) {
    // Everything that can be prompted for is already set.
    // Check if there are unconfigured MCPs to offer.
    const unconfiguredMcps = MCP_TOGGLES.filter(
      (t) => !existingMcps.has(t.name) && !existing?.mcp?.[t.name],
    );
    if (unconfiguredMcps.length === 0) {
      console.log(`\n${c.bold}Ready.${c.reset} Run ${c.green}opencode${c.reset} to start.\n`);
      return;
    }
  }

  // Build the config to merge — always include the plugin entry.
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginEntry],
  };

  // Model provider — only prompt if not already configured.
  if (interactive && !hasModels) {
    console.log();
    console.log(`${c.dim}Models${c.reset}`);
    const presetLabels = [...MODEL_PRESETS.map((p) => p.label), "Keep defaults (Anthropic API)"];
    const choice = await promptChoice(
      "  Which model provider?",
      presetLabels,
      presetLabels.length - 1,
    );

    if (choice < MODEL_PRESETS.length) {
      const preset = MODEL_PRESETS[choice]!;
      (config as any).harness = {
        models: {
          deep: [preset.deep],
          mid: [preset.mid],
          fast: [preset.fast],
        },
      };
      ok(`Models: ${preset.label}`);
    } else {
      ok("Models: Anthropic API defaults");
    }
    console.log();
  }

  // Optional MCPs — only prompt for ones not already configured.
  if (interactive) {
    const unconfigured = MCP_TOGGLES.filter(
      (t) => !existingMcps.has(t.name) && !existing?.mcp?.[t.name],
    );

    if (unconfigured.length > 0) {
      console.log(`${c.dim}Optional MCP servers (serena, memory, git are always on)${c.reset}`);
      const selected = await promptMulti(
        "  Enable additional MCPs?",
        unconfigured.map((t) => ({ label: t.label, defaultOn: t.defaultOn })),
      );

      if (selected.size > 0) {
        const mcp: Record<string, unknown> = {};
        for (const idx of selected) {
          const toggle = unconfigured[idx]!;
          mcp[toggle.name] = { enabled: true };
        }
        (config as any).mcp = mcp;

        const names = [...selected].map((i) => unconfigured[i]!.name).join(", ");
        ok(`MCPs enabled: ${names}`);
      } else {
        ok("MCPs: defaults only");
      }
      console.log();
    }
  }

  // Write to opencode.json
  if (!fs.existsSync(configPath)) {
    if (dryRun) {
      info(`[dry-run] Would create ${configPath}`);
      info(`[dry-run] Config: ${JSON.stringify(config, null, 2)}`);
    } else {
      seedConfig(config as any, configPath);
      ok(`Created ${configPath}`);
    }
  } else {
    try {
      const result = mergeConfig(config as any, configPath, dryRun);
      if (!result.changed) {
        ok("opencode.json is up to date");
        for (const w of result.warnings) warn(w);
      } else {
        if (dryRun) {
          info(`[dry-run] Would merge into ${configPath}:`);
          for (const a of result.additions) info(`  ${a}`);
        } else {
          ok(`Updated ${configPath}`);
          info(`Backup: ${result.bakPath}`);
          for (const a of result.additions) info(`  ${a}`);
        }
        for (const w of result.warnings) warn(w);
      }
    } catch (e: any) {
      console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
      process.exit(1);
    }
  }

  // Ensure the OpenCode plugin cache is up to date. The cache can get
  // stuck on a stale exact pin (e.g. "0.8.0") with no node_modules/,
  // which means the plugin never loads and the in-plugin auto-update
  // never runs — a chicken-and-egg problem. Fix it here.
  if (!dryRun) {
    await refreshPluginCacheIfStale();
  }

  console.log(`\n${c.bold}Ready.${c.reset} Run ${c.green}opencode${c.reset} to start.\n`);
}
