// pilot-plugin.test.ts — coverage for src/plugins/pilot-plugin.ts.
//
// Two surfaces:
//   - Internal helpers exercised directly via `__test__` export (pure).
//   - Plugin hook invocation via a hand-rolled fake client (the hook is
//     async; we await its rejection to assert deny semantics).

import { describe, test, expect } from "bun:test";
import * as path from "node:path";

import pilotPlugin, { __test__ } from "../src/plugins/pilot-plugin.js";

// --- inferPlannerPlansDir --------------------------------------------------

describe("inferPlannerPlansDir", () => {
  test("matches /pilot/plans suffix", () => {
    expect(__test__.inferPlannerPlansDir("/x/y/pilot/plans")).toBe(
      "/x/y/pilot/plans",
    );
  });

  test("matches with trailing slash", () => {
    expect(__test__.inferPlannerPlansDir("/x/y/pilot/plans/")).toBe(
      "/x/y/pilot/plans",
    );
  });

  test("rejects bare 'plans' without 'pilot' parent", () => {
    expect(__test__.inferPlannerPlansDir("/x/y/plans")).toBeNull();
  });

  test("rejects worktree paths (under /pilot/worktrees)", () => {
    expect(
      __test__.inferPlannerPlansDir("/x/y/pilot/worktrees/abc/00"),
    ).toBeNull();
  });

  test("rejects empty string", () => {
    expect(__test__.inferPlannerPlansDir("")).toBeNull();
  });

  test("rejects a single-segment path", () => {
    expect(__test__.inferPlannerPlansDir("plans")).toBeNull();
  });
});

// --- extractBashCommand ----------------------------------------------------

describe("extractBashCommand", () => {
  test("flat shape: {command: '...'}", () => {
    expect(__test__.extractBashCommand({ command: "ls -la" })).toBe("ls -la");
  });

  test("alt key: {cmd: '...'}", () => {
    expect(__test__.extractBashCommand({ cmd: "echo x" })).toBe("echo x");
  });

  test("nested: {body: {command: '...'}}", () => {
    expect(
      __test__.extractBashCommand({ body: { command: "git status" } }),
    ).toBe("git status");
  });

  test("non-string command returns null", () => {
    expect(__test__.extractBashCommand({ command: 42 })).toBeNull();
  });

  test("non-object returns null", () => {
    expect(__test__.extractBashCommand("not-an-object")).toBeNull();
    expect(__test__.extractBashCommand(null)).toBeNull();
    expect(__test__.extractBashCommand(undefined)).toBeNull();
  });
});

// --- enforceBuilderBashDeny ------------------------------------------------

describe("enforceBuilderBashDeny", () => {
  test("allows non-forbidden commands", () => {
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "ls -la" }),
    ).not.toThrow();
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "bun test" }),
    ).not.toThrow();
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "git status" }),
    ).not.toThrow();
  });

  test("denies `git commit` and variants", () => {
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "git commit -m 'msg'" }),
    ).toThrow(/git commit/);
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "  git commit" }), // leading ws
    ).toThrow(/git commit/);
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "git commit-tree HEAD^{tree}" }),
    ).toThrow(); // commit-tree starts with "git commit"
  });

  test("denies `git push` variants", () => {
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "git push origin main" }),
    ).toThrow(/git push/);
  });

  test("denies `git checkout <foo>` (with space)", () => {
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "git checkout main" }),
    ).toThrow(/git checkout/);
    // `git checkout` (no space, no args) is denied because the prefix
    // "git checkout " is matched by trimEnd-equality.
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "git checkout" }),
    ).toThrow();
  });

  test("denies `gh pr` variants", () => {
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "gh pr create" }),
    ).toThrow(/gh pr/);
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "gh pr merge 123" }),
    ).toThrow(/gh pr/);
  });

  test("denies `gh release` variants", () => {
    expect(() =>
      __test__.enforceBuilderBashDeny({ command: "gh release create" }),
    ).toThrow(/gh release/);
  });

  test("denies `git tag`, `git switch`, `git branch`, `git restore --source`, `git reset`", () => {
    for (const cmd of [
      "git tag v1.0",
      "git switch other-branch",
      "git branch -d feature",
      "git restore --source=HEAD~1 file.ts",
      "git reset --hard HEAD~1",
    ]) {
      expect(() => __test__.enforceBuilderBashDeny({ command: cmd })).toThrow();
    }
  });

  test("noop on unparseable args (no command field)", () => {
    expect(() =>
      __test__.enforceBuilderBashDeny({ random: "stuff" }),
    ).not.toThrow();
  });
});

// --- extractTargetPath -----------------------------------------------------

describe("extractTargetPath", () => {
  test("filePath wins", () => {
    expect(__test__.extractTargetPath({ filePath: "/x/y" })).toBe("/x/y");
  });

  test("path field as fallback", () => {
    expect(__test__.extractTargetPath({ path: "/x/y" })).toBe("/x/y");
  });

  test("file field as fallback", () => {
    expect(__test__.extractTargetPath({ file: "/x/y" })).toBe("/x/y");
  });

  test("returns null when nothing matches", () => {
    expect(__test__.extractTargetPath({})).toBeNull();
    expect(__test__.extractTargetPath({ unrelated: 5 })).toBeNull();
    expect(__test__.extractTargetPath(null)).toBeNull();
  });
});

// --- enforcePlannerEditScope ----------------------------------------------

describe("enforcePlannerEditScope", () => {
  const plansDir = "/home/user/.glorious/opencode/repo/pilot/plans";

  test("allows edits inside the plans dir", async () => {
    await expect(
      __test__.enforcePlannerEditScope(
        { filePath: path.join(plansDir, "my-plan.yaml") },
        plansDir,
      ),
    ).resolves.toBeUndefined();
  });

  test("allows nested paths inside the plans dir", async () => {
    await expect(
      __test__.enforcePlannerEditScope(
        { filePath: path.join(plansDir, "nested", "drafts", "x.yaml") },
        plansDir,
      ),
    ).resolves.toBeUndefined();
  });

  test("allows the plans dir itself", async () => {
    await expect(
      __test__.enforcePlannerEditScope({ filePath: plansDir }, plansDir),
    ).resolves.toBeUndefined();
  });

  test("denies edits outside the plans dir", async () => {
    await expect(
      __test__.enforcePlannerEditScope(
        { filePath: "/etc/passwd" },
        plansDir,
      ),
    ).rejects.toThrow(/restricted to the plans directory/);
  });

  test("denies edits to a sibling of plans dir", async () => {
    await expect(
      __test__.enforcePlannerEditScope(
        { filePath: "/home/user/.glorious/opencode/repo/pilot/runs/abc/state.db" },
        plansDir,
      ),
    ).rejects.toThrow();
  });

  test("denies edits to ancestor of plans dir", async () => {
    await expect(
      __test__.enforcePlannerEditScope(
        { filePath: "/home/user/.glorious/opencode/repo/pilot" },
        plansDir,
      ),
    ).rejects.toThrow();
  });

  test("relative paths are resolved against plansDir (allow)", async () => {
    await expect(
      __test__.enforcePlannerEditScope(
        { filePath: "./my-plan.yaml" },
        plansDir,
      ),
    ).resolves.toBeUndefined();
  });

  test("relative path that resolves outside (../) is denied", async () => {
    await expect(
      __test__.enforcePlannerEditScope(
        { filePath: "../../escape.yaml" },
        plansDir,
      ),
    ).rejects.toThrow();
  });

  test("noop when args has no path field", async () => {
    await expect(
      __test__.enforcePlannerEditScope({}, plansDir),
    ).resolves.toBeUndefined();
  });
});

// --- classifySession (with mocked client) ----------------------------------

function makeMockClient(
  responses: Record<string, { title: string; directory: string }>,
) {
  return {
    session: {
      get: async (args: { path: { id: string } }) => {
        const r = responses[args.path.id];
        if (r === undefined) throw new Error("session not found");
        return { data: { ...r, id: args.path.id } };
      },
    },
  } as never;
}

describe("classifySession", () => {
  test("recognizes pilot-builder by title shape pilot/<runId>/<taskId>", async () => {
    const client = makeMockClient({
      ses_b: {
        title: "pilot/01ARZ3NDEKTSV4RRFFQ69G5FAB/T1",
        directory: "/wt/00",
      },
    });
    const cache = new Map();
    const r = await __test__.classifySession(client, cache, "ses_b");
    expect(r.kind).toBe("pilot-builder");
    if (r.kind === "pilot-builder") {
      expect(r.runId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAB");
      expect(r.taskId).toBe("T1");
    }
  });

  test("recognizes pilot-planner by directory ending in /pilot/plans", async () => {
    const client = makeMockClient({
      ses_p: {
        title: "Some random title",
        directory: "/home/x/.glorious/opencode/repo/pilot/plans",
      },
    });
    const cache = new Map();
    const r = await __test__.classifySession(client, cache, "ses_p");
    expect(r.kind).toBe("pilot-planner");
    if (r.kind === "pilot-planner") {
      expect(r.plansDir).toBe(
        "/home/x/.glorious/opencode/repo/pilot/plans",
      );
    }
  });

  test("classifies non-pilot when title has no pilot/ prefix and dir is unrelated", async () => {
    const client = makeMockClient({
      ses_x: { title: "regular session", directory: "/random" },
    });
    const cache = new Map();
    const r = await __test__.classifySession(client, cache, "ses_x");
    expect(r.kind).toBe("non-pilot");
  });

  test("two-segment pilot/ title is classified non-pilot (conservative)", async () => {
    // The worker uses `pilot/<runId>/<taskId>` (3 segments). A session
    // titled `pilot/foo` (2 segments) was probably created by something
    // else — be conservative and treat as non-pilot.
    const client = makeMockClient({
      ses_2: { title: "pilot/something", directory: "/wt" },
    });
    const cache = new Map();
    const r = await __test__.classifySession(client, cache, "ses_2");
    expect(r.kind).toBe("non-pilot");
  });

  test("classification is cached after first lookup", async () => {
    let calls = 0;
    const client = {
      session: {
        get: async () => {
          calls++;
          return {
            data: { title: "pilot/r/t", directory: "/wt" },
          };
        },
      },
    } as never;
    const cache = new Map();
    await __test__.classifySession(client, cache, "ses_c");
    await __test__.classifySession(client, cache, "ses_c");
    await __test__.classifySession(client, cache, "ses_c");
    expect(calls).toBe(1);
  });

  test("classifies non-pilot when client.session.get throws (network blip)", async () => {
    const client = {
      session: {
        get: async () => {
          throw new Error("network");
        },
      },
    } as never;
    const cache = new Map();
    const r = await __test__.classifySession(client, cache, "ses_e");
    expect(r.kind).toBe("non-pilot");
  });
});

// --- Plugin integration: tool.execute.before -------------------------------

describe("plugin.tool.execute.before", () => {
  async function buildHook(
    sessions: Record<string, { title: string; directory: string }>,
  ) {
    const client = makeMockClient(sessions);
    const hooks = await pilotPlugin({
      client,
      directory: "/anywhere",
      // The Plugin signature includes more fields; they're not used by
      // pilot-plugin so we cast.
    } as never);
    if (!hooks["tool.execute.before"]) {
      throw new Error("expected tool.execute.before hook");
    }
    return hooks["tool.execute.before"];
  }

  test("denies forbidden bash command on a pilot-builder session", async () => {
    const hook = await buildHook({
      ses_b: { title: "pilot/r/T1", directory: "/wt" },
    });
    await expect(
      hook(
        { tool: "bash", sessionID: "ses_b", callID: "c1" },
        { args: { command: "git push origin main" } },
      ),
    ).rejects.toThrow(/git push/);
  });

  test("allows benign bash command on a pilot-builder session", async () => {
    const hook = await buildHook({
      ses_b: { title: "pilot/r/T1", directory: "/wt" },
    });
    await expect(
      hook(
        { tool: "bash", sessionID: "ses_b", callID: "c1" },
        { args: { command: "bun test" } },
      ),
    ).resolves.toBeUndefined();
  });

  test("denies edit outside plans dir on a pilot-planner session", async () => {
    const hook = await buildHook({
      ses_p: {
        title: "anything",
        directory: "/home/u/pilot/plans",
      },
    });
    await expect(
      hook(
        { tool: "edit", sessionID: "ses_p", callID: "c1" },
        { args: { filePath: "/etc/passwd" } },
      ),
    ).rejects.toThrow(/restricted to the plans directory/);
  });

  test("allows edit inside plans dir on a pilot-planner session", async () => {
    const hook = await buildHook({
      ses_p: {
        title: "anything",
        directory: "/home/u/pilot/plans",
      },
    });
    await expect(
      hook(
        { tool: "write", sessionID: "ses_p", callID: "c1" },
        { args: { filePath: "/home/u/pilot/plans/my-plan.yaml" } },
      ),
    ).resolves.toBeUndefined();
  });

  test("non-pilot sessions pass through (no enforcement)", async () => {
    const hook = await buildHook({
      ses_x: { title: "user session", directory: "/random" },
    });
    // Even a destructive bash command goes through (the regular agents'
    // permission map is the only wall here; pilot-plugin only acts on
    // pilot sessions).
    await expect(
      hook(
        { tool: "bash", sessionID: "ses_x", callID: "c1" },
        { args: { command: "git push origin main" } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hook(
        { tool: "edit", sessionID: "ses_x", callID: "c2" },
        { args: { filePath: "/etc/passwd" } },
      ),
    ).resolves.toBeUndefined();
  });

  test("pilot-builder edit tools pass through (no scope check on builder)", async () => {
    // The builder's touches enforcement is post-task (in the worker).
    // The plugin doesn't pre-check edit paths for builders — that's the
    // worker's job.
    const hook = await buildHook({
      ses_b: { title: "pilot/r/T1", directory: "/wt" },
    });
    await expect(
      hook(
        { tool: "edit", sessionID: "ses_b", callID: "c1" },
        { args: { filePath: "/some/random/path" } },
      ),
    ).resolves.toBeUndefined();
  });
});
