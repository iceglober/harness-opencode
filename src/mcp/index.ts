import type { Config } from "@opencode-ai/plugin";

type McpConfig = NonNullable<Config["mcp"]>;

/**
 * Returns the MCP server configuration block.
 *
 * Ports the current opencode.json `mcp` block verbatim.
 *
 * The `memory` MCP uses the bundled memory-mcp-launcher.sh resolved at
 * MCP-spawn time via require.resolve (CJS context inside the bash -c
 * invocation, not the ESM plugin context). This preserves the per-worktree
 * cwd-walking behavior of the original launcher.
 */
export function createMcpConfig(): McpConfig {
  // The memory launcher path is resolved at MCP-spawn time by the bash -c
  // command, so we embed a node -e snippet that resolves it dynamically.
  // This avoids hardcoding the npm cache path.
  const memoryLauncherCmd = [
    "bash",
    "-c",
    // Use node's require.resolve to find the bundled launcher inside the
    // installed package, then exec it. Works because the MCP command runs
    // in a CJS-compatible shell context.
    "exec bash \"$(node -e 'process.stdout.write(require.resolve(\"@glrs-dev/harness-opencode/dist/bin/memory-mcp-launcher.sh\"))')\"",
  ];

  return {
    serena: {
      type: "local",
      command: [
        "uvx",
        "--from",
        "git+https://github.com/oraios/serena",
        "serena",
        "start-mcp-server",
        "--context=ide-assistant",
        "--open-web-dashboard",
        "false",
      ],
      enabled: true,
    },
    memory: {
      type: "local",
      command: memoryLauncherCmd,
      enabled: true,
    },
    git: {
      type: "local",
      command: ["uvx", "mcp-server-git"],
      enabled: true,
    },
    playwright: {
      type: "local",
      command: ["npx", "-y", "@playwright/mcp"],
      enabled: false,
    },
    linear: {
      type: "remote",
      url: "https://mcp.linear.app/mcp",
      enabled: false,
    },
  } as unknown as McpConfig;
}
