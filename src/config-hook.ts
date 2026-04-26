/**
 * Config-hook implementation for the OpenCode plugin.
 *
 * Extracted from `src/index.ts` so that tests can import `applyConfig`
 * directly without forcing `src/index.ts` to carry any named exports
 * beyond the plugin default.
 *
 * Context / why this file exists: OpenCode's plugin loader was observed
 * to crash at startup with
 *
 *     TypeError: undefined is not an object (evaluating 'V[G]')
 *
 * inside its minified bundle whenever `src/index.ts` (the module
 * registered via `opencode.json → plugin: ["@glrs-dev/harness-opencode"]`)
 * exposed ANY named export in addition to the `default` plugin factory.
 * The loader appears to probe named exports looking for `PluginModule`-
 * shaped re-exports (`{ id?, server, tui? }`) and fails hard when it
 * encounters a plain function or a non-hook object.
 *
 * We intentionally keep `src/index.ts` to a single `export default`, and
 * tests import `applyConfig` from this file. tsup builds this as a
 * separate chunk (`dist/config-hook.js`), but since nothing in the plugin
 * runtime imports it under an OpenCode-reachable name, the loader never
 * sees it. Regression test: `test/plugin-entry-single-default-export.test.ts`.
 */

import type { Config, PluginOptions } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createAgents, AGENT_TIERS } from "./agents/index.js";
import type { AgentConfig } from "@opencode-ai/sdk";
import { createCommands } from "./commands/index.js";
import { createMcpConfig } from "./mcp/index.js";
import { getSkillsRoot } from "./skills/paths.js";
import { readOurPackageVersion } from "./auto-update.js";

/**
 * Diagnostic probe — dumps every agent's final `permission` block to
 * a JSON file when `HARNESS_OPENCODE_PERM_DEBUG=1`. Silent and zero-
 * overhead when the env var is unset.
 *
 * Writes to `$XDG_STATE_HOME/harness-opencode/perm-debug.json`, falling
 * back to `~/.local/state/harness-opencode/perm-debug.json`. Wrapped in
 * try/catch — the probe MUST NOT break plugin startup if the write
 * fails for any reason.
 *
 * The previous two attempts at fixing the bash-prompt bug shipped
 * without a way to verify the fix from the user's actual machine. This
 * probe is the verification instrument: if the fix works, the snapshot
 * shape matches the source; if prompts still fire despite a correct
 * snapshot, the bug is elsewhere and we have concrete evidence instead
 * of another speculative cycle.
 */
export function writePermDebugSnapshot(config: Config): void {
  if (process.env["HARNESS_OPENCODE_PERM_DEBUG"] !== "1") return;

  try {
    const stateDir =
      process.env["XDG_STATE_HOME"] ||
      path.join(os.homedir(), ".local", "state");
    const targetDir = path.join(stateDir, "harness-opencode");
    const targetFile = path.join(targetDir, "perm-debug.json");

    const version = readOurPackageVersion(import.meta.url);
    const agentBlock = (config as any).agent ?? {};
    const agentPerms: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(agentBlock)) {
      agentPerms[name] = (cfg as any)?.permission ?? null;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      pluginVersion: version,
      agents: Object.keys(agentBlock),
      agentPermissions: agentPerms,
      // Include the global permission block too — useful context when
      // diagnosing interplay between global and per-agent rules.
      globalPermission: (config as any).permission ?? null,
    };

    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2));
  } catch {
    // Probe is best-effort. Never let it break plugin startup.
  }
}

/**
 * Resolve `models` tier/per-agent overrides onto an agent map.
 *
 * Model config is read from plugin options (the second element of the
 * `["@glrs-dev/harness-opencode", { models: {...} }]` tuple in
 * opencode.json). Falls back to the legacy `config.harness.models`
 * top-level key for backward compatibility (that key is now rejected
 * by OpenCode's schema, but a user on an older OpenCode version may
 * still have it).
 *
 * Precedence (first match wins):
 *   1. `options.models.<agent-name>` — per-agent override
 *   2. `options.models.<tier>`       — tier-level override
 *   3. (no change)                   — plugin default from createAgents()
 *
 * Values may be a single string or an array of strings (fallback chain).
 * v1 uses the first element only; the array shape is forward-compatible
 * with runtime fallback in a future version.
 *
 * Mutates `agents` in place — returns the same reference for convenience.
 */
export function resolveHarnessModels(
  agents: Record<string, AgentConfig>,
  config: Config,
  pluginOptions?: PluginOptions,
): Record<string, AgentConfig> {
  // Prefer plugin options; fall back to legacy top-level harness key.
  const modelsConfig = (pluginOptions?.models ??
    (config as any).harness?.models) as
    | Record<string, string | string[]>
    | undefined;
  if (!modelsConfig) return agents;

  for (const [agentName, agentCfg] of Object.entries(agents)) {
    // 1. Per-agent override
    const perAgent = modelsConfig[agentName];
    if (perAgent !== undefined) {
      agentCfg.model = Array.isArray(perAgent) ? perAgent[0] : perAgent;
      continue;
    }

    // 2. Tier override
    const tier = AGENT_TIERS[agentName];
    if (tier) {
      const perTier = modelsConfig[tier];
      if (perTier !== undefined) {
        agentCfg.model = Array.isArray(perTier) ? perTier[0] : perTier;
      }
    }
    // 3. No match — plugin default stays
  }

  return agents;
}

export function applyConfig(config: Config, pluginOptions?: PluginOptions): void {
  // Agents: build from prompts, apply model overrides from plugin options,
  // then user-wins spread (user's opencode.json agent overrides take final
  // precedence).
  const ourAgents = createAgents();
  resolveHarnessModels(ourAgents, config, pluginOptions);
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
    (config as any).default_agent = "prime";
  }

  // Permission: global defaults (non-destructive merge, user-wins)
  //
  // We intentionally do NOT set a global `permission.bash` rule-map. An
  // upstream object-form map was observed to misfire under OpenCode's
  // permission resolution — when an agent declared `bash: "allow"` as a
  // scalar (qa-reviewer, qa-thorough, autopilot-verifier), trivial
  // read-only commands like `git branch --show-current` would still
  // trigger ask-prompts, apparently because the runtime re-evaluates
  // the global pattern map rather than honoring the agent-level scalar
  // as final. See commits c9a288d (first attempted fix) and the fix
  // that split this file off.
  //
  // Destructive-command safety is preserved at two other layers that
  // remain intact:
  //   1. Each primary agent (prime, build) ships its own
  //      object-form bash rule-map with explicit denies for `rm -rf`,
  //      `sudo`, `chmod`, `chown`, `git push --force`, `git push main`,
  //      etc. See PRIME_PERMISSIONS / BUILD_PERMISSIONS in
  //      src/agents/index.ts.
  //   2. Every agent's system prompt forbids destructive operations
  //      explicitly. The QA reviewers are read-only by role and would
  //      never reach for these commands under normal operation.
  //
  // Subagents without their own bash map (plan-reviewer, code-searcher,
  // gap-analyzer, architecture-advisor, lib-reader) set `bash: "deny"`
  // in their agent config, which shuts bash off entirely for them.
  const existingPermission = (config as any).permission ?? {};
  const existingExtDir = existingPermission.external_directory ?? {};
  (config as any).permission = {
    ...existingPermission,
    external_directory: {
      "~/.glorious/worktrees/**": "allow",
      "~/.glorious/opencode/**": "allow",  // repo-shared plan storage (see src/plan-paths.ts) + cost-tracker data
      "/tmp/**": "allow",
      "/private/tmp/**": "allow",          // macOS: /tmp symlinks to /private/tmp
      "/var/folders/**/T/**": "allow",     // macOS $TMPDIR expansion
      "~/.config/opencode/**": "allow",    // OpenCode's own config dir — agents read it routinely
      "~/.config/crush/**": "allow",       // sibling AI tool config — agents read it routinely
      "~/.cache/**": "allow",              // XDG cache dir — tooling (npm, pip, etc.) writes here
      "~/.local/share/**": "allow",        // XDG data dir — Linear MCP cache, etc.
      "~/.local/state/**": "allow",        // XDG state dir — includes plugin spill at harness-opencode/tool-output/ and perm-debug.json
      ...existingExtDir,
    },
  };

  // Diagnostic probe — silent unless HARNESS_OPENCODE_PERM_DEBUG=1.
  // Runs at the end of applyConfig so the snapshot captures the final
  // permission shape every agent will ship to OpenCode.
  writePermDebugSnapshot(config);
}
