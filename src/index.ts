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

import type { Plugin, Config, Hooks } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createAgents } from "./agents/index.js";
import { createCommands } from "./commands/index.js";
import { createMcpConfig } from "./mcp/index.js";
import { createTools } from "./tools/index.js";
import { getSkillsRoot } from "./skills/paths.js";

// Sub-plugins (autopilot completion loop + OS notifications + cost tracking)
import autopilotPlugin from "./plugins/autopilot.js";
import notifyPlugin from "./plugins/notify.js";
import costTrackerPlugin from "./plugins/cost-tracker.js";

// ---- Update notification ----

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PACKAGE_NAME = "@glrs-dev/harness-opencode";
const BUNDLED_VERSION = "0.1.2"; // updated by release pipeline

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
      try {
        await client.tui.showToast({
          body: {
            title: `${PACKAGE_NAME} ${latest} available`,
            message: `You have ${BUNDLED_VERSION}. Run: bun update ${PACKAGE_NAME}`,
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

// ---- Config hook ----

export function applyConfig(config: Config): void {
  // Agents: user-wins (user's opencode.json overrides our defaults)
  const ourAgents = createAgents();
  (config as any).agent = { ...ourAgents, ...((config as any).agent ?? {}) };

  // Commands: user-wins
  const ourCommands = createCommands();
  (config as any).command = {
    ...ourCommands,
    ...((config as any).command ?? {}),
  };

  // MCPs: user-wins (merge non-destructively)
  const ourMcp = createMcpConfig();
  (config as any).mcp = { ...ourMcp, ...((config as any).mcp ?? {}) };

  // Skills: push our bundled path first (plugin-wins on name collision)
  const skillsRoot = getSkillsRoot();
  const existingSkills = (config as any).skills ?? {};
  const existingPaths: string[] = Array.isArray(existingSkills.paths)
    ? existingSkills.paths
    : [];
  const existingUrls: string[] = Array.isArray(existingSkills.urls)
    ? existingSkills.urls
    : [];
  (config as any).skills = {
    ...existingSkills,
    paths: [skillsRoot, ...existingPaths],
    urls: existingUrls,
  };

  // Default agent
  if (!(config as any).default_agent) {
    (config as any).default_agent = "orchestrator";
  }

  // Permission: global defaults (non-destructive merge, user-wins)
  const existingPermission = (config as any).permission ?? {};
  const existingExtDir = existingPermission.external_directory ?? {};
  const existingBash = existingPermission.bash;
  (config as any).permission = {
    // Our defaults first — user's existing values spread last to win
    bash: existingBash ?? {
      // Allow everything non-destructive; deny/ask only for dangerous ops.
      // Last matching rule wins, so put "*" first.
      "*": "allow",
      "git push --force*": "deny",
      "git push --force-with-lease*": "allow",   // safe force — re-allow after --force* deny
      "git push -f *": "deny",
      "git push * --force*": "deny",
      "git push * --force-with-lease*": "allow",
      "git push * -f": "deny",
      "git clean *": "deny",
      "git reset --hard*": "ask",
      "rm -rf /*": "deny",
      "rm -rf ~*": "deny",
      "chmod *": "deny",
      "chown *": "deny",
      "sudo *": "deny",
    },
    ...existingPermission,
    external_directory: {
      "~/.glorious/worktrees/**": "allow",
      "/tmp/**": "allow",
      "/private/tmp/**": "allow",          // macOS: /tmp symlinks to /private/tmp
      "/var/folders/**/T/**": "allow",     // macOS $TMPDIR expansion
      "~/.config/opencode/**": "allow",    // OpenCode's own config dir — agents read it routinely
      "~/.cache/**": "allow",              // XDG cache dir — tooling (npm, pip, etc.) writes here
      "~/.local/share/**": "allow",        // XDG data dir — Linear MCP cache, etc.
      ...existingExtDir,
    },
  };
}

// ---- Plugin entry ----

const plugin: Plugin = async (input) => {
  // Fire update check in background (non-blocking)
  checkForUpdate(input.client).catch(() => {});

  // Load sub-plugins
  const autopilotHooks = await autopilotPlugin(input);
  const notifyHooks = await notifyPlugin(input);
  const costTrackerHooks = await costTrackerPlugin(input);

  // Merge all hooks
  const hooks: Hooks = {
    // Config hook: register agents, commands, MCPs, skills
    config: async (config) => {
      applyConfig(config);
      // Let sub-plugins also mutate config if they need to
      if (autopilotHooks.config) await autopilotHooks.config(config);
      if (notifyHooks.config) await notifyHooks.config(config);
      if (costTrackerHooks.config) await costTrackerHooks.config(config);
    },

    // Custom tools
    tool: createTools(),

    // Event handlers from sub-plugins
    event: async (input) => {
      if (autopilotHooks.event) await autopilotHooks.event(input);
      if (notifyHooks.event) await notifyHooks.event(input);
      if (costTrackerHooks.event) await costTrackerHooks.event(input);
    },

    // chat.params from autopilot (drives the completion-promise loop)
    "chat.params": autopilotHooks["chat.params"],

    // chat.message from autopilot
    "chat.message": autopilotHooks["chat.message"],

    // Compaction hook from autopilot
    "experimental.session.compacting":
      autopilotHooks["experimental.session.compacting"],
  };

  return hooks;
};

export default plugin;
