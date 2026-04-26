// pilot-opencode-prompts.test.ts — substring/snapshot coverage for
// src/pilot/opencode/prompts.ts.
//
// We assert on substrings rather than exact snapshots. Two reasons:
//   - Exact snapshots break on tiny prose tweaks; the prompts will
//     evolve as we learn what the agent actually pays attention to.
//   - The invariants that matter (hard rules present, STOP protocol
//     described, scope spelled out, prompt verbatim) are exactly
//     what substring tests can pin down.

import { describe, test, expect } from "bun:test";

import {
  kickoffPrompt,
  fixPrompt,
  type RunContext,
  type LastFailure,
} from "../src/pilot/opencode/prompts.js";
import type { PlanTask } from "../src/pilot/plan/schema.js";

// --- Helpers ---------------------------------------------------------------

function makeTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: overrides.id ?? "T1",
    title: overrides.title ?? "Add hello world",
    prompt: overrides.prompt ?? "Add a hello-world function and a test for it.",
    touches: overrides.touches ?? ["src/hello.ts", "test/hello.test.ts"],
    verify: overrides.verify ?? ["bun test test/hello.test.ts"],
    depends_on: overrides.depends_on ?? [],
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    ...(overrides.agent !== undefined ? { agent: overrides.agent } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.max_turns !== undefined ? { max_turns: overrides.max_turns } : {}),
    ...(overrides.max_cost_usd !== undefined ? { max_cost_usd: overrides.max_cost_usd } : {}),
    ...(overrides.milestone !== undefined ? { milestone: overrides.milestone } : {}),
  };
}

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    planName: overrides.planName ?? "Pilot Test Plan",
    branch: overrides.branch ?? "pilot/test/T1",
    worktreePath: overrides.worktreePath ?? "/tmp/pilot/wt/00",
    milestone: overrides.milestone,
    verifyAfterEach: overrides.verifyAfterEach ?? [],
    verifyMilestone: overrides.verifyMilestone ?? [],
  };
}

// --- kickoffPrompt ---------------------------------------------------------

describe("kickoffPrompt — structure and required content", () => {
  test("includes header with task id and title", () => {
    const out = kickoffPrompt(makeTask({ id: "ENG-7", title: "Refactor X" }), makeCtx());
    expect(out).toMatch(/Pilot task: ENG-7 — Refactor X/);
  });

  test("includes the plan name", () => {
    const out = kickoffPrompt(makeTask(), makeCtx({ planName: "Big Plan" }));
    expect(out).toMatch(/"Big Plan"/);
  });

  test("includes worktree path and branch", () => {
    const out = kickoffPrompt(
      makeTask(),
      makeCtx({ worktreePath: "/x/y/z", branch: "pilot/foo/T9" }),
    );
    expect(out).toContain("/x/y/z");
    expect(out).toContain("pilot/foo/T9");
  });

  test("mentions DO NOT commit/push/PR", () => {
    const out = kickoffPrompt(makeTask(), makeCtx());
    expect(out).toMatch(/commit/i);
    expect(out).toMatch(/push/i);
    expect(out).toMatch(/PR/i);
    expect(out).toMatch(/DO NOT/i);
  });

  test("mentions DO NOT ask questions (unattended invariant)", () => {
    const out = kickoffPrompt(makeTask(), makeCtx());
    expect(out).toMatch(/DO NOT ask|clarif/i);
  });

  test("describes the STOP protocol", () => {
    const out = kickoffPrompt(makeTask(), makeCtx());
    expect(out).toMatch(/STOP:/);
    expect(out).toMatch(/STOP protocol|FIRST non-whitespace line/i);
  });

  test("lists the touches globs verbatim", () => {
    const out = kickoffPrompt(
      makeTask({ touches: ["src/api/**", "test/**/*.test.ts"] }),
      makeCtx(),
    );
    expect(out).toContain("`src/api/**`");
    expect(out).toContain("`test/**/*.test.ts`");
  });

  test("calls out empty touches as a verify-only task", () => {
    const out = kickoffPrompt(makeTask({ touches: [] }), makeCtx());
    expect(out).toMatch(/verify-only|must NOT edit/i);
  });

  test("lists task.verify commands and notes the worker runs them", () => {
    const out = kickoffPrompt(
      makeTask({ verify: ["bun run typecheck", "bun test"] }),
      makeCtx(),
    );
    expect(out).toContain("bun run typecheck");
    expect(out).toContain("bun test");
    expect(out).toMatch(/exit zero|all must|after you finish/i);
  });

  test("appends defaults.verify_after_each to the verify list with a footnote", () => {
    const out = kickoffPrompt(
      makeTask({ verify: ["echo task-verify"] }),
      makeCtx({ verifyAfterEach: ["bun run typecheck", "bun run lint"] }),
    );
    expect(out).toContain("echo task-verify");
    expect(out).toContain("bun run typecheck");
    expect(out).toContain("bun run lint");
    expect(out).toMatch(/run after every task/i);
  });

  test("appends milestone-level verify when provided", () => {
    const out = kickoffPrompt(
      makeTask({ verify: ["v1"], milestone: "M1" }),
      makeCtx({
        milestone: "M1",
        verifyMilestone: ["bun run integration-test"],
      }),
    );
    expect(out).toContain("v1");
    expect(out).toContain("bun run integration-test");
    // Milestone label appears in the framing.
    expect(out).toMatch(/milestone.*M1/i);
  });

  test("includes the task prompt verbatim (preserves multi-line)", () => {
    const prompt = "Step 1: do A.\nStep 2: do B.\n\nNotes:\n- foo\n- bar\n";
    const out = kickoffPrompt(makeTask({ prompt }), makeCtx());
    expect(out).toContain("Step 1: do A.");
    expect(out).toContain("Step 2: do B.");
    expect(out).toContain("- foo");
    expect(out).toContain("- bar");
  });

  test("mentions reading repo-conventions docs (AGENTS.md / CLAUDE.md / README)", () => {
    const out = kickoffPrompt(makeTask(), makeCtx());
    expect(out).toMatch(/AGENTS\.md/i);
  });

  test("notes the agent should NOT switch branches", () => {
    const out = kickoffPrompt(makeTask(), makeCtx());
    expect(out).toMatch(/DO NOT switch branches|switch branches/i);
  });

  test("verify section explains 'no verify' case clearly", () => {
    const out = kickoffPrompt(makeTask({ verify: [] }), makeCtx());
    expect(out).toMatch(/No verify commands|without protest/i);
  });
});

// --- kickoffPrompt: optional context section -----------------------------

describe("kickoffPrompt — context section", () => {
  test("omits the context section when task.context is undefined", () => {
    const out = kickoffPrompt(makeTask(), makeCtx());
    expect(out).not.toMatch(/^## Context$/m);
  });

  test("omits the context section when task.context is empty string", () => {
    const out = kickoffPrompt(makeTask({ context: "" }), makeCtx());
    expect(out).not.toMatch(/^## Context$/m);
  });

  test("omits the context section when task.context is whitespace-only", () => {
    const out = kickoffPrompt(makeTask({ context: "   \n\n  " }), makeCtx());
    expect(out).not.toMatch(/^## Context$/m);
  });

  test("emits the context section with trimmed body when context is non-empty", () => {
    const out = kickoffPrompt(
      makeTask({
        context:
          "\n\n## Outcome\n\nUser can now type `pilot build <name>` without typing the absolute path.\n\n## Code pointers\n\n- src/pilot/cli/build.ts: resolvePlanPath (lines 350-370)\n\n",
      }),
      makeCtx(),
    );
    expect(out).toMatch(/^## Context$/m);
    expect(out).toMatch(/User can now type `pilot build <name>`/);
    expect(out).toMatch(/src\/pilot\/cli\/build\.ts/);
    // Body should be trimmed — no trailing whitespace block.
    expect(out).not.toMatch(/\n\n\n+$/);
  });

  test("context section appears BEFORE the final ## Task directive", () => {
    const out = kickoffPrompt(
      makeTask({ context: "SOME_CONTEXT_MARKER" }),
      makeCtx(),
    );
    const ctxIdx = out.indexOf("## Context");
    const taskIdx = out.indexOf("## Task");
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeLessThan(taskIdx);
  });

  test("context section appears AFTER the verify block (reading order: rules → scope → verify → context → task)", () => {
    const out = kickoffPrompt(
      makeTask({ context: "SOME_CONTEXT_MARKER" }),
      makeCtx(),
    );
    const verifyIdx = out.indexOf("## Verify commands");
    const ctxIdx = out.indexOf("## Context");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeGreaterThan(verifyIdx);
  });
});

// --- fixPrompt -------------------------------------------------------------

describe("fixPrompt — verify-failure path", () => {
  test("quotes the failed command and exit code", () => {
    const last: LastFailure = {
      command: "bun test",
      exitCode: 7,
      output: "1 test failed: Expected 'foo', got 'bar'",
    };
    const out = fixPrompt(makeTask(), last);
    expect(out).toContain("bun test");
    expect(out).toContain("code 7");
  });

  test("quotes the output verbatim inside a code fence", () => {
    const last: LastFailure = {
      command: "bun test",
      exitCode: 1,
      output: "FAIL test/x.test.ts\n  expect(a).toBe(b)\n    Expected: 1\n    Received: 2",
    };
    const out = fixPrompt(makeTask(), last);
    expect(out).toContain("Expected: 1");
    expect(out).toContain("Received: 2");
    expect(out).toContain("```");
  });

  test("re-states the STOP protocol", () => {
    const out = fixPrompt(makeTask(), {
      command: "bun test",
      exitCode: 1,
      output: "fail",
    });
    expect(out).toMatch(/STOP:/);
  });

  test("re-states no-commit / no-questions invariants", () => {
    const out = fixPrompt(makeTask(), {
      command: "x",
      exitCode: 1,
      output: "y",
    });
    expect(out).toMatch(/Do NOT commit/i);
    expect(out).toMatch(/Do NOT ask|questions/i);
  });
});

describe("fixPrompt — touches-violation path", () => {
  test("uses a different framing when violators are provided", () => {
    const out = fixPrompt(makeTask(), {
      command: "n/a",
      exitCode: 0,
      output: "",
      touchesViolators: ["src/web/leak.ts"],
    });
    expect(out).toMatch(/out-of-scope edits/i);
    expect(out).toContain("src/web/leak.ts");
    // It should NOT include the verify-failure framing.
    expect(out).not.toMatch(/exited with code/i);
  });

  test("lists every violator", () => {
    const out = fixPrompt(makeTask(), {
      command: "n/a",
      exitCode: 0,
      output: "",
      touchesViolators: ["a.ts", "b.ts", "deeply/nested/c.ts"],
    });
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
    expect(out).toContain("deeply/nested/c.ts");
  });

  test("hints that reverting may itself require a STOP if it conflicts with the task", () => {
    const out = fixPrompt(makeTask(), {
      command: "n/a",
      exitCode: 0,
      output: "",
      touchesViolators: ["x"],
    });
    expect(out).toMatch(/STOP/);
  });
});

// --- determinism / purity --------------------------------------------------

describe("prompt purity", () => {
  test("kickoffPrompt is deterministic for the same input", () => {
    const t = makeTask();
    const c = makeCtx();
    expect(kickoffPrompt(t, c)).toBe(kickoffPrompt(t, c));
  });

  test("fixPrompt is deterministic for the same input", () => {
    const t = makeTask();
    const last: LastFailure = {
      command: "bun test",
      exitCode: 1,
      output: "fail",
    };
    expect(fixPrompt(t, last)).toBe(fixPrompt(t, last));
  });
});
