/**
 * @glrs-dev/harness-opencode — OpenCode plugin entry point.
 *
 * Registers agents, commands, MCPs, tools, and skills at runtime via the
 * OpenCode plugin `config` hook. Zero filesystem writes to user space.
 *
 * Skills are registered by pushing the bundled dist/skills/ directory onto
 * config.skills.paths. OpenCode's scanner processes hardcoded paths first,
 * then config.skills.paths last — so plugin-bundled skills win on name
 * collision (plugin-wins precedence, empirically verified in Spike 1).
 *
 * Agents, commands, and MCPs use user-wins precedence:
 *   input.agent = { ...ourAgents, ...(input.agent ?? {}) }
 * so user's opencode.json overrides take effect.
 */

import type { Plugin, Hooks, PluginOptions } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// CRITICAL: do NOT add named exports to this file. OpenCode's plugin loader
// was observed to crash at startup (`TypeError: undefined is not an object
// (evaluating 'V[G]')` inside its minified bundle) whenever this module
// exposed anything besides `export default`. Keep config-hook logic in
// ./config-hook.ts and tool-factory logic in ./tools/, and import them
// here as internals. Regression: test/plugin-entry-single-default-export.test.ts.
import { applyConfig } from "./config-hook.js";
import { createTools } from "./tools/index.js";
import {
  PACKAGE_NAME,
  readOurPackageVersion,
  refreshPluginCache,
} from "./auto-update.js";

// Dotenv loader — injects .env / .env.local into process.env before MCP
// config interpolation resolves {env:VAR} references.
import { loadDotenv } from "./plugins/dotenv.js";

// Sub-plugins (autopilot idle-nudge loop + OS notifications + cost tracking
// + pilot subsystem runtime guards + tool output middleware)
import autopilotPlugin from "./plugins/autopilot.js";
import notifyPlugin from "./plugins/notify.js";
import costTrackerPlugin from "./plugins/cost-tracker.js";
import pilotPlugin from "./plugins/pilot-plugin.js";
import toolHooksPlugin from "./plugins/tool-hooks.js";

// ---- Update notification ----

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The version we're running as. Read at module load from our own
 * package.json so the release pipeline doesn't have to patch a constant.
 * Drift-proof — the source of truth is one file.
 */
const BUNDLED_VERSION = readOurPackageVersion(import.meta.url);

function getUpdateCheckStatePath(): string {
  const cacheHome =
    process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache");
  return path.join(
    cacheHome,
    "harness-opencode",
    "update-check.json",
  );
}

async function checkForUpdate(client: any): Promise<void> {
  if (process.env["HARNESS_OPENCODE_UPDATE_CHECK"] === "0") return;

  const statePath = getUpdateCheckStatePath();

  // Rate-limit: once per 24h
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const state = JSON.parse(raw) as { last_check_ts: number };
    if (Date.now() - state.last_check_ts < UPDATE_CHECK_INTERVAL_MS) return;
  } catch {
    // No state file yet — proceed
  }

  // Fetch latest version from npm registry (3s timeout)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { signal: controller.signal },
    );
    clearTimeout(timer);

    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;

    // Write state regardless of whether we notify
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({ last_check_ts: Date.now() }),
    );

    if (latest && latest !== BUNDLED_VERSION) {
      // Attempt to self-heal the OpenCode plugin cache so the next restart
      // picks up the new version. Best-effort — any failure degrades
      // gracefully to the old "inform the user, they restart" path.
      const refresh = await refreshPluginCache(BUNDLED_VERSION, latest).catch(
        (err) => ({
          outcome: "error" as const,
          message: (err as Error).message,
          fromVersion: BUNDLED_VERSION,
          toVersion: latest,
        }),
      );

      const toastMessage =
        refresh.outcome === "refreshed"
          ? `You have ${BUNDLED_VERSION}. Next OpenCode restart will auto-update.`
          : refresh.outcome === "disabled"
            ? `You have ${BUNDLED_VERSION}. Auto-update disabled; restart to pick up the new version (cache may need refresh).`
            : refresh.outcome === "non-exact-pin"
              ? `You have ${BUNDLED_VERSION}. Cache uses a custom version spec — run: bun update ${PACKAGE_NAME}`
              : // cache-missing / not-our-package / already-current / error
                `You have ${BUNDLED_VERSION}. Restart OpenCode to refresh (${refresh.outcome}).`;

      try {
        await client.tui.showToast({
          body: {
            title: `${PACKAGE_NAME} ${latest} available`,
            message: toastMessage,
            variant: "info",
            duration: 8000,
          },
        });
      } catch {
        // Headless — no-op
      }
    }
  } catch {
    // Network error or abort — silently skip
  }
}

// ---- Plugin entry ----

const plugin: Plugin = async (input, options) => {
  // Plugin options come from the opencode.json tuple:
  //   "plugin": [["@glrs-dev/harness-opencode", { models: {...}, toolHooks: {...} }]]
  // This is where users configure model tiers and tool-hooks behavior.
  // The options object is passed through to config-hook and sub-plugins.
  const pluginOptions = options ?? {};

  // Load .env / .env.local into process.env before anything else —
  // MCP config {env:VAR} interpolation reads process.env, so this must
  // run before sub-plugins and before OpenCode resolves MCP server config.
  loadDotenv(input.directory);

  // Fire update check in background (non-blocking)
  checkForUpdate(input.client).catch(() => {});

  // Load sub-plugins
  const autopilotHooks = await autopilotPlugin(input);
  const notifyHooks = await notifyPlugin(input);
  const costTrackerHooks = await costTrackerPlugin(input);
  const pilotHooks = await pilotPlugin(input);
  const toolHooks = await toolHooksPlugin(input, pluginOptions);

  // Merge all hooks.
  //
  // Defensively omit hook keys whose values are `undefined` — some
  // OpenCode loader paths iterate returned hooks by key and would
  // dereference an undefined slot. Prior release cycles chased two
  // related-looking errors (`M.config` / `S.auth` / `V[G]` inside the
  // minified OpenCode bundle) to this shape before the real culprit —
  // a non-default named export on this file — was identified. Keeping
  // the hooks object shape tight is cheap correctness insurance either
  // way.
  const hooks: Hooks = {
    // Config hook: register agents, commands, MCPs, skills
    config: async (config) => {
      applyConfig(config, pluginOptions);
      // Let sub-plugins also mutate config if they need to
      if (autopilotHooks.config) await autopilotHooks.config(config);
      if (notifyHooks.config) await notifyHooks.config(config);
      if (costTrackerHooks.config) await costTrackerHooks.config(config);
      if (toolHooks.config) await toolHooks.config(config);
    },

    // Custom tools
    tool: createTools(),

    // Event handlers from sub-plugins
    event: async (input) => {
      if (autopilotHooks.event) await autopilotHooks.event(input);
      if (notifyHooks.event) await notifyHooks.event(input);
      if (costTrackerHooks.event) await costTrackerHooks.event(input);
    },
  };

  // Only attach optional sub-hooks when they actually exist. Leaving
  // `hook["chat.params"] = undefined` would blow up OpenCode's loader
  // (see comment above).
  if (autopilotHooks["chat.params"] !== undefined) {
    hooks["chat.params"] = autopilotHooks["chat.params"];
  }
  if (autopilotHooks["chat.message"] !== undefined) {
    hooks["chat.message"] = autopilotHooks["chat.message"];
  }
  if (autopilotHooks["experimental.session.compacting"] !== undefined) {
    hooks["experimental.session.compacting"] =
      autopilotHooks["experimental.session.compacting"];
  }

  // tool.execute.before — pilot-plugin enforces pilot-builder bash
  // denies and pilot-planner edit-path scoping. Wrap so the throw the
  // pilot plugin emits propagates up to opencode's tool runner (which
  // turns it into a tool-result error visible to the agent).
  if (pilotHooks["tool.execute.before"] !== undefined) {
    hooks["tool.execute.before"] = pilotHooks["tool.execute.before"];
  }

  // tool.execute.after — tool-hooks sub-plugin provides backpressure,
  // post-edit verification, loop detection, and read deduplication.
  if (toolHooks["tool.execute.after"] !== undefined) {
    hooks["tool.execute.after"] = toolHooks["tool.execute.after"];
  }

  return hooks;
};

export default plugin;
