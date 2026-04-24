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

import type { Config } from "@opencode-ai/plugin";

import { createAgents } from "./agents/index.js";
import { createCommands } from "./commands/index.js";
import { createMcpConfig } from "./mcp/index.js";
import { getSkillsRoot } from "./skills/paths.js";

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
  //   1. Each primary agent (orchestrator, build) ships its own
  //      object-form bash rule-map with explicit denies for `rm -rf`,
  //      `sudo`, `chmod`, `chown`, `git push --force`, `git push main`,
  //      etc. See ORCHESTRATOR_PERMISSIONS / BUILD_PERMISSIONS in
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
      "~/.cache/**": "allow",              // XDG cache dir — tooling (npm, pip, etc.) writes here
      "~/.local/share/**": "allow",        // XDG data dir — Linear MCP cache, etc.
      ...existingExtDir,
    },
  };
}
