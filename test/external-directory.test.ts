import { describe, it, expect } from "bun:test";
import { applyConfig } from "../src/config-hook.js";

describe("applyConfig — external_directory defaults", () => {
  it("applyConfig is importable from src/index.ts", () => {
    expect(typeof applyConfig).toBe("function");
  });

  it("applyConfig adds tmp and tmpdir to external_directory", () => {
    const config: any = {};
    applyConfig(config);
    const extDir = config.permission?.external_directory ?? {};
    expect(extDir["~/.glorious/worktrees/**"]).toBe("allow");
    expect(extDir["/tmp/**"]).toBe("allow");
    expect(extDir["/private/tmp/**"]).toBe("allow");
    expect(extDir["/var/folders/**/T/**"]).toBe("allow");
  });

  it("applyConfig adds XDG dirs to external_directory", () => {
    // Agents routinely read ~/.config/opencode (plugin config), ~/.cache
    // (tooling caches like npm/pip), and ~/.local/share (MCP data, etc.).
    // Prompting on these is pure friction — user already has access.
    const config: any = {};
    applyConfig(config);
    const extDir = config.permission?.external_directory ?? {};
    expect(extDir["~/.config/opencode/**"]).toBe("allow");
    expect(extDir["~/.cache/**"]).toBe("allow");
    expect(extDir["~/.local/share/**"]).toBe("allow");
  });

  it("applyConfig allows ~/.glorious/opencode/** for repo-shared plan storage", () => {
    // The plan-storage migration moved plans out of per-worktree
    // `$WORKTREE/.agent/plans/` into `~/.glorious/opencode/<repo>/plans/`.
    // Without this entry agents hit a permission prompt every time they
    // read or write a plan file, which breaks the lights-out autopilot
    // flow. See `src/plan-paths.ts` for the storage-shape contract.
    const config: any = {};
    applyConfig(config);
    const extDir = config.permission?.external_directory ?? {};
    expect(extDir["~/.glorious/opencode/**"]).toBe("allow");
  });

  it("user external_directory values win over plugin defaults", () => {
    const config: any = {
      permission: {
        external_directory: {
          "/tmp/**": "deny", // user explicitly clamps scratch
          "~/.cache/**": "deny", // user explicitly clamps cache
          "~/.glorious/opencode/**": "deny", // user clamps plan storage too
          "/custom/path/**": "allow",
        },
      },
    };
    applyConfig(config);
    const extDir = config.permission.external_directory;
    // User's denies win over our allows
    expect(extDir["/tmp/**"]).toBe("deny");
    expect(extDir["~/.cache/**"]).toBe("deny");
    expect(extDir["~/.glorious/opencode/**"]).toBe("deny");
    // Our defaults that the user didn't override still present
    expect(extDir["~/.glorious/worktrees/**"]).toBe("allow");
    expect(extDir["/private/tmp/**"]).toBe("allow");
    expect(extDir["/var/folders/**/T/**"]).toBe("allow");
    expect(extDir["~/.config/opencode/**"]).toBe("allow");
    expect(extDir["~/.local/share/**"]).toBe("allow");
    // User's custom entry preserved
    expect(extDir["/custom/path/**"]).toBe("allow");
  });
});
