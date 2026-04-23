import { describe, it, expect } from "bun:test";
import plugin from "../src/index.js";

/**
 * Regression test for the catastrophic startup crash where the plugin
 * returned a hooks object with `undefined` values for optional hook keys
 * (e.g. `"chat.params": undefined` because the autopilot sub-plugin never
 * defines a chat.params hook). OpenCode's plugin loader iterated over
 * the returned hooks object by key and dereferenced each value —
 * `undefined.config` / `undefined.length` throws inside the minified
 * bundle as `TypeError: undefined is not an object (evaluating 'M.config')`,
 * which cascaded into `S.auth` / provider-init failures and prevented
 * the TUI from bootstrapping at all.
 *
 * Enforce: every key present in the returned hooks object has a
 * DEFINED value. Omit keys instead of leaving them undefined.
 */
describe("plugin hooks shape", () => {
  const fakeInput = {
    client: { tui: { showToast: async () => {} } },
    project: { id: "test", worktree: "/tmp/x", vcsDir: "/tmp/x" },
    directory: "/tmp/x",
    worktree: "/tmp/x",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:3000"),
    $: null,
  };

  it("no returned hook key has an `undefined` value", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks = await plugin(fakeInput as any);
    const entries = Object.entries(hooks);
    for (const [k, v] of entries) {
      expect(v, `hook "${k}" is undefined — will crash OpenCode's loader`).not.toBeUndefined();
    }
  });

  it("required hooks (config, tool, event) are always present", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks = await plugin(fakeInput as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = hooks as any;
    expect(typeof h.config).toBe("function");
    expect(typeof h.tool).toBe("object");
    expect(typeof h.event).toBe("function");
  });

  it("chat.message is wired through when autopilot sub-plugin defines it", async () => {
    // autopilot defines chat.message (to intercept completion promises)
    // but does NOT define chat.params or experimental.session.compacting.
    // The former must be present with a defined value; the latter two
    // must be absent entirely (not present with an undefined value).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks = (await plugin(fakeInput as any)) as Record<string, unknown>;
    expect(typeof hooks["chat.message"]).toBe("function");
    // The following must NOT exist as own-properties with undefined values.
    for (const key of ["chat.params", "experimental.session.compacting"]) {
      if (key in hooks) {
        expect(
          hooks[key],
          `${key} exists as an own-property but is undefined — this is the crash bug`,
        ).not.toBeUndefined();
      }
    }
  });
});
