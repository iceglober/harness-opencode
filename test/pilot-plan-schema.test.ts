// pilot-plan-schema.test.ts — exhaustive schema coverage for the
// `pilot.yaml` Zod schema. No filesystem, no YAML — pure object-in /
// validation-out. Loader/yaml-parsing tests live in
// `pilot-plan-load.test.ts`.
//
// Coverage targets (Phase A1 of PILOT_TODO.md):
//   - minimal valid plan
//   - missing required fields (name, tasks, task.id, task.title, task.prompt)
//   - invalid task IDs (lowercase, leading digit, leading dash, special chars)
//   - unknown agent (not enforced at schema level — agent is just a string;
//     resolution happens at runtime in Phase D / E)
//   - malformed verify entries (empty, non-string)
//   - malformed touches entries (empty, leading slash)
//   - unknown top-level / task / milestone fields rejected (strict mode)
//   - defaults are filled in
//   - per-task overrides preserved
//   - depends_on validation
//   - milestones list

import { describe, test, expect } from "bun:test";
import {
  parsePlan,
  PlanSchema,
  DEFAULT_AGENT,
  DEFAULT_MODEL,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_COST_USD,
} from "../src/pilot/plan/schema.js";

// --- Helpers ---------------------------------------------------------------

function minimalValidPlan() {
  return {
    name: "test plan",
    tasks: [
      {
        id: "T1",
        title: "first task",
        prompt: "do the thing",
      },
    ],
  };
}

function findError(
  errors: Array<{ path: string; message: string }>,
  pathSubstring: string,
) {
  return errors.find((e) => e.path.includes(pathSubstring));
}

// --- Happy-path baseline ---------------------------------------------------

describe("parsePlan — minimal valid plan", () => {
  test("accepts a plan with one task and fills defaults", () => {
    const result = parsePlan(minimalValidPlan());

    if (!result.ok) {
      throw new Error(
        "expected ok=true, got errors: " + JSON.stringify(result.errors, null, 2),
      );
    }

    expect(result.plan.name).toBe("test plan");
    expect(result.plan.tasks).toHaveLength(1);

    // Defaults applied at the top level.
    expect(result.plan.defaults.agent).toBe(DEFAULT_AGENT);
    expect(result.plan.defaults.model).toBe(DEFAULT_MODEL);
    expect(result.plan.defaults.max_turns).toBe(DEFAULT_MAX_TURNS);
    expect(result.plan.defaults.max_cost_usd).toBe(DEFAULT_MAX_COST_USD);
    expect(result.plan.defaults.verify_after_each).toEqual([]);

    // Per-task arrays default to []; overrides are undefined.
    const task = result.plan.tasks[0]!;
    expect(task.touches).toEqual([]);
    expect(task.verify).toEqual([]);
    expect(task.depends_on).toEqual([]);
    expect(task.agent).toBeUndefined();
    expect(task.model).toBeUndefined();
    expect(task.milestone).toBeUndefined();

    // Top-level milestones default empty.
    expect(result.plan.milestones).toEqual([]);
  });

  test("preserves per-task overrides", () => {
    const result = parsePlan({
      name: "overrides",
      defaults: { agent: "pilot-builder", model: "anthropic/claude-sonnet-4-6" },
      tasks: [
        {
          id: "T1",
          title: "override-er",
          prompt: "do it differently",
          agent: "pilot-deep-builder",
          model: "anthropic/claude-opus-4-7",
          max_turns: 100,
          max_cost_usd: 25.0,
          milestone: "M1",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.plan.tasks[0]!;
    expect(t.agent).toBe("pilot-deep-builder");
    expect(t.model).toBe("anthropic/claude-opus-4-7");
    expect(t.max_turns).toBe(100);
    expect(t.max_cost_usd).toBe(25.0);
    expect(t.milestone).toBe("M1");
  });

  test("accepts touches, verify, depends_on lists with valid entries", () => {
    const result = parsePlan({
      name: "lists",
      tasks: [
        { id: "T1", title: "first", prompt: "p" },
        {
          id: "T2",
          title: "second",
          prompt: "p",
          depends_on: ["T1"],
          touches: ["src/api/**", "test/**/*.test.ts"],
          verify: ["bun run typecheck", "bun test test/api.test.ts"],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tasks[1]!.depends_on).toEqual(["T1"]);
    expect(result.plan.tasks[1]!.touches).toEqual(["src/api/**", "test/**/*.test.ts"]);
    expect(result.plan.tasks[1]!.verify).toEqual([
      "bun run typecheck",
      "bun test test/api.test.ts",
    ]);
  });

  test("accepts milestones array with optional description and verify", () => {
    const result = parsePlan({
      name: "with milestones",
      milestones: [
        { name: "M1", description: "Foundation", verify: ["bun run build"] },
        { name: "M2" }, // description and verify both optional
      ],
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.milestones).toHaveLength(2);
    expect(result.plan.milestones[0]!.verify).toEqual(["bun run build"]);
    expect(result.plan.milestones[1]!.verify).toEqual([]); // default
  });

  test("accepts branch_prefix when provided", () => {
    const result = parsePlan({
      ...minimalValidPlan(),
      branch_prefix: "feature/pilot-foo",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.branch_prefix).toBe("feature/pilot-foo");
  });

  test("accepts defaults.verify_after_each", () => {
    const result = parsePlan({
      name: "with run-wide verify",
      defaults: { verify_after_each: ["bun run typecheck"] },
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.defaults.verify_after_each).toEqual(["bun run typecheck"]);
  });
});

// --- Missing required fields -----------------------------------------------

describe("parsePlan — missing required fields", () => {
  test("rejects when top-level `name` is missing", () => {
    const result = parsePlan({
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "name")).toBeDefined();
  });

  test("rejects when `tasks` is missing", () => {
    const result = parsePlan({ name: "no tasks" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks")).toBeDefined();
  });

  test("rejects when `tasks` is empty", () => {
    const result = parsePlan({ name: "empty tasks", tasks: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = findError(result.errors, "tasks");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/at least one task/i);
  });

  test("rejects when a task lacks `id`", () => {
    const result = parsePlan({
      name: "missing id",
      tasks: [{ title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].id")).toBeDefined();
  });

  test("rejects when a task lacks `title`", () => {
    const result = parsePlan({
      name: "missing title",
      tasks: [{ id: "T1", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].title")).toBeDefined();
  });

  test("rejects when a task lacks `prompt`", () => {
    const result = parsePlan({
      name: "missing prompt",
      tasks: [{ id: "T1", title: "t" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].prompt")).toBeDefined();
  });

  test("rejects when task `prompt` is empty string", () => {
    const result = parsePlan({
      name: "empty prompt",
      tasks: [{ id: "T1", title: "t", prompt: "" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].prompt")).toBeDefined();
  });

  test("rejects when task `title` is empty string", () => {
    const result = parsePlan({
      name: "empty title",
      tasks: [{ id: "T1", title: "", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].title")).toBeDefined();
  });
});

// --- Invalid task IDs ------------------------------------------------------

describe("parsePlan — invalid task IDs", () => {
  const invalidIds = [
    ["lowercase", "t1"],
    ["leading digit", "1T"],
    ["leading dash", "-T1"],
    ["special char (dot)", "T.1"],
    ["special char (underscore)", "T_1"],
    ["special char (slash)", "T/1"],
    ["empty string", ""],
    ["whitespace", "T 1"],
  ] as const;

  for (const [label, id] of invalidIds) {
    test(`rejects task ID: ${label} (${JSON.stringify(id)})`, () => {
      const result = parsePlan({
        name: "bad ids",
        tasks: [{ id, title: "t", prompt: "p" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(findError(result.errors, "tasks[0].id")).toBeDefined();
    });
  }

  const validIds = ["T", "T1", "ENG-1234", "PILOT-API-1", "A-B-C-9"] as const;
  for (const id of validIds) {
    test(`accepts task ID: ${JSON.stringify(id)}`, () => {
      const result = parsePlan({
        name: "good ids",
        tasks: [{ id, title: "t", prompt: "p" }],
      });
      expect(result.ok).toBe(true);
    });
  }

  test("rejects depends_on entries that violate the ID pattern", () => {
    const result = parsePlan({
      name: "bad dep id",
      tasks: [
        { id: "T1", title: "t", prompt: "p" },
        { id: "T2", title: "t", prompt: "p", depends_on: ["t1"] }, // lowercase
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[1].depends_on[0]")).toBeDefined();
  });
});

// --- Malformed list entries ------------------------------------------------

describe("parsePlan — malformed verify / touches entries", () => {
  test("rejects empty verify entry", () => {
    const result = parsePlan({
      name: "empty verify",
      tasks: [{ id: "T1", title: "t", prompt: "p", verify: [""] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].verify[0]")).toBeDefined();
  });

  test("rejects non-string verify entry", () => {
    const result = parsePlan({
      name: "bad verify",
      tasks: [{ id: "T1", title: "t", prompt: "p", verify: [42] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].verify[0]")).toBeDefined();
  });

  test("rejects empty touches entry", () => {
    const result = parsePlan({
      name: "empty touches",
      tasks: [{ id: "T1", title: "t", prompt: "p", touches: [""] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].touches[0]")).toBeDefined();
  });

  test("rejects touches entry with leading slash (must be repo-relative)", () => {
    const result = parsePlan({
      name: "abs touches",
      tasks: [{ id: "T1", title: "t", prompt: "p", touches: ["/etc/passwd"] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = findError(result.errors, "tasks[0].touches[0]");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/repo-relative|leading/i);
  });

  test("accepts an empty touches array (verify-only task)", () => {
    const result = parsePlan({
      name: "verify only",
      tasks: [{ id: "T1", title: "no edits", prompt: "p", touches: [] }],
    });
    expect(result.ok).toBe(true);
  });
});

// --- Unknown / extra fields (strict mode) ----------------------------------

describe("parsePlan — strict mode rejects unknown fields", () => {
  test("rejects unknown top-level field", () => {
    const result = parsePlan({
      ...minimalValidPlan(),
      unexpected: "oops",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Zod 4 reports unrecognized_keys at the parent's path with a message
    // like 'Unrecognized key: "unexpected"'. Either the path or the message
    // must reference the offending key.
    expect(
      result.errors.some(
        (e) =>
          e.message.toLowerCase().includes("unrecognized") ||
          e.message.toLowerCase().includes("unknown") ||
          e.message.includes("unexpected") ||
          e.path.includes("unexpected"),
      ),
    ).toBe(true);
  });

  test("rejects unknown task field (catches typos like `dependencies` for `depends_on`)", () => {
    const result = parsePlan({
      name: "typo",
      tasks: [
        {
          id: "T1",
          title: "t",
          prompt: "p",
          dependencies: ["T0"], // typo
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some(
        (e) =>
          e.path.startsWith("tasks[0]") ||
          e.message.toLowerCase().includes("unknown") ||
          e.message.toLowerCase().includes("dependencies"),
      ),
    ).toBe(true);
  });

  test("rejects unknown milestone field", () => {
    const result = parsePlan({
      name: "milestone typo",
      milestones: [{ name: "M1", weird: true }],
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
  });
});

// --- Model spec validation -------------------------------------------------

describe("parsePlan — model spec validation", () => {
  test("rejects model without provider/model separator", () => {
    const result = parsePlan({
      name: "bad model",
      defaults: { model: "claude-sonnet" }, // no slash
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "defaults.model")).toBeDefined();
  });

  test("rejects per-task model without provider/model separator", () => {
    const result = parsePlan({
      name: "bad per-task model",
      tasks: [{ id: "T1", title: "t", prompt: "p", model: "no-slash-here" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(findError(result.errors, "tasks[0].model")).toBeDefined();
  });

  test("accepts well-formed provider/model combos", () => {
    const result = parsePlan({
      name: "good model",
      defaults: { model: "openai/gpt-4o-mini" },
      tasks: [
        { id: "T1", title: "t", prompt: "p", model: "anthropic/claude-opus-4-7" },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

// --- Numeric range validation ----------------------------------------------

describe("parsePlan — numeric range validation", () => {
  test("rejects max_turns of 0", () => {
    const result = parsePlan({
      name: "zero turns",
      defaults: { max_turns: 0 },
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative max_turns", () => {
    const result = parsePlan({
      name: "negative turns",
      defaults: { max_turns: -5 },
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer max_turns", () => {
    const result = parsePlan({
      name: "float turns",
      defaults: { max_turns: 1.5 },
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects zero max_cost_usd", () => {
    const result = parsePlan({
      name: "zero cost",
      defaults: { max_cost_usd: 0 },
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(false);
  });

  test("accepts fractional max_cost_usd", () => {
    const result = parsePlan({
      name: "fractional cost",
      defaults: { max_cost_usd: 0.05 },
      tasks: [{ id: "T1", title: "t", prompt: "p" }],
    });
    expect(result.ok).toBe(true);
  });
});

// --- Path-formatting sanity check (covers formatPath via Zod issue paths) --

describe("parsePlan — error path formatting", () => {
  test("formats nested paths as 'tasks[N].field'", () => {
    const result = parsePlan({
      name: "nested",
      tasks: [
        { id: "T1", title: "t", prompt: "p" },
        { id: "T2", title: "t", prompt: "p", verify: [""] }, // empty verify
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = findError(result.errors, "tasks[1].verify[0]");
    expect(err).toBeDefined();
    expect(err!.path).toMatch(/^tasks\[1\]\.verify\[0\]$/);
  });

  test("formats top-level paths as just the field name", () => {
    const result = parsePlan({ tasks: [{ id: "T1", title: "t", prompt: "p" }] }); // missing name
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = findError(result.errors, "name");
    expect(err).toBeDefined();
    expect(err!.path).toBe("name");
  });
});

// --- PlanSchema export sanity ---------------------------------------------

describe("PlanSchema export", () => {
  test("is a Zod schema (has safeParse)", () => {
    expect(typeof PlanSchema.safeParse).toBe("function");
  });

  test("safeParse on valid plan returns success: true", () => {
    const r = PlanSchema.safeParse(minimalValidPlan());
    expect(r.success).toBe(true);
  });
});
