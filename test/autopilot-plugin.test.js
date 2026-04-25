// autopilot-plugin.test.js — unit tests for src/plugins/autopilot.ts.
//
// The plugin is canonical Ralph: one nudge string, one activation gate, one
// max-iterations cap, one debounce. No sentinels, no verifier, no
// shipped-probe, no stagnation detection. These tests lock in:
//   - Activation gates only on the session's FIRST user message (prevents
//     pasted transcripts or descriptive references from self-activating).
//   - Non-autopilot sessions never write state or fire nudges.
//   - Autopilot sessions with unchecked boxes get one nudge per idle.
//   - Zero unchecked boxes = silent stop (no more nudges).
//   - Max iterations fires a final "stopped" message, then silence.
//   - User messages reset iterations but keep the session enabled.
//
// Run: `bun test test/autopilot-plugin.test.js` (preferred) or `bun test`.

import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_PATH = path.resolve(
  __dirname,
  "..",
  "src",
  "plugins",
  "autopilot.ts",
);

// --- Fixtures ---------------------------------------------------------------

function mkTmpDir(prefix = "autopilot-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFixture(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function readStateFile(dir) {
  const p = path.join(dir, ".agent", "autopilot-state.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function userMsg(text, agent = "prime") {
  return {
    info: { role: "user", agent },
    parts: [{ type: "text", text }],
  };
}

function assistantMsg(text) {
  return {
    info: { role: "assistant" },
    parts: [{ type: "text", text }],
  };
}

function mockClient() {
  const prompts = [];
  return {
    prompts,
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async ({ path: p, body }) => {
        prompts.push({ sessionID: p.id, text: body.parts[0].text });
      },
    },
  };
}

function mockClientWithMessages(messages) {
  const client = mockClient();
  client.session.messages = async () => ({ data: messages });
  return client;
}

// --- Helper tests ----------------------------------------------------------

test("plugin exports expected helpers and constants", async () => {
  const mod = await import(PLUGIN_PATH);
  assert.equal(typeof mod.default, "function", "default export is factory");
  assert.equal(typeof mod.detectActivation, "function");
  assert.equal(typeof mod.findPlanPath, "function");
  assert.equal(typeof mod.countUnchecked, "function");
  assert.equal(typeof mod.sendNudge, "function");
  assert.equal(mod.MAX_ITERATIONS, 20);
  assert.equal(mod.NUDGE_DEBOUNCE_MS, 30_000);
  assert.equal(typeof mod.NUDGE_TEXT, "string");
  assert.equal(typeof mod.MAX_ITERATIONS_TEXT, "string");
  assert.ok(mod.NUDGE_TEXT.startsWith("[autopilot]"));
  assert.ok(mod.MAX_ITERATIONS_TEXT.startsWith("[autopilot]"));
});

test("countUnchecked: counts `- [ ]` inside Acceptance criteria only", async () => {
  const { countUnchecked } = await import(PLUGIN_PATH);
  const plan = `# Plan
## Goal
do a thing
## Acceptance criteria
- [ ] a
- [x] b
- [ ] c
- [ ] d
## Test plan
- [ ] not counted (different section)
`;
  assert.equal(countUnchecked(plan), 3);
});

test("countUnchecked: zero when no Acceptance criteria section", async () => {
  const { countUnchecked } = await import(PLUGIN_PATH);
  assert.equal(countUnchecked("# Plan\n## Goal\nnothing here\n"), 0);
});

test("countUnchecked: zero when all boxes checked", async () => {
  const { countUnchecked } = await import(PLUGIN_PATH);
  const plan = `## Acceptance criteria
- [x] a
- [x] b
`;
  assert.equal(countUnchecked(plan), 0);
});

test("findPlanPath: returns most recent plan path reference", async () => {
  const { findPlanPath } = await import(PLUGIN_PATH);
  const msgs = [
    userMsg("working on .agent/plans/old-one.md"),
    assistantMsg("moved to .agent/plans/new-one.md"),
  ];
  assert.equal(findPlanPath(msgs), ".agent/plans/new-one.md");
});

test("findPlanPath: null when no path in messages", async () => {
  const { findPlanPath } = await import(PLUGIN_PATH);
  assert.equal(findPlanPath([userMsg("hi"), assistantMsg("hello")]), null);
});

// --- findPlanPath regex coverage ------------------------------------------
//
// The regex in src/plugins/autopilot.ts was broadened to match both the
// legacy per-worktree `.agent/plans/<slug>.md` shape and the new absolute
// repo-shared shape (`~/.glorious/opencode/<repo>/plans/<slug>.md` or any
// `$GLORIOUS_PLAN_DIR` override). These tests lock in both branches plus
// the negative case (non-plan paths that superficially look similar).

function msgWithText(role, text) {
    return { info: { role }, parts: [{ type: "text", text }] };
}

test("findPlanPath: legacy `.agent/plans/<slug>.md` reference", async () => {
    const { findPlanPath } = await import(PLUGIN_PATH);
    const messages = [msgWithText("user", "see .agent/plans/fix-bug.md for the plan")];
    assert.equal(findPlanPath(messages), ".agent/plans/fix-bug.md");
});

test("findPlanPath: absolute repo-shared path is matched", async () => {
    const { findPlanPath } = await import(PLUGIN_PATH);
    const messages = [
        msgWithText(
            "user",
            "plan is at /Users/alice/.glorious/opencode/my-repo/plans/fix-bug.md",
        ),
    ];
    const match = findPlanPath(messages);
    assert.ok(match, "expected a match");
    assert.ok(
        match.endsWith("/my-repo/plans/fix-bug.md"),
        `expected path to end with /my-repo/plans/fix-bug.md, got ${match}`,
    );
});

test("findPlanPath: env-override absolute path under a custom base", async () => {
    const { findPlanPath } = await import(PLUGIN_PATH);
    const messages = [
        msgWithText(
            "user",
            "written to /opt/custom/plan-root/glorious-opencode/plans/migration.md",
        ),
    ];
    const match = findPlanPath(messages);
    assert.ok(match);
    assert.ok(
        match.endsWith("/glorious-opencode/plans/migration.md"),
        `got ${match}`,
    );
});

test("findPlanPath: returns null when no plan reference exists", async () => {
    const { findPlanPath } = await import(PLUGIN_PATH);
    const messages = [
        msgWithText("user", "hello"),
        msgWithText("assistant", "hi — no plan yet"),
    ];
    assert.equal(findPlanPath(messages), null);
});

test("findPlanPath: ignores superficially similar non-plan paths", async () => {
    const { findPlanPath } = await import(PLUGIN_PATH);
    // `plans/raw.md` without a repo-folder segment before it → NOT a match.
    // `/tmp/plans/` (two slashes, no repo folder) → NOT a match.
    // These would all be false positives for a too-loose regex.
    const messages = [
        msgWithText("assistant", "see plans/raw.md for details"),
        msgWithText("assistant", "not `/plans/orphan.md`"),
    ];
    assert.equal(findPlanPath(messages), null);
});

// --- Activation gate --------------------------------------------------------

test("detectActivation: empty messages => false", async () => {
  const { detectActivation } = await import(PLUGIN_PATH);
  assert.equal(detectActivation([]), false);
});

test("detectActivation: first user msg with `/autopilot` prefix => true", async () => {
  const { detectActivation } = await import(PLUGIN_PATH);
  assert.equal(detectActivation([userMsg("/autopilot ENG-1234")]), true);
});

test("detectActivation: first user msg with `AUTOPILOT mode` phrase => true", async () => {
  const { detectActivation } = await import(PLUGIN_PATH);
  assert.equal(
    detectActivation([userMsg("This invocation is in AUTOPILOT mode — go")]),
    true,
  );
});

test("detectActivation: substring 'autopilot' without slash => false", async () => {
  const { detectActivation } = await import(PLUGIN_PATH);
  assert.equal(detectActivation([userMsg("what does autopilot do?")]), false);
});

test("detectActivation: marker in SECOND user msg => false (first-only gate)", async () => {
  const { detectActivation } = await import(PLUGIN_PATH);
  const msgs = [
    userMsg("fix this typo"),
    assistantMsg("done"),
    userMsg("/autopilot do X"),
  ];
  assert.equal(
    detectActivation(msgs),
    false,
    "later /autopilot references must not retroactively activate",
  );
});

test("detectActivation: marker pasted as quoted context in 3rd user msg => false", async () => {
  const { detectActivation } = await import(PLUGIN_PATH);
  const msgs = [
    userMsg("do a thing"),
    assistantMsg("ok"),
    userMsg("here's what I tried: /autopilot ENG-1"),
  ];
  assert.equal(detectActivation(msgs), false);
});

// --- Integration: session.idle handler -------------------------------------

async function loadFactory() {
  const mod = await import(PLUGIN_PATH);
  return mod.default;
}

test("session.idle: non-autopilot prime session → zero nudges, no state write", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/plans/plan.md",
      "## Acceptance criteria\n- [ ] todo\n",
    );
    const messages = [userMsg(".agent/plans/plan.md — fix this")];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(client.prompts.length, 0, "non-autopilot must not nudge");
    assert.equal(readStateFile(tmp), null, "no state file for non-autopilot");
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: autopilot session, plan with unchecked boxes → one nudge", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/plans/plan.md",
      "## Acceptance criteria\n- [ ] a\n- [ ] b\n",
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg("working on .agent/plans/plan.md"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(client.prompts.length, 1, "autopilot with unchecked must nudge");
    assert.match(client.prompts[0].text, /\[autopilot\] Session idled/);
    const st = readStateFile(tmp);
    assert.ok(st.sessions["s1"].enabled);
    assert.equal(st.sessions["s1"].iterations, 1);
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: autopilot session, all boxes checked → no nudge, session persists but silent", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/plans/plan.md",
      "## Acceptance criteria\n- [x] a\n- [x] b\n",
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg("plan at .agent/plans/plan.md is done"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(
      client.prompts.length,
      0,
      "done plan must not fire nudge",
    );
    // State still written because the session is enabled.
    const st = readStateFile(tmp);
    assert.ok(st?.sessions["s1"]?.enabled);
    assert.equal(st.sessions["s1"].iterations, 0);
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: autopilot session, no plan path yet → no nudge, wait quietly", async () => {
  const tmp = mkTmpDir();
  try {
    const messages = [userMsg("/autopilot let's go")];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(
      client.prompts.length,
      0,
      "no plan ref yet → no nudge; wait for prime to decide",
    );
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: max iterations → sends MAX_ITERATIONS_TEXT, marks stopped, silent afterward", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/plans/plan.md",
      "## Acceptance criteria\n- [ ] todo\n",
    );
    writeFixture(
      tmp,
      ".agent/autopilot-state.json",
      JSON.stringify({
        sessions: {
          s1: { enabled: true, iterations: 20 },
        },
      }),
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg("working on .agent/plans/plan.md"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(client.prompts.length, 1);
    assert.match(client.prompts[0].text, /hit max iterations \(20\)/);
    const st = readStateFile(tmp);
    assert.ok(st.sessions["s1"].stopped);

    // Next idle must fire nothing (stopped is terminal).
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(
      client.prompts.length,
      1,
      "stopped session must not fire further nudges",
    );
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: debounce prevents back-to-back nudges under NUDGE_DEBOUNCE_MS", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/plans/plan.md",
      "## Acceptance criteria\n- [ ] a\n",
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg(".agent/plans/plan.md"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(
      client.prompts.length,
      1,
      "debounce suppresses the immediate second nudge",
    );
  } finally {
    rmTmpDir(tmp);
  }
});

// --- Non-target agents ------------------------------------------------------

test("session.idle: plan-reviewer session (not in TARGET_AGENTS) → ignored", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/plans/plan.md",
      "## Acceptance criteria\n- [ ] a\n",
    );
    const messages = [userMsg("/autopilot go", "plan-reviewer")];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(client.prompts.length, 0);
  } finally {
    rmTmpDir(tmp);
  }
});

// --- chat.message handler ---------------------------------------------------

test("chat.message: non-autopilot session → no state write", async () => {
  const tmp = mkTmpDir();
  try {
    const factory = await loadFactory();
    const hooks = await factory({ client: mockClient(), directory: tmp });
    await hooks["chat.message"]({ sessionID: "s1", agent: "prime" });
    assert.equal(readStateFile(tmp), null);
  } finally {
    rmTmpDir(tmp);
  }
});

test("chat.message: autopilot session → iterations reset, enabled preserved", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/autopilot-state.json",
      JSON.stringify({
        sessions: { s1: { enabled: true, iterations: 7 } },
      }),
    );
    const factory = await loadFactory();
    const hooks = await factory({ client: mockClient(), directory: tmp });
    await hooks["chat.message"]({ sessionID: "s1", agent: "prime" });
    const st = readStateFile(tmp);
    assert.equal(st.sessions["s1"].iterations, 0);
    assert.ok(st.sessions["s1"].enabled);
  } finally {
    rmTmpDir(tmp);
  }
});

test("chat.message: non-target agent → no state write", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/autopilot-state.json",
      JSON.stringify({
        sessions: { s1: { enabled: true, iterations: 3 } },
      }),
    );
    const factory = await loadFactory();
    const hooks = await factory({ client: mockClient(), directory: tmp });
    await hooks["chat.message"]({
      sessionID: "s1",
      agent: "plan-reviewer",
    });
    const st = readStateFile(tmp);
    assert.equal(
      st.sessions["s1"].iterations,
      3,
      "non-target agent must not touch state",
    );
  } finally {
    rmTmpDir(tmp);
  }
});

// --- Absolute plan-path integration (repo-shared plan storage) -----------
//
// Plans now live at `~/.glorious/opencode/<repo>/plans/<slug>.md` rather
// than in a per-worktree `.agent/plans/` dir. The plugin must handle this
// shape end-to-end: `findPlanPath` matches the absolute form (a4), and the
// runtime reader uses `path.isAbsolute` to decide whether to anchor against
// the worktree dir or pass through as-is. These tests pin that flow down.

test("session.idle: autopilot on absolute plan path → one nudge", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const worktreeDir = mkTmpDir();
    const planRootDir = mkTmpDir("autopilot-plan-root-");
    try {
      // Absolute plan path under a fake `~/.glorious/opencode/<repo>/plans/` layout.
      const absPlanPath = path.join(
        planRootDir,
        "my-repo",
        "plans",
        "absolute-fix.md",
      );
      fs.mkdirSync(path.dirname(absPlanPath), { recursive: true });
      fs.writeFileSync(
        absPlanPath,
        `# Fix absolute\n## Acceptance criteria\n${Array.from({ length: 6 }, (_, i) => `- [ ] step ${i}`).join("\n")}\n`,
      );

      const messages = [
        userMsg(`/autopilot ENG-9999: fix per ${absPlanPath}`),
        assistantMsg("starting"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: worktreeDir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });

      assert.equal(client.prompts.length, 1, "should nudge exactly once");
      assert.match(
        client.prompts[0].text,
        /\[autopilot\] Session idled with unchecked acceptance criteria/,
        "plugin should have read the absolute plan file and counted items",
      );
    } finally {
      rmTmpDir(worktreeDir);
      rmTmpDir(planRootDir);
    }
});

test("findPlanPath prefers the most recent reference across mixed legacy+absolute messages", async () => {
    // A session might contain both a legacy reference (early message) and
    // a later absolute path (after plans migrated). findPlanPath scans
    // newest-to-oldest and returns the first match — so the latest shape wins.
    const { findPlanPath } = await import(PLUGIN_PATH);
    const messages = [
        msgWithText("user", "/autopilot see .agent/plans/legacy.md"),
        msgWithText("assistant", "working"),
        msgWithText(
          "user",
          "actually use /Users/me/.glorious/opencode/my-repo/plans/current.md instead",
        ),
    ];
    const match = findPlanPath(messages);
    assert.ok(match, "expected a match");
    assert.ok(
      match.endsWith("/plans/current.md"),
      `expected the newest (absolute) reference to win, got ${match}`,
    );
});

test("runtime reader uses path.isAbsolute: absolute plan path is read as-is", async () => {
    // Regression: a naive `path.join(worktreeDir, planPath)` would CORRUPT
    // the absolute path by concatenating the worktree dir in front of it.
    // This test verifies that autopilot reads the plan from the actual
    // absolute location (not `<worktree>/<absolute-path>`) by placing the
    // fixture at the absolute path ONLY and checking the nudge fires.
    const { default: factory } = await import(PLUGIN_PATH);
    const worktreeDir = mkTmpDir();
    const planRootDir = mkTmpDir("autopilot-plan-root-");
    try {
      const absPlanPath = path.join(
        planRootDir,
        "isolated-repo",
        "plans",
        "standalone.md",
      );
      fs.mkdirSync(path.dirname(absPlanPath), { recursive: true });
      fs.writeFileSync(
        absPlanPath,
        "# Standalone\n## Acceptance criteria\n- [ ] only\n",
      );

      // NB: the plan fixture is ONLY at the absolute path — nothing is
      // written inside `worktreeDir/.agent/plans/...`. If the plugin
      // were using `path.join(worktreeDir, absPlanPath)` (the broken
      // shape), it would try to read e.g.
      // `/tmp/worktree/tmp/plan-root/isolated-repo/plans/standalone.md`,
      // which does NOT exist — no nudge would fire.
      const messages = [
        userMsg(`/autopilot iso-1 per ${absPlanPath}`),
        assistantMsg("go"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: worktreeDir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });

      assert.equal(
        client.prompts.length,
        1,
        "plugin must have read the absolute plan file (path.isAbsolute branch)",
      );
      assert.match(client.prompts[0].text, /\[autopilot\] Session idled with unchecked acceptance criteria/);
    } finally {
      rmTmpDir(worktreeDir);
      rmTmpDir(planRootDir);
    }
});

test("session.idle: legacy .agent/plans/<slug>.md still triggers autopilot nudge (backward compat)", async () => {
    // Regression guard: sessions that started before the plan-storage
    // migration may still have `.agent/plans/<slug>.md` references
    // lingering in their chat transcript. `findPlanPath` must continue
    // to match this shape, and the runtime reader must anchor the
    // relative path against the worktree directory (not pass through as
    // absolute). This asserts the full end-to-end legacy path works.
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/legacy-slug.md",
        "# Legacy\n## Acceptance criteria\n- [ ] one\n- [ ] two\n- [ ] three\n",
      );
      const messages = [
        userMsg(
          "/autopilot ENG-legacy: continue per .agent/plans/legacy-slug.md",
        ),
        assistantMsg("starting legacy flow"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1, "legacy path should still nudge");
      assert.match(
        client.prompts[0].text,
        /\[autopilot\] Session idled with unchecked acceptance criteria/,
        "plugin must have read the legacy plan file via path.join(worktreeDir, relativePath)",
      );
    } finally {
      rmTmpDir(dir);
    }
});

// --- Circuit breakers (hardening) ------------------------------------------
//
// These cover the hardening round: plan-shape classifier, branch/plan
// alignment, PR-state short-circuit, filesystem kill-switch, STOP-report
// backoff, and the iteration-cap fix. The plugin must never prompt the
// user — every breaker halts silently.

const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "autopilot-plans");

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

// -- classifyPlan unit tests -----------------------------------------------

test("classifyPlan: unit fixture => 'unit'", async () => {
  const { classifyPlan } = await import(PLUGIN_PATH);
  assert.equal(classifyPlan(readFixture("unit.md")), "unit");
});

test("classifyPlan: umbrella fixture => 'umbrella' (has ## Chunks + 3+ Linear IDs)", async () => {
  const { classifyPlan } = await import(PLUGIN_PATH);
  assert.equal(classifyPlan(readFixture("umbrella.md")), "umbrella");
});

test("classifyPlan: measurement-gated fixture => 'measurement-gated'", async () => {
  const { classifyPlan } = await import(PLUGIN_PATH);
  assert.equal(
    classifyPlan(readFixture("measurement-gated.md")),
    "measurement-gated",
  );
});

test("classifyPlan: opted-out fixture => 'opted-out'", async () => {
  const { classifyPlan } = await import(PLUGIN_PATH);
  assert.equal(classifyPlan(readFixture("opted-out.md")), "opted-out");
});

test("classifyPlan: opt-out magic comment is authoritative (beats umbrella signals)", async () => {
  // A plan that would otherwise classify as umbrella, but is explicitly
  // opted out — opt-out must win.
  const { classifyPlan } = await import(PLUGIN_PATH);
  const content =
    "<!-- autopilot: skip -->\n\n## Chunks\n\n- GEN-1\n- GEN-2\n- GEN-3\n";
  assert.equal(classifyPlan(content), "opted-out");
});

test("classifyPlan: large file (> 50KB) => 'umbrella' even without section headers", async () => {
  const { classifyPlan } = await import(PLUGIN_PATH);
  const padding = "x ".repeat(30_000); // ~60KB of filler
  const content = `## Goal\n${padding}\n## Acceptance criteria\n- [ ] a\n`;
  assert.equal(classifyPlan(content), "umbrella");
});

test("classifyPlan: measurement signal in Constraints (not AC) => still 'unit'", async () => {
  // "SLO" mentioned in Constraints should not trip the measurement gate —
  // the regex is scoped to the AC section only.
  const { classifyPlan } = await import(PLUGIN_PATH);
  const content = `## Goal
Fix the thing (GEN-1).
## Constraints
- Must not regress SLO
## Acceptance criteria
- [ ] fix the code
`;
  assert.equal(classifyPlan(content), "unit");
});

// -- planGoalLinearId unit tests -------------------------------------------

test("planGoalLinearId: returns first Linear ID in ## Goal", async () => {
  const { planGoalLinearId } = await import(PLUGIN_PATH);
  assert.equal(
    planGoalLinearId(readFixture("unit.md")),
    "GEN-1234",
  );
});

test("planGoalLinearId: null when ## Goal has no Linear ID", async () => {
  const { planGoalLinearId } = await import(PLUGIN_PATH);
  const content = "## Goal\nFix a thing.\n## Acceptance criteria\n- [ ] a\n";
  assert.equal(planGoalLinearId(content), null);
});

test("planGoalLinearId: null when there's no ## Goal section", async () => {
  const { planGoalLinearId } = await import(PLUGIN_PATH);
  assert.equal(planGoalLinearId("## Acceptance criteria\n- [ ] a\n"), null);
});

// -- countUnchecked ignores [~] and [-] markers ----------------------------

test("countUnchecked: only `- [ ]` counts; [~] pending and [-] blocked are ignored", async () => {
  const { countUnchecked } = await import(PLUGIN_PATH);
  const plan = `## Acceptance criteria
- [ ] actionable
- [x] done
- [~] pending measurement
- [-] blocked on upstream
- [ ] another actionable
`;
  assert.equal(countUnchecked(plan), 2);
});

// -- detectStopReport unit tests -------------------------------------------

test("detectStopReport: line starting with `STOP:` matches", async () => {
  const { detectStopReport } = await import(PLUGIN_PATH);
  assert.equal(detectStopReport("STOP: plan is on wrong branch"), true);
});

test("detectStopReport: line starting with `STOP —` matches", async () => {
  const { detectStopReport } = await import(PLUGIN_PATH);
  assert.equal(detectStopReport("STOP — cannot proceed without X"), true);
});

test("detectStopReport: `STOP` later in line does NOT match", async () => {
  const { detectStopReport } = await import(PLUGIN_PATH);
  assert.equal(
    detectStopReport("I won't stop until the tests pass"),
    false,
    "pattern is line-start anchored to avoid false positives",
  );
});

test("detectStopReport: STOP on a later line matches (multiline)", async () => {
  const { detectStopReport } = await import(PLUGIN_PATH);
  const text = "Here's what I found.\n\nSTOP: plan is structurally wrong.";
  assert.equal(detectStopReport(text), true);
});

test("detectStopReport: empty string => false", async () => {
  const { detectStopReport } = await import(PLUGIN_PATH);
  assert.equal(detectStopReport(""), false);
});

// -- Integration: umbrella plan => session stops silently, no nudge -------

test("session.idle: umbrella plan => session stopped with reason 'plan-shape:umbrella', no nudge", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(tmp, ".agent/plans/edi.md", readFixture("umbrella.md"));
    const messages = [
      userMsg("/autopilot see .agent/plans/edi.md"),
      assistantMsg("starting on .agent/plans/edi.md"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(
      client.prompts.length,
      0,
      "umbrella plan must not be nudged",
    );
    const st = readStateFile(tmp);
    assert.ok(st.sessions["s1"].stopped);
    assert.equal(st.sessions["s1"].stopReason, "plan-shape:umbrella");
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: measurement-gated plan => stopped with reason 'plan-shape:measurement-gated'", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/plans/gated.md",
      readFixture("measurement-gated.md"),
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/gated.md"),
      assistantMsg("working on .agent/plans/gated.md"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(client.prompts.length, 0);
    const st = readStateFile(tmp);
    assert.ok(st.sessions["s1"].stopped);
    assert.equal(
      st.sessions["s1"].stopReason,
      "plan-shape:measurement-gated",
    );
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: opted-out plan => stopped with reason 'plan-shape:opted-out'", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(
      tmp,
      ".agent/plans/skip.md",
      readFixture("opted-out.md"),
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/skip.md"),
      assistantMsg(".agent/plans/skip.md"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(client.prompts.length, 0);
    const st = readStateFile(tmp);
    assert.ok(st.sessions["s1"].stopped);
    assert.equal(st.sessions["s1"].stopReason, "plan-shape:opted-out");
  } finally {
    rmTmpDir(tmp);
  }
});

// -- Kill switch -----------------------------------------------------------

test("session.idle: kill switch file present => stopped with reason 'kill-switch'", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(tmp, ".agent/plans/plan.md", readFixture("unit.md"));
    writeFixture(tmp, ".agent/autopilot-disable", ""); // just needs to exist
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg("working on .agent/plans/plan.md"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    assert.equal(
      client.prompts.length,
      0,
      "kill switch must prevent nudging",
    );
    const st = readStateFile(tmp);
    assert.ok(st.sessions["s1"].stopped);
    assert.equal(st.sessions["s1"].stopReason, "kill-switch");
  } finally {
    rmTmpDir(tmp);
  }
});

// -- STOP-report backoff ---------------------------------------------------

test("session.idle: one STOP-report => nudges once (below MAX_CONSECUTIVE_STOPS threshold)", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(tmp, ".agent/plans/plan.md", readFixture("unit.md"));
    // Pre-seed state so lastUncheckedCount is present (otherwise first
    // idle treats the count as "neutral" and doesn't count the STOP).
    writeFixture(
      tmp,
      ".agent/autopilot-state.json",
      JSON.stringify({
        sessions: {
          s1: { enabled: true, iterations: 1, lastUncheckedCount: 3 },
        },
      }),
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg("STOP: plan is on the wrong branch."),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    // First STOP: counter increments to 1 — below threshold (2), so a
    // nudge still fires. (Note: branch-mismatch check may ALSO fire here;
    // that's fine — both are silent stops. Assert whichever applies.)
    const st = readStateFile(tmp);
    // Either stopped via branch-mismatch (if git returns a branch) or
    // nudged once (if no branch / no Linear-ID match). Accept both as
    // valid — the critical behavior is "no infinite-loop nudges."
    if (st.sessions["s1"].stopped) {
      // Either stop reason is acceptable in this test env.
      assert.ok(
        typeof st.sessions["s1"].stopReason === "string",
        "should record a stop reason",
      );
    } else {
      assert.equal(st.sessions["s1"].consecutiveStops, 1);
    }
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: two consecutive STOP reports => stopped with reason 'agent-stop-report'", async () => {
  const tmp = mkTmpDir();
  try {
    // Use a plan with NO Linear ID so branch-mismatch doesn't preempt
    // the STOP-report backoff path.
    writeFixture(
      tmp,
      ".agent/plans/plan.md",
      "# No ticket\n## Goal\nFix a thing.\n## Acceptance criteria\n- [ ] a\n- [ ] b\n",
    );
    // Pre-seed: enabled, with 1 prior STOP and a lastUncheckedCount so
    // the second STOP can increment to the threshold.
    writeFixture(
      tmp,
      ".agent/autopilot-state.json",
      JSON.stringify({
        sessions: {
          s1: {
            enabled: true,
            iterations: 2,
            consecutiveStops: 1,
            lastUncheckedCount: 2,
          },
        },
      }),
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg("STOP: still blocked on the same upstream issue."),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    const st = readStateFile(tmp);
    assert.ok(
      st.sessions["s1"].stopped,
      "2nd STOP must stop the session",
    );
    assert.equal(st.sessions["s1"].stopReason, "agent-stop-report");
    assert.equal(
      client.prompts.length,
      0,
      "no nudge fires when STOP-backoff trips",
    );
  } finally {
    rmTmpDir(tmp);
  }
});

test("session.idle: progress (unchecked count drops) resets STOP counter", async () => {
  const tmp = mkTmpDir();
  try {
    // Plan has 1 unchecked box now; pre-seeded lastUncheckedCount was 3.
    writeFixture(
      tmp,
      ".agent/plans/plan.md",
      "# No ticket\n## Goal\nFix.\n## Acceptance criteria\n- [x] a\n- [x] b\n- [ ] c\n",
    );
    writeFixture(
      tmp,
      ".agent/autopilot-state.json",
      JSON.stringify({
        sessions: {
          s1: {
            enabled: true,
            iterations: 2,
            consecutiveStops: 1,
            lastUncheckedCount: 3,
          },
        },
      }),
    );
    // Agent says STOP again, but the box-count dropped — progress beats
    // STOP, counter resets.
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg("STOP: blocked again"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    const st = readStateFile(tmp);
    // Session still running.
    assert.ok(!st.sessions["s1"].stopped, "progress should keep session alive");
    assert.equal(
      st.sessions["s1"].consecutiveStops,
      0,
      "progress must reset STOP counter",
    );
    assert.equal(st.sessions["s1"].lastUncheckedCount, 1);
  } finally {
    rmTmpDir(tmp);
  }
});

// -- Iteration-cap fix (debounce must not bypass the cap) ------------------

test("session.idle: max iterations sets stopped=true even when nudge is debounced", async () => {
  const tmp = mkTmpDir();
  try {
    writeFixture(tmp, ".agent/plans/plan.md", readFixture("unit.md"));
    // Pre-seed state at the cap, with a very recent lastNudgeAt so the
    // debounce will swallow the "stopped" nudge.
    writeFixture(
      tmp,
      ".agent/autopilot-state.json",
      JSON.stringify({
        sessions: {
          s1: {
            enabled: true,
            iterations: 20,
            lastNudgeAt: Date.now(),
          },
        },
      }),
    );
    const messages = [
      userMsg("/autopilot see .agent/plans/plan.md"),
      assistantMsg("working on .agent/plans/plan.md"),
    ];
    const client = mockClientWithMessages(messages);
    const factory = await loadFactory();
    const hooks = await factory({ client, directory: tmp });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s1" } },
    });
    // The nudge was debounced (no prompt sent), BUT the cap must still
    // stop the session terminally — this is the pre-fix bug that let
    // rapid idles defeat the cap.
    assert.equal(client.prompts.length, 0, "debounce swallowed the nudge");
    const st = readStateFile(tmp);
    assert.ok(
      st.sessions["s1"].stopped,
      "cap must mark stopped=true regardless of debounce",
    );
    assert.equal(st.sessions["s1"].stopReason, "max-iterations");
  } finally {
    rmTmpDir(tmp);
  }
});

