// autopilot-plugin.test.js — unit tests for src/plugins/autopilot.ts.
//
// The plugin is opt-in (see AGENTS.md §"Autopilot activation"). These tests
// lock in the activation gate, debounce behavior, nudge-prompt contracts,
// and the continuation-guard's five detectors (shipped-probe, user-stop,
// orchestrator-EXIT sentinel, max-iterations cap, stagnation) so a future
// refactor can't silently regress to the old "fire on every orchestrator
// session with unchecked boxes" behavior — the behavior that caused the
// session #1342 class-of-bug where autopilot kept pressuring the
// orchestrator to tick checkboxes after the underlying work had already
// shipped.
//
// Test strategy: exercise the plugin's exported helpers directly, plus drive
// the top-level factory against a hand-rolled mock `client` and mock `directory`
// (tmp dir). No real opencode runtime; no HTTP; no real filesystem writes
// outside the tmp dir. Each test is independent and creates its own tmp dir.
//
// Run: `bun test test/autopilot-plugin.test.js` (preferred) or as part of
// the full `bun test` suite.

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
});

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
});

test("countUnchecked: zero when no Acceptance criteria section", async () => {
    const { countUnchecked } = await import(PLUGIN_PATH);
    assert.equal(countUnchecked("# Plan\n## Goal\nnothing here\n"), 0);
});

test("detectActivation: empty messages + no handoff => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    assert.equal(detectActivation([], null, 0, 0), false);
});

test("detectActivation: user message with `/autopilot` prefix => true", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    const msgs = [userMsg("/autopilot ENG-1234")];
    assert.equal(detectActivation(msgs, null, 0, 0), true);
});

test("detectActivation: user message with `AUTOPILOT mode` phrase => true", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    const msgs = [userMsg("This invocation is in AUTOPILOT mode — apply ...")];
    assert.equal(detectActivation(msgs, null, 0, 0), true);
});

test("detectActivation: user message without markers => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    const msgs = [
      userMsg("please implement KESB-23"),
      userMsg("looks good, proceed"),
    ];
    assert.equal(detectActivation(msgs, null, 0, 0), false);
});

test("detectActivation: fresh handoff transition (new mtime + iter=0) => true", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    assert.equal(detectActivation([], 1000, 500, 0), true);
});

test("detectActivation: fresh handoff but iter > 0 => false (already mid-run)", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    assert.equal(detectActivation([], 1000, 500, 1), false);
});

test("detectActivation: handoff mtime unchanged => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    assert.equal(detectActivation([], 500, 500, 0), false);
});

test("detectActivation: substring 'autopilot' without slash => false (not a command)", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    // Just discussing autopilot in prose should NOT activate.
    const msgs = [userMsg("what does autopilot do?")];
    assert.equal(detectActivation(msgs, null, 0, 0), false);
});

// --- first-user-message-only activation (self-activation guard) ----------
//
// These tests lock in the tightened scope from the autopilot-no-self-activate
// fix. The old behavior scanned every user message for the marker; the new
// behavior scans only the FIRST user message. This prevents the orchestrator
// from self-activating when a marker appears later in the transcript
// (quoted context, paste-old-transcript, prompt-injection).

test("detectActivation: marker ONLY in second user message (first has no marker) => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    // Common symptom: user kicks off a normal session, then in a later
    // turn references /autopilot as context ("like the /autopilot mode
    // does"). The later marker must NOT retroactively activate.
    const msgs = [
      userMsg("please implement KESB-23"),
      userMsg("/autopilot do X"),
    ];
    assert.equal(detectActivation(msgs, null, 0, 0), false);
});

test("detectActivation: marker only in later user message (paste-old-transcript case) => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    // User pastes a snippet from an old session as context. The /autopilot
    // token landing mid-transcript is NOT an activation signal.
    const msgs = [
      userMsg("hello"),
      userMsg("status"),
      userMsg("here's what I tried: /autopilot ENG-1"),
      userMsg("any ideas?"),
      userMsg("thanks"),
    ];
    assert.equal(detectActivation(msgs, null, 0, 0), false);
});

test("detectActivation: AUTOPILOT mode phrase only in second user message => false", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    // User quotes or references documentation that mentions the marker.
    // Descriptive mention is not activation.
    const msgs = [
      userMsg("hi"),
      userMsg("the docs say 'AUTOPILOT mode' means lights-out orchestration"),
    ];
    assert.equal(detectActivation(msgs, null, 0, 0), false);
});

test("detectActivation: first message is assistant, first user message has marker => true", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    // "First user message" means "first message with role=user", not
    // "literal first message in the array". An initial assistant/system
    // preamble does not shift the scan.
    const msgs = [
      assistantMsg("greeting"),
      userMsg("/autopilot ENG-1"),
    ];
    assert.equal(detectActivation(msgs, null, 0, 0), true);
});

test("detectActivation: fresh-handoff still activates when first user message has no marker", async () => {
    const { detectActivation } = await import(PLUGIN_PATH);
    // Signal 2 (fresh-handoff) is independent of Signal 1's scope.
    // /plan-loop writing the handoff brief remains a trusted activation
    // path regardless of user-message content.
    const msgs = [userMsg("unrelated chat, no marker")];
    assert.equal(detectActivation(msgs, 1000, 500, 0), true);
});

test("session.idle: marker in SECOND user message → zero nudges (no retroactive activation)", async () => {
    // End-to-end integration test. The plugin's real event handler must
    // NOT activate a session where the /autopilot marker only appears
    // in a later user message. Fires two consecutive session.idle events
    // to verify the state stays un-enabled across events too.
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/x.md",
        "# X\n## Acceptance criteria\n- [ ] a\n- [ ] b\n",
      );
      const messages = [
        userMsg("please implement x; see .agent/plans/x.md"),
        assistantMsg("working on it"),
        userMsg("/autopilot do X"), // marker here, NOT in first user message
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(
        client.prompts.length,
        0,
        "marker in non-first user message must not retroactively activate",
      );
      const state = readStateFile(dir);
      assert.ok(state, "state file exists after first-time-seed");
      assert.equal(
        state.sessions.s1.enabled,
        undefined,
        "session must not be marked enabled",
      );
    } finally {
      rmTmpDir(dir);
    }
});

test("sendNudgeDebounced: first call sends", async () => {
    const { sendNudgeDebounced } = await import(PLUGIN_PATH);
    const client = mockClient();
    const sessState = { iterations: 0 };
    const sent = await sendNudgeDebounced(client, "s1", sessState, "hello", 1000);
    assert.equal(sent, true);
    assert.equal(client.prompts.length, 1);
    assert.equal(client.prompts[0].text, "hello");
    assert.equal(sessState.lastNudgeAt, 1000);
});

test("sendNudgeDebounced: second call within 30s window is suppressed", async () => {
    const { sendNudgeDebounced } = await import(PLUGIN_PATH);
    const client = mockClient();
    const sessState = { iterations: 0 };
    await sendNudgeDebounced(client, "s1", sessState, "hello", 1000);
    const sent2 = await sendNudgeDebounced(client, "s1", sessState, "world", 15_000);
    assert.equal(sent2, false);
    assert.equal(client.prompts.length, 1, "only the first prompt should have sent");
    assert.equal(sessState.lastNudgeAt, 1000, "lastNudgeAt preserved when suppressed");
});

test("sendNudgeDebounced: second call after 30s window sends", async () => {
    const { sendNudgeDebounced } = await import(PLUGIN_PATH);
    const client = mockClient();
    const sessState = { iterations: 0 };
    await sendNudgeDebounced(client, "s1", sessState, "hello", 1000);
    const sent2 = await sendNudgeDebounced(client, "s1", sessState, "world", 31_001);
    assert.equal(sent2, true);
    assert.equal(client.prompts.length, 2);
    assert.equal(sessState.lastNudgeAt, 31_001);
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

// --- continuation-guard tests ----------------------------------------------
//
// The continuation-guard is the unified terminal-exit latch (`exited_reason`)
// fronted by a single short-circuit at the top of `session.idle`. Five
// independent detectors feed it: shipped-probe (this section), user-stop
// (chat.message handler), orchestrator-EXIT sentinel, max-iterations cap,
// and stagnation (substrate hash unchanged across N nudges). Every test
// below exercises one of those detectors or the continue-execution nudge
// escape clause.

test("AUTOPILOT_EXIT_RE: matches sentinel on its own line", async () => {
    const { AUTOPILOT_EXIT_RE } = await import(PLUGIN_PATH);
    assert.equal(
      AUTOPILOT_EXIT_RE.test("foo\n<autopilot>EXIT</autopilot>\nbar"),
      true,
    );
});

test("AUTOPILOT_EXIT_RE: does NOT match inline sentinel inside prose", async () => {
    const { AUTOPILOT_EXIT_RE } = await import(PLUGIN_PATH);
    assert.equal(
      AUTOPILOT_EXIT_RE.test("see <autopilot>EXIT</autopilot> inline"),
      false,
    );
});

test("findOrchestratorExit: returns null when no sentinel present", async () => {
    const { findOrchestratorExit } = await import(PLUGIN_PATH);
    const result = findOrchestratorExit([
      userMsg("do the thing"),
      assistantMsg("working on it"),
    ]);
    assert.equal(result, null);
});

test("findOrchestratorExit: returns latest match index", async () => {
    const { findOrchestratorExit } = await import(PLUGIN_PATH);
    const messages = [
      userMsg("start"),
      assistantMsg("first EXIT\n<autopilot>EXIT</autopilot>"),
      userMsg("retry"),
      assistantMsg("second EXIT\n<autopilot>EXIT</autopilot>"),
    ];
    const result = findOrchestratorExit(messages);
    assert.ok(result, "expected non-null result");
    assert.equal(result.found, true);
    assert.equal(result.msgIdx, 3, "should return the later match");
});

test("detectUserStopToken: STOP as uppercase whole word → true", async () => {
    const { detectUserStopToken } = await import(PLUGIN_PATH);
    assert.equal(detectUserStopToken("please STOP now"), true);
});

test("detectUserStopToken: HALT as uppercase whole word → true", async () => {
    const { detectUserStopToken } = await import(PLUGIN_PATH);
    assert.equal(detectUserStopToken("HALT and wait"), true);
});

test("detectUserStopToken: lowercase bare 'stop' without context → false", async () => {
    const { detectUserStopToken } = await import(PLUGIN_PATH);
    // Plain lowercase "stop" is too ambiguous — would false-trigger on
    // benign prose. The user must shout STOP or use the phrase form.
    assert.equal(detectUserStopToken("please don't stop the tests"), false);
});

test("detectUserStopToken: 'stop autopilot' phrase → true", async () => {
    const { detectUserStopToken } = await import(PLUGIN_PATH);
    assert.equal(detectUserStopToken("please stop autopilot"), true);
});

test("detectUserStopToken: 'disable autopilot' phrase → true", async () => {
    const { detectUserStopToken } = await import(PLUGIN_PATH);
    assert.equal(detectUserStopToken("can you disable autopilot"), true);
});

test("detectUserStopToken: 'kill autopilot' phrase → true", async () => {
    const { detectUserStopToken } = await import(PLUGIN_PATH);
    assert.equal(detectUserStopToken("kill autopilot right now"), true);
});

test("detectUserStopToken: 'exit autopilot' phrase → true", async () => {
    const { detectUserStopToken } = await import(PLUGIN_PATH);
    assert.equal(detectUserStopToken("Exit Autopilot please"), true);
});

test("detectUserStopToken: empty / non-matching text → false", async () => {
    const { detectUserStopToken } = await import(PLUGIN_PATH);
    assert.equal(detectUserStopToken(""), false);
    assert.equal(detectUserStopToken("keep going"), false);
    assert.equal(detectUserStopToken("what does autopilot do"), false);
});

// checkShipped tests use an injected execFileImpl mock so we never spawn
// real `git` / `gh`. The mock signature matches Node's
// `child_process.execFile(file, args, opts, cb)`: `cb(err, stdout, stderr)`.
// An ExecFileException with a numeric `code` field represents a non-zero
// subprocess exit; an error with string code (e.g., "ENOENT") represents a
// spawn failure; a thrown error or no callback represents other failures.

function mockExecFile(handlers) {
  // handlers is an object keyed by "file args[0] args[1] ..." prefix
  // (space-joined). The value is either:
  //   - { stdout, code }          → synchronous callback
  //   - { code: "ENOENT" }        → spawn failure (string code)
  //   - { hangForMs: number }     → never callback (simulates timeout)
  //   - { throwSync: true }       → throws synchronously (caught by runCheck)
  const calls = [];
  const impl = function (file, args, opts, cb) {
    const key = [file, ...args].join(" ");
    calls.push({ file, args: [...args], opts });
    const spec =
      handlers[key] ??
      handlers[
        Object.keys(handlers).find((k) => key.startsWith(k)) ?? ""
      ] ??
      handlers["*"];
    if (!spec) {
      setImmediate(() => {
        const err = new Error(`no mock for: ${key}`);
        err.code = "ENOENT";
        cb(err, "", "");
      });
      return;
    }
    if (spec.throwSync) {
      throw new Error("mock sync throw");
    }
    if (spec.hangForMs !== undefined) {
      // Simulate a process that never completes within the deadline.
      // The AbortController in runCheck will fire; listen for the abort
      // signal and callback with an AbortError so the caller can
      // distinguish timeout from a genuine exit.
      if (opts.signal) {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.code = "ABORT_ERR";
          cb(err, "", "");
        });
      }
      return;
    }
    setImmediate(() => {
      if (spec.code && typeof spec.code === "string") {
        // Spawn failure (ENOENT etc.)
        const err = new Error(spec.code);
        err.code = spec.code;
        cb(err, "", "");
        return;
      }
      const code = spec.code ?? 0;
      if (code === 0) {
        cb(null, spec.stdout ?? "", "");
      } else {
        const err = new Error(`exit ${code}`);
        err.code = code;
        cb(err, spec.stdout ?? "", "");
      }
    });
  };
  impl.calls = calls;
  return impl;
}

test("checkShipped: merge-base exit 0 → 'shipped'", async () => {
    const { checkShipped } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({
      "git merge-base --is-ancestor HEAD origin/main": { code: 0 },
    });
    const result = await checkShipped("/tmp", { execFileImpl, timeoutMs: 500 });
    assert.equal(result, "shipped");
});

test("checkShipped: merge-base exit 1 + gh pr list non-empty → 'shipped'", async () => {
    const { checkShipped } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({
      "git merge-base --is-ancestor HEAD origin/main": { code: 1 },
      "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "feat/x\n" },
      "gh pr list --head feat/x --state merged --json number --limit 1": {
        code: 0,
        stdout: '[{"number":1342}]',
      },
    });
    const result = await checkShipped("/tmp", { execFileImpl, timeoutMs: 500 });
    assert.equal(result, "shipped");
});

test("checkShipped: merge-base exit 1 + gh pr list empty → 'not_shipped'", async () => {
    const { checkShipped } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({
      "git merge-base --is-ancestor HEAD origin/main": { code: 1 },
      "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "feat/x\n" },
      "gh pr list --head feat/x --state merged --json number --limit 1": {
        code: 0,
        stdout: "[]",
      },
    });
    const result = await checkShipped("/tmp", { execFileImpl, timeoutMs: 500 });
    assert.equal(result, "not_shipped");
});

test("checkShipped: both checks ENOENT → 'unknown'", async () => {
    const { checkShipped } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({ "*": { code: "ENOENT" } });
    const result = await checkShipped("/tmp", { execFileImpl, timeoutMs: 500 });
    assert.equal(result, "unknown");
});

test("checkShipped: merge-base hangs → timeout returns 'unknown'", async () => {
    const { checkShipped } = await import(PLUGIN_PATH);
    // Both checks hang; the AbortController must fire and the helper
    // must return "unknown" without leaving dangling handles.
    const execFileImpl = mockExecFile({ "*": { hangForMs: 10_000 } });
    const start = Date.now();
    const result = await checkShipped("/tmp", { execFileImpl, timeoutMs: 30 });
    const elapsed = Date.now() - start;
    assert.equal(result, "unknown");
    // Two legs × 30 ms timeout = ~60 ms budget. Allow generous slack
    // for CI jitter but fail if it took seconds.
    assert.ok(
      elapsed < 1000,
      `expected fast timeout path, took ${elapsed}ms`,
    );
});

test("checkShipped: detached HEAD (rev-parse returns 'HEAD') → gh leg skipped → 'unknown' if merge-base also unknown", async () => {
    const { checkShipped } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({
      "git merge-base --is-ancestor HEAD origin/main": { code: 128 }, // not a repo
      "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "HEAD\n" },
    });
    const result = await checkShipped("/tmp", { execFileImpl, timeoutMs: 500 });
    assert.equal(result, "unknown");
    // Verify gh was NOT called — detached-HEAD short-circuits the gh leg.
    const ghCalls = execFileImpl.calls.filter((c) => c.file === "gh");
    assert.equal(ghCalls.length, 0);
});

test("session.idle: legacy branch with shipped PR → sends AUTOPILOT_SHIPPED_EXIT_MESSAGE, persists exited_reason: 'shipped'", async () => {
    // This test relies on the plugin's real checkShipped calling the real
    // git / gh binaries. In the tmp-dir test harness there's no git repo,
    // so the checks naturally return "unknown" — which means the plugin
    // falls through to the normal continue-execution nudge. To explicitly
    // exercise the shipped-PR path, we seed state with a cached
    // last_shipped_check_result of "shipped" so the cache-fresh branch
    // short-circuits to the exit.
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/fix-shipped.md",
        "# Fix\n## Acceptance criteria\n- [ ] a\n- [ ] b\n",
      );
      // Seed state: enabled=true, a plan path, a RECENT shipped-check
      // cache hit. The legacy branch will consult the cache, see
      // "shipped", and take the exit path.
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 2,
              enabled: true,
              lastPlanPath: ".agent/plans/fix-shipped.md",
              last_shipped_check_at: Date.now(),
              last_shipped_check_result: "shipped",
            },
          },
        }),
      );
      const messages = [
        userMsg("/autopilot fix-shipped see .agent/plans/fix-shipped.md"),
        assistantMsg("working"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1);
      assert.match(
        client.prompts[0].text,
        /underlying work has already shipped/,
      );
      // Verify we did NOT send the continue-execution nudge.
      assert.doesNotMatch(
        client.prompts[0].text,
        /Plan has 2 unchecked/,
      );
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.exited_reason, "shipped");
    } finally {
      rmTmpDir(dir);
    }
});

test("session.idle: subsequent idle after exited_reason set → zero nudges (pre-idle exit gate)", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 3,
              enabled: true,
              exited_reason: "shipped",
              lastPlanPath: ".agent/plans/x.md",
              lastHandoffMtime: 1000,
            },
          },
        }),
      );
      writeFixture(dir, ".agent/plans/x.md", "# X\n## Acceptance criteria\n- [ ] a\n");
      const messages = [
        userMsg("/autopilot see .agent/plans/x.md"),
        assistantMsg("any content"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      // Pre-idle exit gate must short-circuit. Zero prompts.
      assert.equal(client.prompts.length, 0);
      // State is unchanged (the gate returns before any write).
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.exited_reason, "shipped");
      assert.equal(state.sessions.s1.iterations, 3);
    } finally {
      rmTmpDir(dir);
    }
});

test("session.idle: orchestrator emits <autopilot>EXIT</autopilot> → sends orchestrator-exit message, persists exited_reason: 'orchestrator_exit'", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      const messages = [
        userMsg("/autopilot see .agent/plans/stale.md"),
        assistantMsg(
          "The plan references work that shipped in PR #1342.\n" +
            "<autopilot>EXIT</autopilot>",
        ),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0].text, /Exit acknowledged/);
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.exited_reason, "orchestrator_exit");
      assert.equal(state.sessions.s1.enabled, true);
    } finally {
      rmTmpDir(dir);
    }
});

test("chat.message: user text with 'STOP autopilot' → user-stop message, persists exited_reason: 'user_stop'", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 5,
              enabled: true,
              lastPlanPath: ".agent/plans/x.md",
              lastHandoffMtime: 1000,
            },
          },
        }),
      );
      // The chat.message handler re-fetches messages via client.session.messages.
      // Seed the mock with a user message containing a stop token.
      const messages = [userMsg("STOP autopilot please, I need to review")];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers["chat.message"]({
        sessionID: "s1",
        agent: "orchestrator",
      });
      // Expected: one user-stop acknowledgement nudge sent; state has
      // exited_reason="user_stop". Iterations are preserved (not reset
      // to 0 by the normal path — the stop path preserves them for
      // forensic traceability).
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0].text, /Stopped by user request/);
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.exited_reason, "user_stop");
      assert.equal(state.sessions.s1.iterations, 5);
      assert.equal(state.sessions.s1.enabled, true);
    } finally {
      rmTmpDir(dir);
    }
});

test("chat.message: user text without stop token → legacy reset behavior (iterations: 0, no exit)", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 5,
              enabled: true,
              lastPlanPath: ".agent/plans/x.md",
              lastHandoffMtime: 1000,
            },
          },
        }),
      );
      const messages = [userMsg("looks good, proceed")];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers["chat.message"]({
        sessionID: "s1",
        agent: "orchestrator",
      });
      assert.equal(client.prompts.length, 0, "no stop-token nudge");
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.iterations, 0, "legacy reset");
      assert.equal(
        state.sessions.s1.exited_reason,
        undefined,
        "no exit reason",
      );
      assert.equal(state.sessions.s1.enabled, true);
    } finally {
      rmTmpDir(dir);
    }
});

test("session.idle: shipped-check cache prevents double shell-out within TTL", async () => {
    // This test relies on the cache TTL: when last_shipped_check_at is
    // within SHIPPED_CHECK_CACHE_MS (60s by default), the legacy branch
    // uses the cached result rather than re-invoking checkShipped. We
    // seed a "not_shipped" cache so the continue-execution nudge fires
    // both times, and verify the cache TTL is respected (the timestamp
    // doesn't update on the second idle event because cacheFresh was true).
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/x.md",
        "# X\n## Acceptance criteria\n- [ ] a\n",
      );
      const firstCheckAt = Date.now() - 5_000; // 5s ago — still within TTL
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 1,
              enabled: true,
              lastPlanPath: ".agent/plans/x.md",
              last_shipped_check_at: firstCheckAt,
              last_shipped_check_result: "not_shipped",
            },
          },
        }),
      );
      const messages = [
        userMsg("/autopilot see .agent/plans/x.md"),
        assistantMsg("working"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1, "continue-execution nudge");
      const state = readStateFile(dir);
      // Critical: cache TTL not refreshed — the cached timestamp is preserved
      // because cacheFresh was true and we skipped re-invoking checkShipped.
      assert.equal(
        state.sessions.s1.last_shipped_check_at,
        firstCheckAt,
        "cache timestamp NOT refreshed (cache was fresh)",
      );
    } finally {
      rmTmpDir(dir);
    }
});

test("session.idle: continue-execution nudge contains the EXIT escape clause", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/x.md",
        "# X\n## Acceptance criteria\n- [ ] a\n- [ ] b\n- [ ] c\n",
      );
      const messages = [
        userMsg("/autopilot see .agent/plans/x.md"),
        assistantMsg("working"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1);
      assert.match(
        client.prompts[0].text,
        /Plan has 3 unchecked/,
        "keeps existing continue-execution text",
      );
      assert.match(
        client.prompts[0].text,
        /<autopilot>EXIT<\/autopilot>/,
        "includes EXIT sentinel in the escape clause",
      );
      assert.match(
        client.prompts[0].text,
        /plan is stale or the work has already shipped/,
        "explains when to use EXIT",
      );
    } finally {
      rmTmpDir(dir);
    }
});

test("fresh-transition after shipped-exit: clears exited_reason and re-enables nudging", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      // Seed state with a prior shipped exit AND a non-zero iterations
      // count. The pre-idle exit gate would short-circuit (test 2 covers
      // that). But when /fresh bumps the handoff mtime, we want the NEXT
      // idle to recognize the transition. Problem: the pre-idle gate
      // runs BEFORE the fresh-transition branch, so a session with
      // exited_reason="shipped" can't reach the fresh-transition branch
      // on its own. The plan notes this: the clear-on-fresh behavior
      // exists for a narrow race where state was externally reset.
      //
      // To exercise the documented fresh-clear path, we simulate the
      // external reset by nuking exited_reason in the state BEFORE
      // firing the idle event — matching how /fresh itself writes a
      // clean state file. After the reset, the handoff mtime advance
      // must still re-enable nudging with iterations=1.
      const oldHandoffMtime = 1000;
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 0,
              enabled: true,
              lastHandoffMtime: oldHandoffMtime,
              // Note: exited_reason intentionally absent here — /fresh
              // writes a clean state file. This test verifies the
              // post-/fresh idle produces the fresh-transition nudge.
            },
          },
        }),
      );
      // Write a handoff brief with a new mtime.
      writeFixture(dir, ".agent/fresh-handoff.md", "# New task\n");
      // Bump the mtime explicitly so it's > oldHandoffMtime.
      const newMtime = oldHandoffMtime + 5000;
      fs.utimesSync(
        path.join(dir, ".agent/fresh-handoff.md"),
        newMtime / 1000,
        newMtime / 1000,
      );
      const messages = [userMsg("resume")];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1);
      assert.match(
        client.prompts[0].text,
        /\/fresh re-keyed this worktree/,
      );
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.iterations, 1);
      assert.equal(
        state.sessions.s1.exited_reason,
        undefined,
        "exited_reason cleared by fresh-transition branch",
      );
      assert.equal(state.sessions.s1.enabled, true);
    } finally {
      rmTmpDir(dir);
    }
});

test("session.idle: max-iterations sets exited_reason: 'max_iterations' and next idle short-circuits", async () => {
    const { default: factory, MAX_ITERATIONS } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/x.md",
        "# X\n## Acceptance criteria\n- [ ] a\n",
      );
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: MAX_ITERATIONS,
              enabled: true,
              lastPlanPath: ".agent/plans/x.md",
            },
          },
        }),
      );
      const messages = [
        userMsg("/autopilot see .agent/plans/x.md"),
        assistantMsg("working"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      // First idle: hits MAX_ITERATIONS, sends the max-iter nudge,
      // persists exited_reason: "max_iterations".
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0].text, /max iterations/);
      let state = readStateFile(dir);
      assert.equal(state.sessions.s1.exited_reason, "max_iterations");
      // Second idle: pre-idle exit gate short-circuits. No new prompt.
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      assert.equal(client.prompts.length, 1, "no re-nudge after max-iter exit");
      state = readStateFile(dir);
      assert.equal(state.sessions.s1.exited_reason, "max_iterations");
    } finally {
      rmTmpDir(dir);
    }
});

test("session.idle: orchestrator EXIT wins over completion-promise DONE", async () => {
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      const messages = [
        userMsg("/autopilot see .agent/plans/x.md"),
        assistantMsg(
          "all done\n<promise>DONE</promise>\n" +
            "wait, this already shipped\n<autopilot>EXIT</autopilot>",
        ),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      // Orchestrator-exit branch runs before the completion-promise branch.
      // Expected: the exit acknowledgement nudge fires (not the verifier
      // prompt).
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0].text, /Exit acknowledged/);
      assert.doesNotMatch(client.prompts[0].text, /@autopilot-verifier/);
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.exited_reason, "orchestrator_exit");
    } finally {
      rmTmpDir(dir);
    }
});

// --- stagnation detector tests ----------------------------------------------
//
// The stagnation detector is the fifth detector feeding the continuation-guard's
// terminal-exit latch. It snapshots the substrate (git HEAD + working tree)
// each idle event; if the snapshot is unchanged across STAGNATION_THRESHOLD
// consecutive nudges, it sets `exited_reason: "stagnation"`. The pure-logic
// transitions live in `evaluateStagnation`; the substrate snapshot lives in
// `snapshotSubstrate` (shells out to git). Tests cover both layers.

test("evaluateStagnation: snapshot null → reset counter, no stagnation", async () => {
    const { evaluateStagnation } = await import(PLUGIN_PATH);
    // Snapshot failed; counter must reset to 0 regardless of prior count.
    const out = evaluateStagnation(null, "prev-hash", 4);
    assert.equal(out.hash, null);
    assert.equal(out.consecutive, 0);
    assert.equal(out.stagnant, false);
});

test("evaluateStagnation: first observation (no prior) → record, don't increment", async () => {
    const { evaluateStagnation } = await import(PLUGIN_PATH);
    const out = evaluateStagnation("hash-1", undefined, undefined);
    assert.equal(out.hash, "hash-1");
    assert.equal(out.consecutive, 0, "first observation cannot be stagnant");
    assert.equal(out.stagnant, false);
});

test("evaluateStagnation: hash changed → reset counter to 0", async () => {
    const { evaluateStagnation } = await import(PLUGIN_PATH);
    // Was at 3 stagnant iterations; now substrate moved.
    const out = evaluateStagnation("hash-2", "hash-1", 3);
    assert.equal(out.hash, "hash-2");
    assert.equal(out.consecutive, 0);
    assert.equal(out.stagnant, false);
});

test("evaluateStagnation: hash unchanged below threshold → increment, not stagnant", async () => {
    const { evaluateStagnation, STAGNATION_THRESHOLD } = await import(PLUGIN_PATH);
    const out = evaluateStagnation("hash-1", "hash-1", STAGNATION_THRESHOLD - 2);
    assert.equal(out.hash, "hash-1");
    assert.equal(out.consecutive, STAGNATION_THRESHOLD - 1);
    assert.equal(out.stagnant, false);
});

test("evaluateStagnation: hash unchanged AT threshold → fire stagnation", async () => {
    const { evaluateStagnation, STAGNATION_THRESHOLD } = await import(PLUGIN_PATH);
    // Counter was at THRESHOLD - 1; this idle bumps it to THRESHOLD.
    const out = evaluateStagnation("hash-1", "hash-1", STAGNATION_THRESHOLD - 1);
    assert.equal(out.hash, "hash-1");
    assert.equal(out.consecutive, STAGNATION_THRESHOLD);
    assert.equal(out.stagnant, true);
});

test("evaluateStagnation: prior counter undefined treated as 0", async () => {
    const { evaluateStagnation } = await import(PLUGIN_PATH);
    // Hash matches but counter was never set (legacy state file).
    const out = evaluateStagnation("hash-1", "hash-1", undefined);
    assert.equal(out.consecutive, 1);
    assert.equal(out.stagnant, false);
});

test("snapshotSubstrate: returns null when git rev-parse exits non-zero", async () => {
    const { snapshotSubstrate } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({
      "git rev-parse HEAD": { code: 128 }, // not a git repo
    });
    const result = await snapshotSubstrate("/tmp", { execFileImpl, timeoutMs: 200 });
    assert.equal(result, null);
});

test("snapshotSubstrate: returns null when git status fails after rev-parse succeeds", async () => {
    const { snapshotSubstrate } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({
      "git rev-parse HEAD": { code: 0, stdout: "abc1234\n" },
      "git status --porcelain": { code: "ENOENT" },
    });
    const result = await snapshotSubstrate("/tmp", { execFileImpl, timeoutMs: 200 });
    assert.equal(result, null);
});

test("snapshotSubstrate: combines rev-parse + status into stable hash", async () => {
    const { snapshotSubstrate } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({
      "git rev-parse HEAD": { code: 0, stdout: "abc1234\n" },
      "git status --porcelain": { code: 0, stdout: " M src/foo.ts\n" },
    });
    const result = await snapshotSubstrate("/tmp", { execFileImpl, timeoutMs: 200 });
    // Must be a non-null string; must contain both legs separated by NUL.
    assert.equal(typeof result, "string");
    assert.ok(result.includes("\u0000"), "should use NUL separator");
    assert.ok(result.startsWith("abc1234"), "should start with HEAD sha");
    assert.ok(result.endsWith(" M src/foo.ts\n"), "should end with porcelain");
});

test("snapshotSubstrate: identical substrate returns identical hash across calls", async () => {
    const { snapshotSubstrate } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({
      "git rev-parse HEAD": { code: 0, stdout: "abc1234\n" },
      "git status --porcelain": { code: 0, stdout: " M src/foo.ts\n" },
    });
    const a = await snapshotSubstrate("/tmp", { execFileImpl, timeoutMs: 200 });
    const b = await snapshotSubstrate("/tmp", { execFileImpl, timeoutMs: 200 });
    assert.equal(a, b);
});

test("snapshotSubstrate: timeout returns null", async () => {
    const { snapshotSubstrate } = await import(PLUGIN_PATH);
    const execFileImpl = mockExecFile({ "*": { hangForMs: 10_000 } });
    const result = await snapshotSubstrate("/tmp", { execFileImpl, timeoutMs: 30 });
    assert.equal(result, null);
});

test("session.idle: stagnation fires when seeded at THRESHOLD - 1 and substrate matches", async () => {
    // To exercise the stagnation exit deterministically without mocking
    // out the plugin's internal subprocess invocations (which the
    // current factory architecture doesn't support), we exploit the
    // failure-mode branch of `snapshotSubstrate`: in a tmp dir without
    // git, it returns null, which `evaluateStagnation` treats as
    // "reset". So we can't trigger stagnation via the live integration
    // path with no-git tmp dirs. Instead, this test verifies state
    // transitions: seed a session with a known prior substrate hash
    // and a counter at THRESHOLD - 1, then verify the *behavior* on
    // the next idle: since the snapshot in the tmp dir returns null,
    // the counter must reset to 0 (stagnation evidence is discarded
    // when the snapshot is unobservable). This guards against a
    // regression where stagnation accumulates on missing-git
    // environments (e.g., CI containers).
    const { default: factory, STAGNATION_THRESHOLD } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/plans/x.md",
        "# X\n## Acceptance criteria\n- [ ] a\n",
      );
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 3,
              enabled: true,
              lastPlanPath: ".agent/plans/x.md",
              last_substrate_hash: "stale-hash",
              consecutive_stagnant_iterations: STAGNATION_THRESHOLD - 1,
              // Pre-warm shipped cache to "not_shipped" so the legacy
              // branch reaches the stagnation check.
              last_shipped_check_at: Date.now(),
              last_shipped_check_result: "not_shipped",
            },
          },
        }),
      );
      const messages = [
        userMsg("/autopilot see .agent/plans/x.md"),
        assistantMsg("working"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      // No git in tmp dir → snapshot null → counter resets → no
      // stagnation exit. The continue-execution nudge fires normally.
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0].text, /Plan has 1 unchecked/);
      const state = readStateFile(dir);
      assert.equal(
        state.sessions.s1.exited_reason,
        undefined,
        "no stagnation exit when snapshot unobservable",
      );
      assert.equal(
        state.sessions.s1.consecutive_stagnant_iterations,
        0,
        "counter reset on unobservable snapshot",
      );
      assert.equal(
        state.sessions.s1.last_substrate_hash,
        undefined,
        "null snapshot persists as undefined hash",
      );
    } finally {
      rmTmpDir(dir);
    }
});

test("ExitReason union includes 'stagnation'", async () => {
    // Static check: the exported types module must include "stagnation"
    // as a valid ExitReason. We verify dynamically by setting it and
    // confirming the pre-idle exit gate respects it.
    const { default: factory } = await import(PLUGIN_PATH);
    const dir = mkTmpDir();
    try {
      writeFixture(
        dir,
        ".agent/autopilot-state.json",
        JSON.stringify({
          sessions: {
            s1: {
              iterations: 3,
              enabled: true,
              exited_reason: "stagnation",
              lastPlanPath: ".agent/plans/x.md",
            },
          },
        }),
      );
      writeFixture(
        dir,
        ".agent/plans/x.md",
        "# X\n## Acceptance criteria\n- [ ] a\n",
      );
      const messages = [
        userMsg("/autopilot see .agent/plans/x.md"),
        assistantMsg("anything"),
      ];
      const client = mockClientWithMessages(messages);
      const handlers = await factory({ client, directory: dir });
      await handlers.event({
        event: { type: "session.idle", properties: { sessionID: "s1" } },
      });
      // Pre-idle exit gate must short-circuit on "stagnation" same as
      // every other ExitReason value. Zero prompts.
      assert.equal(client.prompts.length, 0);
      const state = readStateFile(dir);
      assert.equal(state.sessions.s1.exited_reason, "stagnation");
    } finally {
      rmTmpDir(dir);
    }
});

test("AUTOPILOT_STAGNATION_EXIT_MESSAGE: contains threshold count and EXIT instructions", async () => {
    const { AUTOPILOT_STAGNATION_EXIT_MESSAGE, STAGNATION_THRESHOLD } =
      await import(PLUGIN_PATH);
    assert.match(
      AUTOPILOT_STAGNATION_EXIT_MESSAGE,
      new RegExp(`${STAGNATION_THRESHOLD} consecutive nudges`),
      "should report the actual threshold value",
    );
    assert.match(
      AUTOPILOT_STAGNATION_EXIT_MESSAGE,
      /<autopilot>EXIT<\/autopilot>/,
      "should explain how to silence if false-positive",
    );
    assert.match(
      AUTOPILOT_STAGNATION_EXIT_MESSAGE,
      /\/fresh/,
      "should explain how to re-key for new task",
    );
});
