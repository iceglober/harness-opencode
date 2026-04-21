#!/usr/bin/env node
//
// autopilot-plugin.test.js — unit tests for src/plugins/autopilot.ts.
//
// The plugin is opt-in (see AGENTS.md §"Autopilot activation"). These tests
// lock in the activation gate, debounce behavior, and nudge-prompt contracts
// so a future refactor can't silently regress to the old "fire on every
// orchestrator session with unchecked boxes" behavior.
//
// Test strategy: exercise the plugin's exported helpers directly, plus drive
// the top-level factory against a hand-rolled mock `client` and mock `directory`
// (tmp dir). No real opencode runtime; no HTTP; no real filesystem writes
// outside the tmp dir. Each test is independent and creates its own tmp dir.
//
// Run: node test/autopilot-plugin.test.js
// Exit codes: 0 on all pass, 1 on first failure.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_PATH = path.resolve(
  __dirname,
  "..",
  "src",
  "plugins",
  "autopilot.ts",
);

// --- Test harness -----------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  // Return a thunk so we can await async tests sequentially below.
  return { name, fn };
}

async function runAll(tests) {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      process.stdout.write(`  ✓ ${name}\n`);
    } catch (err) {
      failed++;
      failures.push({ name, err });
      process.stdout.write(`  ✗ ${name}\n`);
    }
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const { name, err } of failures) {
      process.stderr.write(`\nFAIL: ${name}\n${err.stack || err}\n`);
    }
    process.exit(1);
  }
}

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
      messages: async () => ({ data: [] }), // unused in helper tests
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

// --- Tests ------------------------------------------------------------------

const tests = [
  test("plugin exports expected helpers", async () => {
    const mod = await import(PLUGIN_PATH);
    assert.equal(typeof mod.default, "function", "default export must be a factory");
    assert.equal(typeof mod.detectActivation, "function");
    assert.equal(typeof mod.sendNudgeDebounced, "function");
    assert.equal(typeof mod.countUnchecked, "function");
    assert.equal(typeof mod.findPlanPath, "function");
    assert.equal(typeof mod.findCompletionPromise, "function");
    assert.equal(typeof mod.findVerifierVerdict, "function");
    assert.equal(mod.NUDGE_DEBOUNCE_MS, 30_000);
    assert.equal(mod.MAX_ITERATIONS, 20);
  }),

  test("countUnchecked: counts `- [ ]` inside Acceptance criteria section", async () => {
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
  }),

  test("countUnchecked: zero when no Acceptance criteria section", async () => {
    const { countUnchecked } = await import(PLUGIN_PATH);
    assert.equal(countUnchecked("# Plan\n## Goal\nnothing here\n"), 0);
  }),

  test("detectActivation: empty messages + no handoff => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    assert.equal(detectActivation([], null, 0, 0), false);
  }),

  test("detectActivation: user message with `/autopilot` prefix => true", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    const msgs = [userMsg("/autopilot ENG-1234")];
    assert.equal(detectActivation(msgs, null, 0, 0), true);
  }),

  test("detectActivation: user message with `AUTOPILOT mode` phrase => true", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    const msgs = [userMsg("This invocation is in AUTOPILOT mode — apply ...")];
    assert.equal(detectActivation(msgs, null, 0, 0), true);
  }),

  test("detectActivation: user message without markers => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    const msgs = [
      userMsg("please implement KESB-23"),
      userMsg("looks good, proceed"),
    ];
    assert.equal(detectActivation(msgs, null, 0, 0), false);
  }),

  test("detectActivation: fresh handoff transition (new mtime + iter=0) => true", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    assert.equal(detectActivation([], 1000, 500, 0), true);
  }),

  test("detectActivation: fresh handoff but iter > 0 => false (already mid-run)", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    assert.equal(detectActivation([], 1000, 500, 1), false);
  }),

  test("detectActivation: handoff mtime unchanged => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    assert.equal(detectActivation([], 500, 500, 0), false);
  }),

  test("detectActivation: substring 'autopilot' without slash => false (not a command)", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    // Just discussing autopilot in prose should NOT activate.
    const msgs = [userMsg("what does autopilot do?")];
    assert.equal(detectActivation(msgs, null, 0, 0), false);
  }),

  test("sendNudgeDebounced: first call sends", async () => {
    const { sendNudgeDebounced } = await import(PLUGIN_PATH);
    const client = mockClient();
    const sessState = { iterations: 0 };
    const sent = await sendNudgeDebounced(client, "s1", sessState, "hello", 1000);
    assert.equal(sent, true);
    assert.equal(client.prompts.length, 1);
    assert.equal(client.prompts[0].text, "hello");
    assert.equal(sessState.lastNudgeAt, 1000);
  }),

  test("sendNudgeDebounced: second call within 30s window is suppressed", async () => {
    const { sendNudgeDebounced } = await import(PLUGIN_PATH);
    const client = mockClient();
    const sessState = { iterations: 0 };
    await sendNudgeDebounced(client, "s1", sessState, "hello", 1000);
    const sent2 = await sendNudgeDebounced(client, "s1", sessState, "world", 15_000);
    assert.equal(sent2, false);
    assert.equal(client.prompts.length, 1, "only the first prompt should have sent");
    assert.equal(sessState.lastNudgeAt, 1000, "lastNudgeAt preserved when suppressed");
  }),

  test("sendNudgeDebounced: second call after 30s window sends", async () => {
    const { sendNudgeDebounced } = await import(PLUGIN_PATH);
    const client = mockClient();
    const sessState = { iterations: 0 };
    await sendNudgeDebounced(client, "s1", sessState, "hello", 1000);
    const sent2 = await sendNudgeDebounced(client, "s1", sessState, "world", 31_001);
    assert.equal(sent2, true);
    assert.equal(client.prompts.length, 2);
    assert.equal(sessState.lastNudgeAt, 31_001);
  }),

  // --- Integration tests against the full plugin factory -------------------

  test("session.idle: non-autopilot orchestrator session with 12 unchecked boxes → zero nudges", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      // Seed a real plan on disk so countUnchecked could, in principle, find it.
      writeFixture(
        dir,
        ".agent/plans/fix-whatever.md",
        `# Fix whatever\n## Acceptance criteria\n${Array.from({ length: 12 }, (_, i) => `- [ ] item ${i}`).join("\n")}\n`,
      );
      const messages = [
        userMsg("please implement fix-whatever; see .agent/plans/fix-whatever.md"),
        assistantMsg("working on it"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 0, "non-autopilot session must not nudge");
      // State should have been seeded on first-run but NOT marked enabled.
      const state = readStateFile(dir);
      assert.ok(state, "state file should exist after first-run seed");
      assert.equal(state.sessions.s1.enabled, undefined);
      assert.equal(state.sessions.s1.iterations, 0);
    } finally {
      rmTmpDir(dir);
    }
  }),

  test("session.idle: autopilot-marked session with 12 unchecked boxes → one nudge", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/fix-whatever.md",
        `# Fix whatever\n## Acceptance criteria\n${Array.from({ length: 12 }, (_, i) => `- [ ] item ${i}`).join("\n")}\n`,
      );
      const messages = [
        userMsg("/autopilot ENG-1234: fix whatever per .agent/plans/fix-whatever.md"),
        assistantMsg("starting execution"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      // First idle event: should seed state, detect activation, and nudge.
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1, "autopilot session should nudge once");
      assert.match(client.prompts[0].text, /\[autopilot\] Plan has 12 unchecked/);
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.enabled, true);
      assert.ok(
        state.sessions.s1.iterations >= 1,
        "iterations should have advanced after a real nudge",
      );
      assert.ok(state.sessions.s1.lastNudgeAt, "lastNudgeAt must be recorded");
    } finally {
      rmTmpDir(dir);
    }
  }),

  test("session.idle: debounce suppresses a second rapid idle nudge", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/fix-whatever.md",
        `# Fix whatever\n## Acceptance criteria\n- [ ] a\n- [ ] b\n`,
      );
      const messages = [userMsg("/autopilot see .agent/plans/fix-whatever.md")];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      // Fire a second idle event immediately.
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(
        client.prompts.length,
        1,
        "second idle within 30s must be debounced",
      );
    } finally {
      rmTmpDir(dir);
    }
  }),

  test("session.idle: DONE promise in autopilot → verifier prompt", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/done-plan.md",
        "# Done\n## Acceptance criteria\n- [x] a\n",
      );
      const messages = [
        userMsg("/autopilot fix-whatever see .agent/plans/done-plan.md"),
        assistantMsg(
          "All acceptance criteria satisfied.\n\n<promise>DONE</promise>",
        ),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1);
      assert.match(
        client.prompts[0].text,
        /\[autopilot\] Completion promise detected\. Delegate to `@autopilot-verifier`/,
      );
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.verification_pending, true);
      assert.equal(state.sessions.s1.enabled, true);
    } finally {
      rmTmpDir(dir);
    }
  }),

  test("session.idle: fresh-handoff transition activates autopilot even without /autopilot marker", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      // Seed state with lastHandoffMtime = 0 so the written handoff looks new.
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: { iterations: 0, lastHandoffMtime: 0 },
          },
        }),
      );
      writeFixture(dir, ".agent/fresh-handoff.md", "# Handoff\n\nENG-1234\n");
      const messages = [userMsg("pick up the next ticket")];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1);
      assert.match(
        client.prompts[0].text,
        /\/fresh re-keyed this worktree to a new task/,
      );
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.enabled, true);
    } finally {
      rmTmpDir(dir);
    }
  }),

  test("chat.message: non-autopilot session → no state write", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      // Pre-seed state as a non-autopilot session (enabled missing/false).
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: { iterations: 7, lastPlanPath: ".agent/plans/x.md" },
          },
        }),
      );
      const client = mockClient();
      const handlers = await factory({ client, directory: dir });
      await handlers["chat.message"]({ sessionID: "s1", agent: "orchestrator" });
      const state = readStateFile(dir);
      // Iterations must NOT have been reset to 0 — the plugin should have
      // ignored the chat.message entirely for this non-autopilot session.
      assert.equal(state.sessions.s1.iterations, 7);
      assert.equal(
        state.sessions.s1.lastPlanPath,
        ".agent/plans/x.md",
        "lastPlanPath should be untouched",
      );
    } finally {
      rmTmpDir(dir);
    }
  }),

  test("chat.message: autopilot session → iterations reset, enabled preserved", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 12,
              lastPlanPath: ".agent/plans/x.md",
              lastHandoffMtime: 9999,
              enabled: true,
              verification_pending: true,
              consecutive_missing_verdicts: 2,
            },
          },
        }),
      );
      const client = mockClient();
      const handlers = await factory({ client, directory: dir });
      await handlers["chat.message"]({ sessionID: "s1", agent: "orchestrator" });
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.iterations, 0, "iter reset on user msg");
      assert.equal(state.sessions.s1.enabled, true, "enabled preserved");
      assert.equal(
        state.sessions.s1.lastPlanPath,
        ".agent/plans/x.md",
        "lastPlanPath preserved",
      );
      assert.equal(
        state.sessions.s1.lastHandoffMtime,
        9999,
        "lastHandoffMtime preserved",
      );
      assert.equal(
        state.sessions.s1.verification_pending,
        undefined,
        "verification_pending cleared",
      );
      assert.equal(
        state.sessions.s1.consecutive_missing_verdicts,
        undefined,
        "missing-verdict counter cleared",
      );
    } finally {
      rmTmpDir(dir);
    }
  }),

  test("session.idle: non-target agent (plan) → no-op", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      const messages = [userMsg("/autopilot work on it", "plan")];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 0);
      assert.equal(readStateFile(dir), null, "no state should be written");
    } finally {
      rmTmpDir(dir);
    }
  }),
];

runAll(tests).catch((err) => {
  process.stderr.write(`harness error: ${err.stack || err}\n`);
  process.exit(1);
});
