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

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-test-"));
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

function userMsg(text, agent = "orchestrator") {
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

test("session.idle: non-autopilot orchestrator session → zero nudges, no state write", async () => {
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
      "no plan ref yet → no nudge; wait for orchestrator to decide",
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
    await hooks["chat.message"]({ sessionID: "s1", agent: "orchestrator" });
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
    await hooks["chat.message"]({ sessionID: "s1", agent: "orchestrator" });
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
