import type { Plugin } from "@opencode-ai/plugin";

const plugin: Plugin = async ({ $, client }) => {
  async function notify(title: string, message: string) {
    if (process.platform === "darwin") {
      const esc = (s: string) => s.replace(/"/g, '\\"');
      await $`osascript -e ${`display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`}`.nothrow();
    } else if (process.platform === "linux") {
      await $`notify-send ${title} ${message}`.nothrow();
    }
    // Windows: no-op for now.

    // In-TUI toast — useful when terminal is focused but user is in another tab.
    try {
      await client.tui.showToast({
        body: { title, message, variant: "info", duration: 8000 },
      });
    } catch {
      // Headless (opencode run) has no TUI — non-fatal.
    }
  }

  return {
    // Notify when a permission prompt fires (replaces the old permission.asked event)
    "permission.ask": async (input, output) => {
      const tool = (input as any)?.tool ?? (input as any)?.title ?? "a tool";
      await notify("opencode permission required", `Approval needed for ${tool}.`);
    },
  };
};

export default plugin;
