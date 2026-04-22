import type { Plugin } from "@opencode-ai/plugin";
import { execFile, type ExecFileException } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Reason an autopilot session terminated. When set, the session is
 * considered terminally exited — no further nudges fire on idle events
 * until a `/fresh` re-key clears it. This is the **continuation-guard**:
 * five independent detectors (shipped-probe, user-stop, orchestrator-exit,
 * max-iterations, stagnation) all funnel into the same `exited_reason`
 * field, and a single short-circuit at the top of the idle handler
 * (`pre-idle exit gate`) drops every future nudge once any detector
 * fires. Explicit string literal union (not an enum) so the value
 * survives JSON round-trips in `.agent/autopilot-state.json`.
 *
 * Values:
 * - `"shipped"` — the shipped-probe detected the underlying work has
 *   already landed (merged PR or git merge-base shows HEAD is an ancestor of
 *   origin/main). This is the original class-of-bug that motivated the
 *   exit-gate design: without this, the loop kept firing "continue
 *   execution" nudges on a plan whose work had shipped, pressuring the
 *   orchestrator into rationalizing scope violations to silence it.
 * - `"user_stop"` — the user's chat message contained an explicit stop
 *   token (STOP / HALT / "stop autopilot" / similar). User-stop ALWAYS
 *   wins; this is a safety-critical path.
 * - `"orchestrator_exit"` — the orchestrator emitted the sentinel
 *   `<autopilot>EXIT</autopilot>` on its own line. Cooperative self-cancel
 *   when the orchestrator recognizes the loop is wrong (e.g., stale plan).
 * - `"max_iterations"` — the MAX_ITERATIONS cap fired. Funneled through
 *   the same exit gate so subsequent idles don't re-enter the legacy
 *   nudge-loop at iteration 0 (the old behavior reset iterations to 0,
 *   which caused a subtle re-entry bug at the boundary).
 * - `"stagnation"` — the substrate (git HEAD + working tree) hasn't
 *   changed across `STAGNATION_THRESHOLD` consecutive nudges. Catches
 *   the "loop is running but nothing is happening on disk" failure mode
 *   that shipped-detection misses (work is happening locally but not
 *   landing) and that plan-checkbox-counting misses (boxes get ticked
 *   without any code changing). Ported from omo's stagnation-detection
 *   hook, adapted to git substrate rather than todo-list count.
 */
type ExitReason =
  | "shipped"
  | "user_stop"
  | "orchestrator_exit"
  | "max_iterations"
  | "stagnation";

/**
 * Result of `checkShipped`. Three-valued because we must distinguish
 * "definitively shipped" from "definitively not shipped" from "unable
 * to determine" — only the first triggers the shipped-exit nudge; the
 * other two fall through to the existing nudge flow.
 */
type ShippedCheckResult = "shipped" | "not_shipped" | "unknown";

interface SessionAutopilot {
  iterations: number;
  lastPlanPath?: string;
  /** Epoch ms of the most recently observed .agent/fresh-handoff.md. Used to
   * detect a /fresh re-key between autopilot iterations and switch the nudge
   * from "continue this plan" to "new task — read the handoff brief". */
  lastHandoffMtime?: number;
  /** True after the orchestrator emitted <promise>DONE</promise> and the
   * plugin injected AUTOPILOT_VERIFICATION_PROMPT; cleared when a verdict
   * is observed, when max iterations is hit, or when the user intervenes. */
  verification_pending?: boolean;
  /** Optional, diagnostic-only: the subagent session ID recorded at
   * DONE→verifier handoff time. Not currently used for control flow. */
  verification_session_id?: string;
  /** Counter for "DONE emitted but no recognizable verdict in follow-up
   * messages" events. Reset on any valid verdict. When it reaches 3, we
   * also bump `iterations` so runaway missing-verdict loops cannot
   * outlast MAX_ITERATIONS. */
  consecutive_missing_verdicts?: number;
  /** Autopilot is opt-in. This flag is set to `true` ONLY after an explicit
   * activation signal is detected (see `detectActivation`). When `false` or
   * `undefined`, every nudge branch returns early without writing state or
   * injecting prompts. Once `true`, it stays `true` for the session's
   * lifetime — user messages reset iterations (Rule of engagement: "user
   * message always wins over in-flight verification state") but do NOT
   * exit autopilot mode. */
  enabled?: boolean;
  /** Epoch ms of the most recent `promptAsync` call from this plugin.
   * Used to debounce rapid `session.idle` events so we don't fire the same
   * nudge twice in a row when opencode emits multiple idle events during
   * tool-call loops. */
  lastNudgeAt?: number;
  /** Terminal-exit reason. When set, the pre-idle exit gate short-circuits
   * all nudges. Cleared only on `/fresh` re-key (fresh-transition branch).
   * This is the unified continuation-guard exit signal, set by the
   * shipped-probe, user-stop-token detection, orchestrator EXIT
   * sentinel, the max-iterations cap, or the stagnation detector.
   * Backward-compatible: older state files without this field behave
   * as today (no exit). */
  exited_reason?: ExitReason;
  /** Epoch ms of the most recent `checkShipped` invocation. Used with
   * `last_shipped_check_result` to TTL-cache the shipped-PR verdict per
   * session, so rapid idle events don't spawn `git` / `gh` on every
   * event. Cache window: SHIPPED_CHECK_CACHE_MS (60 s). */
  last_shipped_check_at?: number;
  /** Cached result of the most recent `checkShipped` invocation. Consumed
   * together with `last_shipped_check_at` for TTL gating. */
  last_shipped_check_result?: ShippedCheckResult;
  /** SHA-style hash of the most recent observed substrate state
   * (`git rev-parse HEAD` ⊕ `git status --porcelain`). Used by the
   * stagnation detector to recognize when the loop is firing nudges
   * but neither the commit graph nor the working tree is changing.
   * `undefined` on first observation (we record but don't increment). */
  last_substrate_hash?: string;
  /** Number of consecutive continuation-guard idles where the substrate
   * hash matched the previous observation. Reset to 0 whenever the
   * hash changes. When this reaches `STAGNATION_THRESHOLD`, the
   * stagnation detector sets `exited_reason: "stagnation"`. */
  consecutive_stagnant_iterations?: number;
}

interface AutopilotState {
  sessions: Record<string, SessionAutopilot>;
}

const STATE_PATH = ".agent/autopilot-state.json";
const HANDOFF_PATH = ".agent/fresh-handoff.md";
const MAX_ITERATIONS = 20;
const MAX_MISSING_VERDICTS = 3;
const TARGET_AGENTS = new Set(["build", "orchestrator"]);
const MESSAGE_LIMIT = 60;
const NUDGE_DEBOUNCE_MS = 30_000;

/**
 * Per-invocation timeout for each shell-out inside `checkShipped`
 * (`git merge-base`, `git rev-parse`, `gh pr list`). The event loop must
 * never block on a hung subprocess. Exported for tests to override with
 * a much smaller value (typically 50 ms) so the timeout path is reachable
 * quickly.
 */
const SHIPPED_CHECK_TIMEOUT_MS = 2_000;

/**
 * TTL for the per-session shipped-PR verdict cache. Under rapid
 * `session.idle` storms (opencode emits idle events on every tool-call
 * boundary) we don't want to spawn `git` / `gh` on every event. A 60 s
 * window is long enough to collapse idle-storms, short enough that a
 * just-merged PR is noticed quickly. Exported for tests to override.
 */
const SHIPPED_CHECK_CACHE_MS = 60_000;

/**
 * Number of consecutive idle events with an unchanged substrate hash
 * (git HEAD + working tree) before the stagnation detector fires.
 * Set to 5 to match omo's `MAX_CONSECUTIVE_FAILURES` budget while
 * leaving headroom for legitimate "thinking" phases that produce no
 * disk changes (research, planning, reading code). Exported for tests
 * to override with a smaller value.
 */
const STAGNATION_THRESHOLD = 5;

/**
 * Per-invocation timeout for the substrate-snapshot subprocesses
 * (`git rev-parse HEAD`, `git status --porcelain`). Same shape as
 * `SHIPPED_CHECK_TIMEOUT_MS` but separately overridable so tests can
 * exercise the stagnation timeout path without affecting shipped-check
 * timing. Defaults to 1 s — substrate snapshot is cheaper than the
 * shipped-PR check (no network, no `gh`).
 */
const SUBSTRATE_CHECK_TIMEOUT_MS = 1_000;

const COMPLETION_PROMISE_TOKEN = "<promise>DONE</promise>";
const VERDICT_RE = /^\[AUTOPILOT_(VERIFIED|UNVERIFIED)\]\s*$/m;

/**
 * Sentinel the orchestrator emits to cooperatively cancel autopilot for
 * the current session. Detected by `findOrchestratorExit` (same shape as
 * `findCompletionPromise`). The regex requires the sentinel to be on its
 * own line (multiline + start/end anchors) so an inline mention in prose
 * ("see `<autopilot>EXIT</autopilot>` inline") does not false-positive.
 */
const AUTOPILOT_EXIT_RE = /^<autopilot>EXIT<\/autopilot>\s*$/m;

/**
 * User-stop token detection, split into two regexes per the plan's
 * "false-positive avoidance" rule:
 *
 * - `USER_STOP_BARE_RE` — case-SENSITIVE; matches uppercase `STOP` or
 *   `HALT` as whole words. Case-sensitive so casual lowercase "stop" in
 *   prose like "please don't stop the tests early" does NOT false-trigger.
 *   The user must type `STOP` or `HALT` in all caps to hit this path — a
 *   deliberate, shout-y signal.
 * - `USER_STOP_PHRASE_RE` — case-insensitive; matches phrases
 *   "stop autopilot", "kill autopilot", "disable autopilot", "exit autopilot".
 *   These are unambiguous intent.
 *
 * `detectUserStopToken` returns true if EITHER matches.
 */
const USER_STOP_BARE_RE = /\b(STOP|HALT)\b/;
const USER_STOP_PHRASE_RE = /\b(stop|kill|disable|exit)\s+autopilot\b/i;

// Activation signals (see `detectActivation`). The `/autopilot` slash command
// shows up in the session transcript as a literal `/autopilot` token in the
// first user message; the orchestrator prompt's AUTOPILOT mode is gated on the
// literal string `AUTOPILOT mode` in the incoming message body (see
// `home/.claude/agents/orchestrator.md` § Autopilot mode). Fresh-handoff
// transitions triggered by `/plan-loop` always imply autopilot — that's what
// `/plan-loop` is for.
const AUTOPILOT_MARKER_RE = /(^|\s)\/autopilot(\s|$)|AUTOPILOT mode/;

// Prompt constants injected back into the session as continuation nudges.
// Keep them short — they ride on top of the orchestrator's context budget.

const AUTOPILOT_VERIFICATION_PROMPT = (planPath: string): string =>
  `[autopilot] Completion promise detected. Delegate to \`@autopilot-verifier\` via the task tool with the plan path \`${planPath}\` and a 2-3 sentence summary of what you did. Ask the verifier to review skeptically — look for reasons the task may still be incomplete or wrong. Treat the verifier's verdict as ground truth.`;

const AUTOPILOT_VERIFICATION_FAILED_PROMPT =
  "[autopilot] Verifier returned `[AUTOPILOT_UNVERIFIED]`. Address each numbered reason literally — do not argue with the verdict. When you believe the work is truly complete, re-emit `<promise>DONE</promise>` on its own line.";

const AUTOPILOT_VERIFICATION_MISSING_PROMPT =
  "[autopilot] Verifier response did not contain a recognizable verdict. Report the verifier's verdict literally as `[AUTOPILOT_VERIFIED]` or `[AUTOPILOT_UNVERIFIED]` on its own line. If the verifier failed to run, re-invoke it.";

const AUTOPILOT_COMPLETE_MESSAGE = (planPath: string): string =>
  `[autopilot] Verified. Ready for \`/ship ${planPath}\`.`;

const AUTOPILOT_MAX_ITERATIONS_MESSAGE =
  `[autopilot] Stopped: hit max iterations (${MAX_ITERATIONS}). ` +
  `Either the work is complete or stuck. Review and resume manually if needed. ` +
  `If the work is complete, emit \`<promise>DONE</promise>\` on its own line to re-enter the verifier loop.`;

/**
 * One-shot nudge sent when `checkShipped` returns `"shipped"`. The message
 * is intentionally clear-exit: tells the orchestrator the work is already
 * shipped, no further nudges will fire, and how to re-enable autopilot
 * if the detection was wrong (emit the EXIT sentinel or run `/fresh`).
 */
const AUTOPILOT_SHIPPED_EXIT_MESSAGE =
  "[autopilot] Exiting: the underlying work has already shipped " +
  "(detected via merged PR or `git merge-base --is-ancestor HEAD origin/main`). " +
  "No further nudges this session. If you believe this is wrong, emit " +
  "`<autopilot>EXIT</autopilot>` yourself to silence this message, or invoke " +
  "`/fresh` to re-key for a new task.";

/**
 * One-shot nudge sent when the user's chat message contains a stop token
 * (see `detectUserStopToken`). User-stop is safety-critical: the loop
 * MUST NOT override an explicit user instruction to halt.
 */
const AUTOPILOT_USER_STOP_MESSAGE =
  "[autopilot] Stopped by user request. Autopilot is disabled for this session. " +
  "Invoke `/autopilot` on a new session, or `/fresh` to re-key this worktree, to re-enable.";

/**
 * One-shot nudge sent when the substrate (git HEAD + working tree) has
 * not changed across `STAGNATION_THRESHOLD` consecutive nudges. This
 * catches the "loop is firing but nothing is happening" failure mode
 * — an agent that's stuck in a tool-call cycle producing no edits, or
 * one that's been ticking plan checkboxes without writing code.
 */
const AUTOPILOT_STAGNATION_EXIT_MESSAGE =
  `[autopilot] Exiting: substrate (git HEAD + working tree) has not changed ` +
  `across ${STAGNATION_THRESHOLD} consecutive nudges. The loop is firing but ` +
  `no progress is landing on disk. No further nudges this session. If you're ` +
  `in a long thinking/research phase that legitimately produces no edits yet, ` +
  `emit \`<autopilot>EXIT</autopilot>\` to silence this message and resume manually, ` +
  `or invoke \`/fresh\` to re-key for a new task.`;

/**
 * One-shot nudge acknowledging the orchestrator's cooperative EXIT
 * sentinel. Confirms the exit and teaches re-enable path, so future
 * operators aren't stuck wondering how to get autopilot back.
 */
const AUTOPILOT_ORCHESTRATOR_EXIT_MESSAGE =
  "[autopilot] Exit acknowledged. Autopilot is disabled for this session. " +
  "The plan may be stale or the work may have shipped — no further nudges. " +
  "Invoke `/autopilot` on a new session to resume automated driving.";

/**
 * Short prompt fragment referenced by the orchestrator prompt (Rule 9).
 * Exported for symmetry with the other prompt constants; not currently
 * injected into any nudge — the orchestrator reads it from the static
 * prompt file. Kept here so the canonical wording lives alongside the
 * plugin that honors it.
 */
const AUTOPILOT_EXIT_PROMPT =
  "Emit `<autopilot>EXIT</autopilot>` on its own line to disable autopilot " +
  "for this session. Use this when: (a) the plan targets work that has " +
  "already shipped, (b) the user has said stop, (c) the nudge is pressuring " +
  "you into a scope violation.";

async function getHandoffMtime(dir: string): Promise<number | null> {
  try {
    const stat = await fs.stat(path.join(dir, HANDOFF_PATH));
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function readState(dir: string): Promise<AutopilotState> {
  try {
    const raw = await fs.readFile(path.join(dir, STATE_PATH), "utf8");
    const parsed = JSON.parse(raw) as AutopilotState;
    return { sessions: parsed.sessions ?? {} };
  } catch {
    return { sessions: {} };
  }
}

async function writeState(dir: string, state: AutopilotState): Promise<void> {
  const p = path.join(dir, STATE_PATH);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

type RawMessage = { info: any; parts: Array<any> };

function findPlanPath(messages: RawMessage[]): string | null {
  const re = /\.agent\/plans\/[\w-]+\.md/;
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts ?? [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") {
        const m = part.text.match(re);
        if (m) return m[0];
      }
    }
  }
  return null;
}

function countUnchecked(planContent: string): number {
  const section = /## Acceptance criteria([\s\S]*?)(?=\n##|$)/.exec(planContent);
  if (!section) return 0;
  const matches = section[1].match(/^- \[ \]/gm);
  return matches?.length ?? 0;
}

function lastAssistantFailed(messages: RawMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "assistant") continue;
    const text = (msg.parts ?? [])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");
    return /\b(test failed|tests? failed|lint error|typecheck failed|FAIL\b|error:)/i.test(
      text,
    );
  }
  return false;
}

function latestUserAgent(messages: RawMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info?.role === "user" && typeof info.agent === "string") {
      return info.agent;
    }
  }
  return undefined;
}

/**
 * Extract the concatenated text content from an assistant message. Non-text
 * parts are skipped. Returns "" if the message has no text parts.
 */
function assistantText(msg: RawMessage): string {
  if (msg.info?.role !== "assistant") return "";
  const parts = msg.parts ?? [];
  return parts
    .filter((p: any) => p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text as string)
    .join("\n");
}

/**
 * Extract the concatenated text content from a user message. Non-text parts
 * are skipped. Returns "" if the message has no text parts.
 */
function userText(msg: RawMessage): string {
  if (msg.info?.role !== "user") return "";
  const parts = msg.parts ?? [];
  return parts
    .filter((p: any) => p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text as string)
    .join("\n");
}

/**
 * Scan messages for the literal <promise>DONE</promise> token in assistant
 * text parts. Returns the index of the most recent message containing it,
 * or null if no message contains it.
 */
function findCompletionPromise(
  messages: RawMessage[],
): { found: true; msgIdx: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = assistantText(messages[i]);
    if (text.includes(COMPLETION_PROMISE_TOKEN)) {
      return { found: true, msgIdx: i };
    }
  }
  return null;
}

/**
 * Scan messages strictly after `afterMsgIdx` for a line matching
 * `[AUTOPILOT_VERIFIED]` or `[AUTOPILOT_UNVERIFIED]` as the first
 * non-whitespace content on its own line. Returns the matched variant,
 * or null if no recognizable verdict is found.
 */
function findVerifierVerdict(
  messages: RawMessage[],
  afterMsgIdx: number,
): "VERIFIED" | "UNVERIFIED" | null {
  for (let i = afterMsgIdx + 1; i < messages.length; i++) {
    const parts = messages[i].parts ?? [];
    for (const part of parts) {
      if (part.type !== "text" || typeof part.text !== "string") continue;
      const m = part.text.match(VERDICT_RE);
      if (m) return m[1] as "VERIFIED" | "UNVERIFIED";
    }
  }
  return null;
}

/**
 * Scan assistant messages for the orchestrator's cooperative EXIT
 * sentinel (`<autopilot>EXIT</autopilot>` on its own line). Returns the
 * index of the most recent message containing it, or null. Mirrors
 * `findCompletionPromise`'s shape so callers handle both identically.
 */
function findOrchestratorExit(
  messages: RawMessage[],
): { found: true; msgIdx: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = assistantText(messages[i]);
    if (AUTOPILOT_EXIT_RE.test(text)) {
      return { found: true, msgIdx: i };
    }
  }
  return null;
}

/**
 * Detect an explicit user stop instruction. Returns true if the input
 * matches either the case-SENSITIVE bare-token regex (STOP / HALT) OR the
 * case-insensitive phrase regex ("stop autopilot" / "kill autopilot" /
 * "disable autopilot" / "exit autopilot").
 *
 * The case-sensitivity on bare tokens is deliberate: lowercase "stop" in
 * prose ("don't stop the tests early") is ambiguous and would false-trigger
 * too often. Requiring uppercase for the bare form means the user has to
 * deliberately shout STOP — a clear intent signal. The phrase form is
 * always unambiguous so it's case-insensitive.
 */
function detectUserStopToken(text: string): boolean {
  if (!text) return false;
  return USER_STOP_BARE_RE.test(text) || USER_STOP_PHRASE_RE.test(text);
}

/**
 * Callback shape matching Node's `child_process.execFile(file, args, opts, cb)`.
 * Extracted as a type so tests can inject a mock without importing real
 * `child_process` in the test harness.
 */
type ExecFileImpl = (
  file: string,
  args: readonly string[],
  opts: { signal?: AbortSignal; timeout?: number; cwd?: string },
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

/**
 * Promise-ified, timeout-guarded wrapper around `child_process.execFile`.
 * Resolves to a `{ stdout, code }` result where `code` is the exit code
 * (0 on success; the error's `.code` numeric value otherwise; null on
 * signal/timeout/ENOENT). Never rejects — every failure mode becomes a
 * non-zero `code` so the caller can branch on it without try/catch.
 *
 * The caller is expected to treat any `code !== 0` as "check failed for
 * this leg; proceed to the next leg" within `checkShipped`.
 */
function runCheck(
  execFileImpl: ExecFileImpl,
  cwd: string,
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null; signalled: boolean }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let settled = false;
    const done = (
      stdout: string,
      code: number | null,
      signalled: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code, signalled });
    };
    try {
      execFileImpl(
        file,
        args,
        { signal: controller.signal, cwd },
        (err, stdout) => {
          if (err) {
            // AbortController signals through err.code === "ABORT_ERR" on
            // modern Node, or err.signal === "SIGTERM" on older. Either way,
            // normalize to "signalled = true" so the caller can distinguish
            // timeout from a genuine non-zero exit.
            const maybe = err as ExecFileException & {
              code?: number | string;
            };
            const signalled =
              maybe.code === "ABORT_ERR" || maybe.signal != null;
            // Numeric code comes through on real subprocess exits; string
            // codes (ENOENT, ABORT_ERR) come through on spawn failures.
            const code =
              typeof maybe.code === "number" ? maybe.code : null;
            done(stdout ?? "", code, signalled);
            return;
          }
          done(stdout ?? "", 0, false);
        },
      );
    } catch {
      // execFile itself threw synchronously (e.g., invalid args). Treat
      // as unknown and move on.
      done("", null, false);
    }
  });
}

/**
 * Shipped-probe: decide whether the work this autopilot session is
 * driving has already shipped. One of the five detectors that feed
 * the continuation-guard's terminal-exit latch. Runs two cheap checks:
 *
 * 1. `git merge-base --is-ancestor HEAD origin/main` — exit 0 means the
 *    current HEAD is an ancestor of origin/main, i.e. the branch is
 *    merged. Exit 1 means "not an ancestor" (continue). Any other exit
 *    code (command missing, not a repo, etc.) is inconclusive for this
 *    leg and we fall through to the gh check.
 * 2. `gh pr list --head <branch> --state merged --json number --limit 1` —
 *    stdout is a JSON array; non-empty → merged PR exists for this
 *    branch; empty → no merged PR; any error → unknown for this leg.
 *
 * Combined verdict:
 * - If either leg says "shipped" → `"shipped"`.
 * - If both legs say "not_shipped" → `"not_shipped"`.
 * - Otherwise (at least one leg is unknown, the other is not "shipped")
 *   → `"unknown"`.
 *
 * All subprocess errors / missing binaries / timeouts collapse to
 * "unknown". The helper NEVER throws. Event-loop safety is enforced via
 * a per-call AbortController with `SHIPPED_CHECK_TIMEOUT_MS` timeout.
 *
 * @param directory   CWD the subprocess runs in (the worktree root).
 * @param opts.branch Branch name to feed to `gh pr list --head`. Defaults
 *                    to `git rev-parse --abbrev-ref HEAD`. If the
 *                    resolved name is "HEAD" (detached), the gh leg is
 *                    skipped (no branch ref to query) and contributes
 *                    "unknown".
 * @param opts.execFileImpl  Injectable for tests. Defaults to real
 *                           `child_process.execFile`.
 * @param opts.timeoutMs  Per-subprocess timeout. Defaults to
 *                        `SHIPPED_CHECK_TIMEOUT_MS` (2 s).
 */
async function checkShipped(
  directory: string,
  opts: {
    branch?: string;
    execFileImpl?: ExecFileImpl;
    timeoutMs?: number;
  } = {},
): Promise<ShippedCheckResult> {
  const execFileImpl = opts.execFileImpl ?? (execFile as unknown as ExecFileImpl);
  const timeoutMs = opts.timeoutMs ?? SHIPPED_CHECK_TIMEOUT_MS;

  // Leg 1: git merge-base --is-ancestor HEAD origin/main
  // Exit 0 → shipped (HEAD is an ancestor of main). Exit 1 → not an
  // ancestor, keep checking. Anything else → unknown for this leg.
  let leg1: ShippedCheckResult;
  try {
    const res = await runCheck(
      execFileImpl,
      directory,
      "git",
      ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
      timeoutMs,
    );
    if (res.code === 0) leg1 = "shipped";
    else if (res.code === 1) leg1 = "not_shipped";
    else leg1 = "unknown";
  } catch {
    leg1 = "unknown";
  }
  if (leg1 === "shipped") return "shipped";

  // Leg 2: gh pr list --head <branch> --state merged --json number --limit 1
  // First resolve branch name if not given. Detached HEAD → skip leg 2.
  let branch = opts.branch;
  if (!branch) {
    try {
      const res = await runCheck(
        execFileImpl,
        directory,
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        timeoutMs,
      );
      const resolved = (res.stdout ?? "").trim();
      if (res.code === 0 && resolved && resolved !== "HEAD") {
        branch = resolved;
      }
    } catch {
      // Branch resolution failed; gh leg becomes unknown.
    }
  }

  let leg2: ShippedCheckResult;
  if (!branch) {
    // Detached HEAD or branch resolution failed — can't query gh. Leg 2
    // is unknown; combine with leg 1.
    leg2 = "unknown";
  } else {
    try {
      const res = await runCheck(
        execFileImpl,
        directory,
        "gh",
        [
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "merged",
          "--json",
          "number",
          "--limit",
          "1",
        ],
        timeoutMs,
      );
      if (res.code !== 0) {
        leg2 = "unknown";
      } else {
        try {
          const parsed = JSON.parse(res.stdout || "[]");
          if (Array.isArray(parsed) && parsed.length > 0) {
            leg2 = "shipped";
          } else if (Array.isArray(parsed)) {
            leg2 = "not_shipped";
          } else {
            leg2 = "unknown";
          }
        } catch {
          leg2 = "unknown";
        }
      }
    } catch {
      leg2 = "unknown";
    }
  }

  if (leg2 === "shipped") return "shipped";
  if (leg1 === "not_shipped" && leg2 === "not_shipped") return "not_shipped";
  return "unknown";
}

/**
 * Snapshot the current "substrate" — the externally-observable state
 * of the worktree that real progress would change. Returns a string
 * hash combining `git rev-parse HEAD` (commit graph) and
 * `git status --porcelain` (working tree + index). Identical strings
 * across consecutive calls mean nothing is changing on disk.
 *
 * Returns `null` if either subprocess fails (no `git` binary, not a
 * git repo, timeout, etc.). Callers MUST treat `null` as "unknown" —
 * not as "stagnant" — to avoid false-positive stagnation exits in
 * environments without git.
 *
 * Like `checkShipped`, this helper never throws and never blocks the
 * event loop beyond `SUBSTRATE_CHECK_TIMEOUT_MS` per subprocess.
 *
 * The hash format is intentionally simple: `<HEAD-sha>\u0000<porcelain-bytes>`.
 * No cryptographic guarantees needed — we only check equality, never
 * reconstruct. Using a NUL separator avoids any ambiguity if either
 * leg's stdout contains newlines (porcelain output usually does).
 */
async function snapshotSubstrate(
  directory: string,
  opts: {
    execFileImpl?: ExecFileImpl;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const execFileImpl =
    opts.execFileImpl ?? (execFile as unknown as ExecFileImpl);
  const timeoutMs = opts.timeoutMs ?? SUBSTRATE_CHECK_TIMEOUT_MS;

  let head: string;
  try {
    const res = await runCheck(
      execFileImpl,
      directory,
      "git",
      ["rev-parse", "HEAD"],
      timeoutMs,
    );
    if (res.code !== 0) return null;
    head = (res.stdout ?? "").trim();
    if (!head) return null;
  } catch {
    return null;
  }

  let porcelain: string;
  try {
    const res = await runCheck(
      execFileImpl,
      directory,
      "git",
      ["status", "--porcelain"],
      timeoutMs,
    );
    if (res.code !== 0) return null;
    porcelain = res.stdout ?? "";
  } catch {
    return null;
  }

  return `${head}\u0000${porcelain}`;
}

/**
 * Stagnation detector outcome. Composed by `evaluateStagnation` from
 * the current substrate snapshot and the previous-iteration cache.
 */
type StagnationOutcome = {
  /** Hash to persist as `last_substrate_hash`. May be `null` if the
   * snapshot itself failed — caller writes through verbatim so the
   * next iteration starts with the same "unknown" baseline. */
  hash: string | null;
  /** Counter to persist as `consecutive_stagnant_iterations`. Reset to
   * 0 on hash change OR snapshot failure (we don't accumulate
   * stagnation evidence on a leg we can't actually observe). */
  consecutive: number;
  /** True when `consecutive >= STAGNATION_THRESHOLD`. Caller fires the
   * stagnation-exit nudge and sets `exited_reason: "stagnation"`. */
  stagnant: boolean;
};

/**
 * Pure function: given the current snapshot and the previous-iteration
 * cache, decide what to persist and whether the stagnation threshold
 * has been crossed. Extracted so tests can exercise the state-transition
 * logic without spawning subprocesses or driving the full plugin.
 *
 * The function deliberately treats `currentHash === null` (snapshot
 * failed) as "reset the counter" rather than "increment" — we don't
 * want a missing `git` binary or a transient subprocess error to
 * accumulate false stagnation evidence and exit the loop.
 */
function evaluateStagnation(
  currentHash: string | null,
  previousHash: string | undefined,
  previousConsecutive: number | undefined,
): StagnationOutcome {
  // Snapshot failed: reset counter, persist null hash. The counter
  // restarts from 0 once snapshots succeed again.
  if (currentHash === null) {
    return { hash: null, consecutive: 0, stagnant: false };
  }
  // First observation (no previous hash): record but don't increment.
  // The first nudge after activation can't possibly be stagnant yet.
  if (previousHash === undefined) {
    return { hash: currentHash, consecutive: 0, stagnant: false };
  }
  // Substrate changed: real progress, reset.
  if (currentHash !== previousHash) {
    return { hash: currentHash, consecutive: 0, stagnant: false };
  }
  // Substrate unchanged: increment.
  const next = (previousConsecutive ?? 0) + 1;
  return {
    hash: currentHash,
    consecutive: next,
    stagnant: next >= STAGNATION_THRESHOLD,
  };
}

/**
 * Decide whether this session should have autopilot nudge-processing enabled.
 * Two activation signals, checked against the scanned messages + filesystem:
 *
 *   1. The **FIRST user message** in the session contains `AUTOPILOT mode` or
 *      a `/autopilot` token. This is the slash-command-invocation signal:
 *      the `/autopilot` command always lands as the initiating user message,
 *      and its prompt injects the literal marker `AUTOPILOT mode` into the
 *      orchestrator's incoming body. We scan ONLY the first user message
 *      (not every user message) to close a self-activation loophole:
 *
 *       - A marker appearing in a LATER user message is either (a) the
 *         user quoting context from an old transcript or pasting a
 *         document that mentions `/autopilot`, (b) a subsequent turn in
 *         an already-activated session — already handled by the `enabled`
 *         monotonic flag, or (c) a prompt-injection attempt. None of
 *         those three should retroactively activate a session that
 *         wasn't started with `/autopilot`.
 *       - Sticky-`enabled` preserves in-flight autopilot sessions
 *         unchanged: once `detectActivation` has returned `true` on the
 *         first idle event of a session, the caller sets `enabled: true`
 *         and this function is never re-consulted for that session.
 *       - Re-entry after a state-file wipe is effectively a new session
 *         from the plugin's POV; the first user message becomes the only
 *         activation carrier, matching the new-session interpretation.
 *
 *      "First user message" means the first entry in `messages` where
 *      `msg.info?.role === "user"` — so an assistant message appearing
 *      before the first user turn (e.g., an initial system-generated
 *      preamble) does not shift the scan.
 *
 *   2. A fresh-handoff transition just happened (handoff mtime advanced AND
 *      iterations is 0). `/plan-loop` is the only caller that writes the
 *      handoff brief, and it exists to hand off to autopilot — so any fresh
 *      transition implies autopilot. Signal 2 is independent of Signal 1
 *      and is unaffected by the first-user-message tightening.
 *
 * Once either signal fires, return `true` and the caller should set
 * `enabled: true` on the session. Never returns `false` as "disable"; callers
 * who see `false` should simply not flip the bit — `enabled` is monotonic
 * (it only goes off when the session state is wiped).
 */
function detectActivation(
  messages: RawMessage[],
  handoffMtime: number | null,
  lastSeenHandoff: number,
  currentIterations: number,
): boolean {
  // Signal 1: check the FIRST user message only. See the function doc
  // for the full rationale; briefly: later markers are either quoted
  // context, continuation of an already-active session, or injection
  // attempts — none should retroactively activate.
  for (const msg of messages) {
    if (msg.info?.role !== "user") continue;
    // First user message found. This is the only one we consult.
    if (AUTOPILOT_MARKER_RE.test(userText(msg))) return true;
    break;
  }
  // Signal 2: fresh-handoff transition. The `/plan-loop` skill writes the
  // handoff brief and only `/plan-loop` does that, so any advance is
  // implicitly autopilot. We check iterations === 0 to match the existing
  // fresh-transition guard elsewhere in the plugin.
  if (
    handoffMtime !== null &&
    handoffMtime > lastSeenHandoff &&
    currentIterations === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Debounced wrapper for `client.session.promptAsync`. Returns `true` if the
 * prompt was actually sent, `false` if it was suppressed by debounce. Callers
 * should NOT bump iterations or write state when suppressed — debounce exists
 * precisely to prevent duplicate state transitions under rapid idle events.
 */
async function sendNudgeDebounced(
  client: any,
  sessionID: string,
  sessState: SessionAutopilot,
  text: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (
    sessState.lastNudgeAt !== undefined &&
    now - sessState.lastNudgeAt < NUDGE_DEBOUNCE_MS
  ) {
    return false;
  }
  await client.session.promptAsync({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text }] },
  });
  sessState.lastNudgeAt = now;
  return true;
}

const plugin: Plugin = async ({ client, directory }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionID = event.properties.sessionID;

      const msgsResp = await client.session.messages({
        path: { id: sessionID },
        query: { limit: MESSAGE_LIMIT },
      });
      const messages = (msgsResp.data ?? []) as RawMessage[];

      // (1) Target-agent guard: only act for build/orchestrator.
      const agent = latestUserAgent(messages);
      if (!agent || !TARGET_AGENTS.has(agent)) return;

      const state = await readState(directory);
      const existingSessState = state.sessions[sessionID];
      const sessState: SessionAutopilot = existingSessState ?? { iterations: 0 };

      // (2) First-time-seed: seed lastHandoffMtime with the current brief's
      // mtime so we don't misread a pre-existing handoff as a new /fresh
      // transition. Nothing to nudge on yet; record state and wait for the
      // next idle event.
      if (!existingSessState) {
        const initialMtime = await getHandoffMtime(directory);
        state.sessions[sessionID] = {
          iterations: 0,
          lastHandoffMtime: initialMtime ?? undefined,
        };
        await writeState(directory, state);
        sessState.lastHandoffMtime = initialMtime ?? undefined;
        // Fall through — activation detection below may still flip `enabled`
        // on this very same idle event if the first user message contained
        // a `/autopilot` marker.
      }

      // (2a) Pre-idle exit gate. If this session has terminally exited
      // (via the shipped-probe, user-stop token, orchestrator's
      // cooperative EXIT sentinel, max-iterations cap, or stagnation
      // detector), short-circuit BEFORE any branch below can fire a
      // nudge. This is the central invariant of the continuation-guard.
      // Terminal exit is truly terminal — the only way back is a `/fresh`
      // re-key (which clears `exited_reason` in the fresh-transition
      // branch below) or a brand-new session.
      //
      // This is the central invariant that makes the continuation
      // loop safe: without it, the loop's escape conditions leaked
      // (e.g., max-iter reset iterations to 0 and the next idle
      // re-entered the legacy nudge branch at iteration 0, silently
      // restarting a loop that was supposed to have ended).
      if (sessState.exited_reason !== undefined) return;

      // (3) Activation detection. If not yet enabled, scan signals. Once
      // enabled, the flag is sticky — user messages reset iterations but
      // don't disable autopilot (see chat.message handler).
      const handoffMtime = await getHandoffMtime(directory);
      const lastSeenHandoff = sessState.lastHandoffMtime ?? 0;
      if (!sessState.enabled) {
        const activated = detectActivation(
          messages,
          handoffMtime,
          lastSeenHandoff,
          sessState.iterations,
        );
        if (!activated) {
          // Not an autopilot session. Do nothing — no nudge, no state write
          // beyond the first-time-seed above.
          return;
        }
        sessState.enabled = true;
      }

      // (3a) Orchestrator cooperative EXIT branch. If the assistant
      // emitted `<autopilot>EXIT</autopilot>` on its own line, acknowledge
      // and terminally exit. This branch runs BEFORE the completion-promise
      // branch so EXIT wins over DONE — if the orchestrator emitted both
      // (e.g., it finished, then realized the plan was stale), EXIT takes
      // precedence. Idempotent: next idle short-circuits at (2a).
      if (findOrchestratorExit(messages)) {
        const sent = await sendNudgeDebounced(
          client,
          sessionID,
          sessState,
          AUTOPILOT_ORCHESTRATOR_EXIT_MESSAGE,
        );
        if (sent) {
          state.sessions[sessionID] = {
            iterations: sessState.iterations,
            lastPlanPath: sessState.lastPlanPath,
            lastHandoffMtime: sessState.lastHandoffMtime,
            enabled: true,
            lastNudgeAt: sessState.lastNudgeAt,
            exited_reason: "orchestrator_exit",
          };
          await writeState(directory, state);
        }
        return;
      }

      // (4) Max-iterations cap. Funneled through the same exited_reason
      // exit gate so subsequent idles short-circuit at (2a). Unlike the
      // pre-omo behavior (which reset iterations to 0 and cleared
      // `enabled`), we now preserve iterations for forensic traceability
      // and set `exited_reason: "max_iterations"`. The cap is still a
      // one-shot nudge — the next idle exits at (2a).
      if (sessState.iterations >= MAX_ITERATIONS) {
        const sent = await sendNudgeDebounced(
          client,
          sessionID,
          sessState,
          AUTOPILOT_MAX_ITERATIONS_MESSAGE,
        );
        if (sent) {
          state.sessions[sessionID] = {
            iterations: sessState.iterations,
            lastPlanPath: sessState.lastPlanPath,
            lastHandoffMtime: sessState.lastHandoffMtime,
            enabled: true,
            lastNudgeAt: sessState.lastNudgeAt,
            exited_reason: "max_iterations",
          };
          await writeState(directory, state);
        }
        return;
      }

      // (5) Fresh-transition branch: if .agent/fresh-handoff.md is newer
      // than what we've seen AND iterations is 0 (indicating /fresh just
      // reset state), inject the handoff-brief nudge and wipe all verifier
      // fields — a fresh re-key is a clean slate, INCLUDING re-enabling
      // autopilot after a terminal exit. Since the (2a) pre-idle exit
      // gate would short-circuit before we get here on an exited session,
      // a terminally-exited session needs to be re-keyed via `/fresh` to
      // reach this branch; the explicit clearing of `exited_reason` below
      // is for the narrow race where the state file was externally reset
      // but the mtime bump arrived on the same idle event.
      const isFreshTransition =
        handoffMtime !== null &&
        handoffMtime > lastSeenHandoff &&
        sessState.iterations === 0;

      if (isFreshTransition) {
        const sent = await sendNudgeDebounced(
          client,
          sessionID,
          sessState,
          `[autopilot] /fresh re-keyed this worktree to a new task. ` +
            `Read \`${HANDOFF_PATH}\` for the full context (tracker ref, ` +
            `branch name, base branch, reset-hook output), then run the ` +
            `orchestrator five-phase workflow on the described work. ` +
            `Do NOT revisit prior plans in this session — they belong to ` +
            `the previous task.`,
        );
        if (sent) {
          state.sessions[sessionID] = {
            iterations: 1,
            lastHandoffMtime: handoffMtime,
            enabled: true,
            lastNudgeAt: sessState.lastNudgeAt,
            // exited_reason, last_shipped_check_*, last_substrate_hash,
            // and consecutive_stagnant_iterations all intentionally
            // omitted — a /fresh re-key is a clean slate. The implicit
            // non-assignment drops any prior values for every detector's
            // cache + counter state.
          };
          await writeState(directory, state);
        }
        return;
      }

      // (6) Completion-promise + verifier three-way branch.
      const promise = findCompletionPromise(messages);
      if (promise) {
        if (!sessState.verification_pending) {
          // First observation of DONE — ask the orchestrator to invoke the verifier.
          const planPathForPrompt =
            findPlanPath(messages) ?? sessState.lastPlanPath ?? ".agent/plans/<slug>.md";
          const sent = await sendNudgeDebounced(
            client,
            sessionID,
            sessState,
            AUTOPILOT_VERIFICATION_PROMPT(planPathForPrompt),
          );
          if (sent) {
            state.sessions[sessionID] = {
              iterations: sessState.iterations,
              lastPlanPath: sessState.lastPlanPath,
              lastHandoffMtime: sessState.lastHandoffMtime,
              verification_pending: true,
              consecutive_missing_verdicts: 0,
              enabled: true,
              lastNudgeAt: sessState.lastNudgeAt,
            };
            await writeState(directory, state);
          }
          return;
        }

        // verification_pending === true — look for the verdict in messages
        // after the DONE promise's message.
        const verdict = findVerifierVerdict(messages, promise.msgIdx);

        if (verdict === "VERIFIED") {
          const planPathForComplete =
            findPlanPath(messages) ?? sessState.lastPlanPath ?? ".agent/plans/<slug>.md";
          const sent = await sendNudgeDebounced(
            client,
            sessionID,
            sessState,
            AUTOPILOT_COMPLETE_MESSAGE(planPathForComplete),
          );
          if (sent) {
            // Preserve handoff tracking; drop verifier fields and reset iterations.
            // Keep `enabled: true` so a follow-up `/autopilot` or retry stays
            // opted in — explicit /autopilot invocations are sticky.
            state.sessions[sessionID] = {
              iterations: 0,
              lastHandoffMtime: sessState.lastHandoffMtime,
              enabled: true,
              lastNudgeAt: sessState.lastNudgeAt,
            };
            await writeState(directory, state);
          }
          return;
        }

        if (verdict === "UNVERIFIED") {
          const sent = await sendNudgeDebounced(
            client,
            sessionID,
            sessState,
            AUTOPILOT_VERIFICATION_FAILED_PROMPT,
          );
          if (sent) {
            state.sessions[sessionID] = {
              iterations: sessState.iterations + 1,
              lastPlanPath: sessState.lastPlanPath,
              lastHandoffMtime: sessState.lastHandoffMtime,
              verification_pending: false,
              consecutive_missing_verdicts: 0,
              enabled: true,
              lastNudgeAt: sessState.lastNudgeAt,
            };
            await writeState(directory, state);
          }
          return;
        }

        // verdict === null — missing-verdict safety path.
        const priorMissing = sessState.consecutive_missing_verdicts ?? 0;
        const nextMissing = priorMissing + 1;
        const bumpIterations = nextMissing >= MAX_MISSING_VERDICTS;

        const sent = await sendNudgeDebounced(
          client,
          sessionID,
          sessState,
          AUTOPILOT_VERIFICATION_MISSING_PROMPT,
        );
        if (sent) {
          state.sessions[sessionID] = {
            iterations: bumpIterations
              ? sessState.iterations + 1
              : sessState.iterations,
            lastPlanPath: sessState.lastPlanPath,
            lastHandoffMtime: sessState.lastHandoffMtime,
            verification_pending: true,
            consecutive_missing_verdicts: nextMissing,
            enabled: true,
            lastNudgeAt: sessState.lastNudgeAt,
          };
          await writeState(directory, state);
        }
        return;
      }

      // (7) Legacy heuristic branch: no completion-promise found. Fall
      // through to the classic "unchecked boxes + failure keyword" nudge.
      // This branch is ONLY reachable when `enabled === true`, so normal
      // orchestrator sessions with unchecked boxes never reach it.
      const planPath = findPlanPath(messages);
      if (!planPath) return;

      let planContent: string;
      try {
        planContent = await fs.readFile(path.join(directory, planPath), "utf8");
      } catch {
        return;
      }

      const unchecked = countUnchecked(planContent);
      const failed = lastAssistantFailed(messages);

      if (unchecked === 0 && !failed) {
        state.sessions[sessionID] = {
          iterations: 0,
          lastPlanPath: sessState.lastPlanPath,
          lastHandoffMtime: sessState.lastHandoffMtime,
          enabled: true,
          lastNudgeAt: sessState.lastNudgeAt,
        };
        await writeState(directory, state);
        return;
      }

      // (7a) Shipped-probe pre-check. Before firing a continue-execution
      // nudge on an un-finished-looking plan, verify the underlying work
      // hasn't already shipped. This is the central fix for the class
      // of bug where the loop kept pressuring the orchestrator to tick
      // boxes on a stale plan whose work had landed as a PR. Cached
      // per-session for SHIPPED_CHECK_CACHE_MS (60 s) so rapid idle
      // storms don't spawn `git` / `gh` on every event.
      const now = Date.now();
      const cacheFresh =
        sessState.last_shipped_check_at !== undefined &&
        now - sessState.last_shipped_check_at < SHIPPED_CHECK_CACHE_MS &&
        sessState.last_shipped_check_result !== undefined;
      const shippedResult: ShippedCheckResult = cacheFresh
        ? (sessState.last_shipped_check_result as ShippedCheckResult)
        : await checkShipped(directory);
      if (!cacheFresh) {
        sessState.last_shipped_check_at = now;
        sessState.last_shipped_check_result = shippedResult;
      }

      if (shippedResult === "shipped") {
        const sent = await sendNudgeDebounced(
          client,
          sessionID,
          sessState,
          AUTOPILOT_SHIPPED_EXIT_MESSAGE,
        );
        if (sent) {
          state.sessions[sessionID] = {
            iterations: sessState.iterations,
            lastPlanPath: planPath,
            lastHandoffMtime: sessState.lastHandoffMtime,
            enabled: true,
            lastNudgeAt: sessState.lastNudgeAt,
            exited_reason: "shipped",
            last_shipped_check_at: sessState.last_shipped_check_at,
            last_shipped_check_result: sessState.last_shipped_check_result,
            last_substrate_hash: sessState.last_substrate_hash,
            consecutive_stagnant_iterations:
              sessState.consecutive_stagnant_iterations,
          };
          await writeState(directory, state);
        }
        return;
      }

      // (7b) Stagnation detector. Snapshot the substrate (git HEAD +
      // working tree). If it hasn't changed across STAGNATION_THRESHOLD
      // consecutive nudges, the loop is firing but no progress is
      // landing on disk — exit cleanly. Catches the failure mode that
      // the shipped-probe misses: agent stuck in a tool-call cycle
      // producing no edits, or ticking plan checkboxes without writing
      // code.
      //
      // Snapshot failure (no git, not a repo, timeout) resets the
      // counter and persists `null` — we don't accumulate stagnation
      // evidence on observations we can't actually make.
      const substrateHash = await snapshotSubstrate(directory);
      const stagnation = evaluateStagnation(
        substrateHash,
        sessState.last_substrate_hash,
        sessState.consecutive_stagnant_iterations,
      );
      sessState.last_substrate_hash = stagnation.hash ?? undefined;
      sessState.consecutive_stagnant_iterations = stagnation.consecutive;

      if (stagnation.stagnant) {
        const sent = await sendNudgeDebounced(
          client,
          sessionID,
          sessState,
          AUTOPILOT_STAGNATION_EXIT_MESSAGE,
        );
        if (sent) {
          state.sessions[sessionID] = {
            iterations: sessState.iterations,
            lastPlanPath: planPath,
            lastHandoffMtime: sessState.lastHandoffMtime,
            enabled: true,
            lastNudgeAt: sessState.lastNudgeAt,
            exited_reason: "stagnation",
            last_shipped_check_at: sessState.last_shipped_check_at,
            last_shipped_check_result: sessState.last_shipped_check_result,
            last_substrate_hash: sessState.last_substrate_hash,
            consecutive_stagnant_iterations:
              sessState.consecutive_stagnant_iterations,
          };
          await writeState(directory, state);
        }
        return;
      }

      const reason =
        unchecked > 0
          ? `Plan has ${unchecked} unchecked acceptance criteria.`
          : "Last verification step failed.";

      const sent = await sendNudgeDebounced(
        client,
        sessionID,
        sessState,
        `[autopilot] ${reason} Continue execution. Re-read the plan at ${planPath} ` +
          `and resume from where you left off. When all acceptance criteria are met and ` +
          `\`@qa-reviewer\` returns \`[PASS]\`, emit \`<promise>DONE</promise>\` on its own line ` +
          `to trigger verification. If the plan itself is wrong, STOP and report. ` +
          `If the plan is stale or the work has already shipped, emit ` +
          `\`<autopilot>EXIT</autopilot>\` on its own line instead of continuing.`,
      );
      if (sent) {
        state.sessions[sessionID] = {
          iterations: sessState.iterations + 1,
          lastPlanPath: planPath,
          lastHandoffMtime: handoffMtime ?? sessState.lastHandoffMtime,
          verification_pending: sessState.verification_pending,
          consecutive_missing_verdicts: sessState.consecutive_missing_verdicts,
          enabled: true,
          lastNudgeAt: sessState.lastNudgeAt,
          last_shipped_check_at: sessState.last_shipped_check_at,
          last_shipped_check_result: sessState.last_shipped_check_result,
          last_substrate_hash: sessState.last_substrate_hash,
          consecutive_stagnant_iterations:
            sessState.consecutive_stagnant_iterations,
        };
        await writeState(directory, state);
      }
    },

    "chat.message": async ({ sessionID, agent }) => {
      if (!agent || !TARGET_AGENTS.has(agent)) return;
      const state = await readState(directory);
      const existing = state.sessions[sessionID];
      if (!existing) return;
      // If this session is not in autopilot mode, a user chat message is
      // none of our business. Don't write state, don't reset anything —
      // that's what was causing nudges to fire on plain orchestrator
      // sessions (the state write here would re-trigger `session.idle`
      // later which would re-read state and mis-interpret it).
      if (!existing.enabled) return;

      // User-stop-token detection. Fetch the most recent user message and
      // scan it for explicit stop signals (STOP / HALT as bare uppercase
      // tokens; "stop autopilot" / "kill autopilot" / "disable autopilot"
      // / "exit autopilot" as case-insensitive phrases). If detected,
      // terminally exit autopilot for this session (`exited_reason: "user_stop"`)
      // and send a one-shot acknowledgement. This is safety-critical:
      // the loop MUST NOT override an explicit user instruction to halt.
      //
      // The `chat.message` event payload gives us sessionID + agent but
      // NOT the message body, so we re-fetch the session's recent
      // messages. We deliberately check only the most recent user
      // message to avoid re-triggering on a stale STOP that was said
      // earlier and subsequently superseded (the user can re-acknowledge
      // by sending a new message without the token).
      try {
        const msgsResp = await client.session.messages({
          path: { id: sessionID },
          query: { limit: 5 },
        });
        const recent = (msgsResp.data ?? []) as RawMessage[];
        // Walk backward; first user message we hit is the latest one.
        let latestUserText = "";
        for (let i = recent.length - 1; i >= 0; i--) {
          if (recent[i].info?.role === "user") {
            latestUserText = userText(recent[i]);
            break;
          }
        }
        if (detectUserStopToken(latestUserText)) {
          // Synthesize a sessState for sendNudgeDebounced (it only reads
          // and updates `lastNudgeAt`).
          const sessState: SessionAutopilot = {
            ...existing,
          };
          await sendNudgeDebounced(
            client,
            sessionID,
            sessState,
            AUTOPILOT_USER_STOP_MESSAGE,
          );
          state.sessions[sessionID] = {
            iterations: existing.iterations,
            lastPlanPath: existing.lastPlanPath,
            lastHandoffMtime: existing.lastHandoffMtime,
            enabled: true,
            lastNudgeAt: sessState.lastNudgeAt,
            exited_reason: "user_stop",
          };
          await writeState(directory, state);
          return;
        }
      } catch {
        // If fetching messages fails, fall through to the legacy reset
        // path — we don't want a transient fetch error to miss a
        // legitimate user message reset.
      }

      // Preserve lastHandoffMtime, lastPlanPath, and the `enabled` flag
      // across user-message resets. Clear iterations + all verifier
      // fields — a user message always wins over in-flight verification
      // state. Once autopilot is on, the only way off is max-iterations,
      // an explicit stop token, the orchestrator's EXIT sentinel, or a
      // new `/autopilot` invocation on a fresh session.
      state.sessions[sessionID] = {
        iterations: 0,
        lastPlanPath: existing.lastPlanPath,
        lastHandoffMtime: existing.lastHandoffMtime,
        enabled: true,
        lastNudgeAt: existing.lastNudgeAt,
      };
      await writeState(directory, state);
    },
  };
};

export default plugin;

// Exports for tests. Plugin consumers get the default export above; the
// named exports are for unit tests in `test/autopilot-plugin.test.js` that
// exercise internal helpers directly without spinning up a full OpenCode
// runtime.
export {
  NUDGE_DEBOUNCE_MS,
  MAX_ITERATIONS,
  TARGET_AGENTS,
  COMPLETION_PROMISE_TOKEN,
  AUTOPILOT_VERIFICATION_PROMPT,
  AUTOPILOT_VERIFICATION_FAILED_PROMPT,
  AUTOPILOT_VERIFICATION_MISSING_PROMPT,
  AUTOPILOT_COMPLETE_MESSAGE,
  AUTOPILOT_MAX_ITERATIONS_MESSAGE,
  AUTOPILOT_SHIPPED_EXIT_MESSAGE,
  AUTOPILOT_USER_STOP_MESSAGE,
  AUTOPILOT_ORCHESTRATOR_EXIT_MESSAGE,
  AUTOPILOT_STAGNATION_EXIT_MESSAGE,
  AUTOPILOT_EXIT_PROMPT,
  AUTOPILOT_EXIT_RE,
  USER_STOP_BARE_RE,
  USER_STOP_PHRASE_RE,
  SHIPPED_CHECK_TIMEOUT_MS,
  SHIPPED_CHECK_CACHE_MS,
  STAGNATION_THRESHOLD,
  SUBSTRATE_CHECK_TIMEOUT_MS,
  detectActivation,
  findPlanPath,
  findCompletionPromise,
  findVerifierVerdict,
  findOrchestratorExit,
  detectUserStopToken,
  checkShipped,
  snapshotSubstrate,
  evaluateStagnation,
  countUnchecked,
  sendNudgeDebounced,
};
export type {
  SessionAutopilot,
  AutopilotState,
  RawMessage,
  ExitReason,
  ShippedCheckResult,
  StagnationOutcome,
  ExecFileImpl,
};
