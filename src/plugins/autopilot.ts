import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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

const COMPLETION_PROMISE_TOKEN = "<promise>DONE</promise>";
const VERDICT_RE = /^\[AUTOPILOT_(VERIFIED|UNVERIFIED)\]\s*$/m;

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
 * Decide whether this session should have autopilot nudge-processing enabled.
 * Two activation signals, checked against the scanned messages + filesystem:
 *
 *   1. Any user message contains `AUTOPILOT mode` or starts with `/autopilot`.
 *      This catches both the slash-command invocation and the in-prompt marker
 *      that `home/.claude/commands/autopilot.md` emits into the orchestrator's
 *      incoming message body.
 *   2. A fresh-handoff transition just happened (handoff mtime advanced AND
 *      iterations is 0). `/plan-loop` is the only caller that writes the
 *      handoff brief, and it exists to hand off to autopilot — so any fresh
 *      transition implies autopilot.
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
  // Signal 1: message-body markers from the slash command or orchestrator
  // prompt. Check every user message (not just the most recent) so that a
  // `/autopilot` invocation earlier in the session keeps the mode active
  // even after subsequent non-marker user messages.
  for (const msg of messages) {
    if (msg.info?.role !== "user") continue;
    if (AUTOPILOT_MARKER_RE.test(userText(msg))) return true;
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

      // (4) Max-iterations cap. Preserve lastHandoffMtime so the next
      // idle-scan doesn't misread the handoff brief as a new /fresh.
      // Clear `enabled` so a subsequent session won't keep hitting this
      // cap message — the max-iter case is the one place we intentionally
      // exit autopilot.
      if (sessState.iterations >= MAX_ITERATIONS) {
        const sent = await sendNudgeDebounced(
          client,
          sessionID,
          sessState,
          AUTOPILOT_MAX_ITERATIONS_MESSAGE,
        );
        if (sent) {
          state.sessions[sessionID] = {
            iterations: 0,
            lastHandoffMtime: sessState.lastHandoffMtime,
            lastNudgeAt: sessState.lastNudgeAt,
          };
          await writeState(directory, state);
        }
        return;
      }

      // (5) Fresh-transition branch: if .agent/fresh-handoff.md is newer
      // than what we've seen AND iterations is 0 (indicating /fresh just
      // reset state), inject the handoff-brief nudge and wipe all verifier
      // fields — a fresh re-key is a clean slate.
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
          `to trigger verification. If the plan itself is wrong, STOP and report.`,
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
      // Preserve lastHandoffMtime, lastPlanPath, and the `enabled` flag
      // across user-message resets. Clear iterations + all verifier
      // fields — a user message always wins over in-flight verification
      // state. Once autopilot is on, the only way off is max-iterations
      // or an explicit new `/autopilot` invocation on a fresh session.
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
  detectActivation,
  findPlanPath,
  findCompletionPromise,
  findVerifierVerdict,
  countUnchecked,
  sendNudgeDebounced,
};
export type { SessionAutopilot, AutopilotState, RawMessage };
