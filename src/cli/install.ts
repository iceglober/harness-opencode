/**
 * `glrs-oc install-plugin` / `glrs-oc install`
 *
 * Interactive plugin installer. When run in a TTY, walks the user through:
 *   1. Plugin registration (always)
 *   2. Model provider selection (Anthropic direct, AWS Bedrock, or custom)
 *   3. MCP server toggles (playwright, linear)
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

  console.log(`\n${c.bold}${c.blue}@glrs-dev/harness-opencode${c.reset} setup\n`);

  // Step 1: Build the config to merge
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginEntry],
  };

  // Step 2: Model provider (interactive only)
  if (interactive) {
    console.log(`${c.dim}Models${c.reset}`);
    const presetLabels = [...MODEL_PRESETS.map((p) => p.label), "Keep defaults (Anthropic API)"];
    const choice = await promptChoice(
      "  Which model provider?",
      presetLabels,
      presetLabels.length - 1, // default: keep defaults
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

  // Step 3: Optional MCPs (interactive only)
  if (interactive && MCP_TOGGLES.length > 0) {
    console.log(`${c.dim}Optional MCP servers (serena, memory, git are always on)${c.reset}`);
    const selected = await promptMulti(
      "  Enable additional MCPs?",
      MCP_TOGGLES.map((t) => ({ label: t.label, defaultOn: t.defaultOn })),
    );

    if (selected.size > 0) {
      const mcp: Record<string, unknown> = {};
      for (const idx of selected) {
        const toggle = MCP_TOGGLES[idx]!;
        mcp[toggle.name] = { enabled: true };
      }
      (config as any).mcp = mcp;

      const names = [...selected].map((i) => MCP_TOGGLES[i]!.name).join(", ");
      ok(`MCPs enabled: ${names}`);
    } else {
      ok("MCPs: defaults only (serena, memory, git)");
    }
    console.log();
  }

  // Step 4: Write to opencode.json
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
        ok("opencode.json is up to date — nothing to change");
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

  // Step 5: Next steps
  console.log(`
${c.bold}Ready.${c.reset} Run ${c.green}opencode${c.reset} to start.
`);
}
