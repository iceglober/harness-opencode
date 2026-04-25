// pilot-plan-dag.test.ts — DAG validation tests.
//
// Coverage targets (Phase A3 of PILOT_TODO.md):
//   - cycles (simple 2-cycle, 3-cycle, deeper)
//   - self-loops
//   - dangling depends_on
//   - duplicate task IDs
//   - valid linear (T1 → T2 → T3)
//   - valid diamond (T1 → T2, T1 → T3, T2/T3 → T4)
//   - valid disconnected components
//   - tie-breaking honors task-declaration order
//
// Inputs are minimal — we hand-craft Plan-shaped objects (cast as Plan)
// rather than going through the schema. Schema validation lives in
// pilot-plan-schema.test.ts; this file is purely about graph algorithms.

import { describe, test, expect } from "bun:test";
import {
  validateDag,
  formatDagError,
  type DagError,
} from "../src/pilot/plan/dag.js";
import type { Plan, PlanTask } from "../src/pilot/plan/schema.js";

// --- Helpers ---------------------------------------------------------------

/**
 * Build a minimal Plan object for DAG tests. Every task gets boilerplate
 * fields (title, prompt, etc.) that the schema would normally fill in
 * via defaults.
 */
function makePlan(
  taskSpecs: Array<{ id: string; depends_on?: string[] }>,
): Plan {
  const tasks: PlanTask[] = taskSpecs.map((s) => ({
    id: s.id,
    title: `task ${s.id}`,
    prompt: "do it",
    touches: [],
    verify: [],
    depends_on: s.depends_on ?? [],
  }));
  return {
    name: "test plan",
    defaults: {
      model: "anthropic/claude-sonnet-4-6",
      agent: "pilot-builder",
      max_turns: 50,
      max_cost_usd: 5,
      verify_after_each: [],
    },
    milestones: [],
    tasks,
  };
}

function expectErr<K extends DagError["kind"]>(
  errors: ReadonlyArray<DagError>,
  kind: K,
): Extract<DagError, { kind: K }> {
  const found = errors.find((e) => e.kind === kind);
  if (!found) {
    throw new Error(
      `expected error of kind ${JSON.stringify(kind)}, got: ` +
        JSON.stringify(errors, null, 2),
    );
  }
  return found as Extract<DagError, { kind: K }>;
}

// --- Valid DAGs ------------------------------------------------------------

describe("validateDag — valid DAGs", () => {
  test("single task with no deps", () => {
    const r = validateDag(makePlan([{ id: "T1" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.topo).toEqual(["T1"]);
  });

  test("linear chain T1 → T2 → T3", () => {
    const r = validateDag(
      makePlan([
        { id: "T1" },
        { id: "T2", depends_on: ["T1"] },
        { id: "T3", depends_on: ["T2"] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.topo).toEqual(["T1", "T2", "T3"]);
  });

  test("diamond T1 → T2/T3 → T4", () => {
    const r = validateDag(
      makePlan([
        { id: "T1" },
        { id: "T2", depends_on: ["T1"] },
        { id: "T3", depends_on: ["T1"] },
        { id: "T4", depends_on: ["T2", "T3"] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // T1 first, T4 last. T2 and T3 in declaration order between them.
    expect(r.topo[0]).toBe("T1");
    expect(r.topo[r.topo.length - 1]).toBe("T4");
    expect(new Set(r.topo)).toEqual(new Set(["T1", "T2", "T3", "T4"]));
    // Stable: T2 declared before T3 so should appear first.
    expect(r.topo.indexOf("T2")).toBeLessThan(r.topo.indexOf("T3"));
  });

  test("disconnected components — each independent task in declared order", () => {
    const r = validateDag(
      makePlan([
        { id: "A1" },
        { id: "B1" },
        { id: "A2", depends_on: ["A1"] },
        { id: "B2", depends_on: ["B1"] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Topo must respect within-component order; A1 before A2, B1 before B2.
    expect(r.topo.indexOf("A1")).toBeLessThan(r.topo.indexOf("A2"));
    expect(r.topo.indexOf("B1")).toBeLessThan(r.topo.indexOf("B2"));
    // Across components: declared first comes first when in-degree zero.
    expect(r.topo.indexOf("A1")).toBeLessThan(r.topo.indexOf("B1"));
  });

  test("tie-breaking respects declared task order, not alphabetical", () => {
    // Z declared before A but both have no deps — Z should come first.
    const r = validateDag(makePlan([{ id: "Z" }, { id: "A" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.topo).toEqual(["Z", "A"]);
  });

  test("multi-dep task — order respects all preds", () => {
    const r = validateDag(
      makePlan([
        { id: "T1" },
        { id: "T2" },
        { id: "T3", depends_on: ["T1", "T2"] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.topo.indexOf("T1")).toBeLessThan(r.topo.indexOf("T3"));
    expect(r.topo.indexOf("T2")).toBeLessThan(r.topo.indexOf("T3"));
  });
});

// --- Self-loops ------------------------------------------------------------

describe("validateDag — self-loops", () => {
  test("rejects T1 → T1", () => {
    const r = validateDag(makePlan([{ id: "T1", depends_on: ["T1"] }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = expectErr(r.errors, "self-loop");
    expect(err.id).toBe("T1");
  });

  test("reports multiple self-loops", () => {
    const r = validateDag(
      makePlan([
        { id: "T1", depends_on: ["T1"] },
        { id: "T2", depends_on: ["T2"] },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const loops = r.errors.filter((e) => e.kind === "self-loop");
    expect(loops).toHaveLength(2);
  });
});

// --- Dangling deps ---------------------------------------------------------

describe("validateDag — dangling deps", () => {
  test("rejects depends_on referencing a non-existent task", () => {
    const r = validateDag(
      makePlan([
        { id: "T1" },
        { id: "T2", depends_on: ["DOES_NOT_EXIST"] },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = expectErr(r.errors, "dangling-dep");
    expect(err.from).toBe("T2");
    expect(err.missing).toBe("DOES_NOT_EXIST");
  });

  test("reports all dangling deps for one task", () => {
    const r = validateDag(
      makePlan([
        { id: "T1" },
        { id: "T2", depends_on: ["GHOST1", "GHOST2"] },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const dangling = r.errors.filter((e) => e.kind === "dangling-dep");
    expect(dangling).toHaveLength(2);
  });

  test("reports dangling deps across multiple tasks", () => {
    const r = validateDag(
      makePlan([
        { id: "T1", depends_on: ["GHOST1"] },
        { id: "T2", depends_on: ["GHOST2"] },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const dangling = r.errors.filter((e) => e.kind === "dangling-dep");
    expect(dangling).toHaveLength(2);
  });
});

// --- Duplicate IDs ---------------------------------------------------------

describe("validateDag — duplicate IDs", () => {
  test("rejects two tasks with the same id", () => {
    const r = validateDag(makePlan([{ id: "T1" }, { id: "T1" }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = expectErr(r.errors, "duplicate-id");
    expect(err.id).toBe("T1");
    expect(err.indexes).toEqual([0, 1]);
  });

  test("reports all groups when several IDs are duplicated", () => {
    const r = validateDag(
      makePlan([
        { id: "T1" },
        { id: "T2" },
        { id: "T1" },
        { id: "T2" },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const dupes = r.errors.filter((e) => e.kind === "duplicate-id");
    expect(dupes).toHaveLength(2);
  });

  test("3-way duplicate gets all 3 indexes", () => {
    const r = validateDag(
      makePlan([{ id: "T1" }, { id: "T1" }, { id: "T1" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = expectErr(r.errors, "duplicate-id");
    expect(err.indexes).toEqual([0, 1, 2]);
  });

  test("does NOT run cycle detection when duplicates exist", () => {
    // If both T1's referenced each other, naive cycle detection might
    // false-positive. We intentionally skip cycle detection when
    // duplicates are present so the output is dominated by the
    // root-cause errors.
    const r = validateDag(
      makePlan([
        { id: "T1", depends_on: ["T2"] },
        { id: "T1", depends_on: ["T2"] },
        { id: "T2" },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const dupes = r.errors.filter((e) => e.kind === "duplicate-id");
    const cycles = r.errors.filter((e) => e.kind === "cycle");
    expect(dupes).toHaveLength(1);
    expect(cycles).toHaveLength(0);
  });
});

// --- Cycles ---------------------------------------------------------------

describe("validateDag — cycles", () => {
  test("rejects 2-cycle T1 ↔ T2", () => {
    const r = validateDag(
      makePlan([
        { id: "T1", depends_on: ["T2"] },
        { id: "T2", depends_on: ["T1"] },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = expectErr(r.errors, "cycle");
    expect(err.path.length).toBeGreaterThanOrEqual(2);
    // Both nodes must appear in the cycle path.
    expect(err.path).toContain("T1");
    expect(err.path).toContain("T2");
  });

  test("rejects 3-cycle T1 → T2 → T3 → T1", () => {
    const r = validateDag(
      makePlan([
        { id: "T1", depends_on: ["T3"] },
        { id: "T2", depends_on: ["T1"] },
        { id: "T3", depends_on: ["T2"] },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const err = expectErr(r.errors, "cycle");
    expect(new Set(err.path)).toEqual(new Set(["T1", "T2", "T3"]));
  });

  test("formatDagError renders a cycle path with arrows", () => {
    const r = validateDag(
      makePlan([
        { id: "T1", depends_on: ["T2"] },
        { id: "T2", depends_on: ["T1"] },
      ]),
    );
    if (r.ok) throw new Error("expected error");
    const err = expectErr(r.errors, "cycle");
    const msg = formatDagError(err);
    expect(msg).toMatch(/cycle/);
    expect(msg).toMatch(/→/);
  });

  test("cycle in a subgraph leaves the rest of the topo unverified", () => {
    // Even with a clean component (T3 alone), the cycle in T1↔T2
    // makes the WHOLE plan invalid.
    const r = validateDag(
      makePlan([
        { id: "T1", depends_on: ["T2"] },
        { id: "T2", depends_on: ["T1"] },
        { id: "T3" },
      ]),
    );
    expect(r.ok).toBe(false);
  });

  test("cycle detection skipped when dangling deps are present", () => {
    // With a dangling dep, the graph is malformed; we don't run cycle
    // detection. Surface the dangling first.
    const r = validateDag(
      makePlan([
        { id: "T1", depends_on: ["T2"] },
        { id: "T2", depends_on: ["GHOST"] },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.kind === "dangling-dep")).toBe(true);
    expect(r.errors.some((e) => e.kind === "cycle")).toBe(false);
  });
});

// --- formatDagError --------------------------------------------------------

describe("formatDagError — message rendering", () => {
  test("self-loop", () => {
    expect(formatDagError({ kind: "self-loop", id: "T1" })).toMatch(
      /T1.*depends on itself/,
    );
  });

  test("duplicate-id with indexes", () => {
    const msg = formatDagError({
      kind: "duplicate-id",
      id: "T1",
      indexes: [0, 2, 5],
    });
    expect(msg).toMatch(/duplicate/);
    expect(msg).toMatch(/T1/);
    expect(msg).toMatch(/0.*2.*5/);
  });

  test("dangling-dep", () => {
    const msg = formatDagError({
      kind: "dangling-dep",
      from: "T2",
      missing: "GHOST",
    });
    expect(msg).toMatch(/T2/);
    expect(msg).toMatch(/GHOST/);
    expect(msg).toMatch(/missing/);
  });

  test("cycle", () => {
    const msg = formatDagError({
      kind: "cycle",
      path: ["T1", "T2", "T3"],
    });
    expect(msg).toMatch(/T1 → T2 → T3 → T1/);
  });
});
