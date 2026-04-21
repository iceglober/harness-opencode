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

const COMPLETION_PROMISE_TOKEN = "<promise>DONE</promise>";
const VERDICT_RE = /^\[AUTOPILOT_(VERIFIED|UNVERIFIED)\]\s*$/m;

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
      }

      // (3) Max-iterations cap. Preserve lastHandoffMtime so the next
      // idle-scan doesn't misread the handoff brief as a new /fresh.
      if (sessState.iterations >= MAX_ITERATIONS) {
        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: AUTOPILOT_MAX_ITERATIONS_MESSAGE,
              },
            ],
          },
        });
        state.sessions[sessionID] = {
          iterations: 0,
          lastHandoffMtime: sessState.lastHandoffMtime,
        };
        await writeState(directory, state);
        return;
      }

      // (4) Fresh-transition branch: if .agent/fresh-handoff.md is newer
      // than what we've seen AND iterations is 0 (indicating /fresh just
      // reset state), inject the handoff-brief nudge and wipe all verifier
      // fields — a fresh re-key is a clean slate.
      const handoffMtime = await getHandoffMtime(directory);
      const lastSeenHandoff = sessState.lastHandoffMtime ?? 0;
      const isFreshTransition =
        handoffMtime !== null &&
        handoffMtime > lastSeenHandoff &&
        sessState.iterations === 0;

      if (isFreshTransition) {
        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text:
                  `[autopilot] /fresh re-keyed this worktree to a new task. ` +
                  `Read \`${HANDOFF_PATH}\` for the full context (tracker ref, ` +
                  `branch name, base branch, reset-hook output), then run the ` +
                  `orchestrator five-phase workflow on the described work. ` +
                  `Do NOT revisit prior plans in this session — they belong to ` +
                  `the previous task.`,
              },
            ],
          },
        });
        state.sessions[sessionID] = {
          iterations: 1,
          lastHandoffMtime: handoffMtime,
        };
        await writeState(directory, state);
        return;
      }

      // (5) Completion-promise + verifier three-way branch.
      const promise = findCompletionPromise(messages);
      if (promise) {
        if (!sessState.verification_pending) {
          // First observation of DONE — ask the orchestrator to invoke the verifier.
          const planPathForPrompt = findPlanPath(messages) ?? sessState.lastPlanPath ?? ".agent/plans/<slug>.md";
          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              parts: [
                {
                  type: "text",
                  text: AUTOPILOT_VERIFICATION_PROMPT(planPathForPrompt),
                },
              ],
            },
          });
          state.sessions[sessionID] = {
            iterations: sessState.iterations,
            lastPlanPath: sessState.lastPlanPath,
            lastHandoffMtime: sessState.lastHandoffMtime,
            verification_pending: true,
            consecutive_missing_verdicts: 0,
          };
          await writeState(directory, state);
          return;
        }

        // verification_pending === true — look for the verdict in messages
        // after the DONE promise's message.
        const verdict = findVerifierVerdict(messages, promise.msgIdx);

        if (verdict === "VERIFIED") {
          const planPathForComplete = findPlanPath(messages) ?? sessState.lastPlanPath ?? ".agent/plans/<slug>.md";
          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              parts: [
                {
                  type: "text",
                  text: AUTOPILOT_COMPLETE_MESSAGE(planPathForComplete),
                },
              ],
            },
          });
          // Preserve handoff tracking; drop verifier fields and reset iterations.
          state.sessions[sessionID] = {
            iterations: 0,
            lastHandoffMtime: sessState.lastHandoffMtime,
          };
          await writeState(directory, state);
          return;
        }

        if (verdict === "UNVERIFIED") {
          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              parts: [
                {
                  type: "text",
                  text: AUTOPILOT_VERIFICATION_FAILED_PROMPT,
                },
              ],
            },
          });
          state.sessions[sessionID] = {
            iterations: sessState.iterations + 1,
            lastPlanPath: sessState.lastPlanPath,
            lastHandoffMtime: sessState.lastHandoffMtime,
            verification_pending: false,
            consecutive_missing_verdicts: 0,
          };
          await writeState(directory, state);
          return;
        }

        // verdict === null — missing-verdict safety path.
        const priorMissing = sessState.consecutive_missing_verdicts ?? 0;
        const nextMissing = priorMissing + 1;
        const bumpIterations = nextMissing >= MAX_MISSING_VERDICTS;

        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: AUTOPILOT_VERIFICATION_MISSING_PROMPT,
              },
            ],
          },
        });
        state.sessions[sessionID] = {
          iterations: bumpIterations ? sessState.iterations + 1 : sessState.iterations,
          lastPlanPath: sessState.lastPlanPath,
          lastHandoffMtime: sessState.lastHandoffMtime,
          verification_pending: true,
          consecutive_missing_verdicts: nextMissing,
        };
        await writeState(directory, state);
        return;
      }

      // (6) Legacy heuristic branch: no completion-promise found. Fall
      // through to the classic "unchecked boxes + failure keyword" nudge.
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
        };
        await writeState(directory, state);
        return;
      }

      const reason =
        unchecked > 0
          ? `Plan has ${unchecked} unchecked acceptance criteria.`
          : "Last verification step failed.";

      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [
            {
              type: "text",
              text:
                `[autopilot] ${reason} Continue execution. Re-read the plan at ${planPath} ` +
                `and resume from where you left off. When all acceptance criteria are met and ` +
                `\`@qa-reviewer\` returns \`[PASS]\`, emit \`<promise>DONE</promise>\` on its own line ` +
                `to trigger verification. If the plan itself is wrong, STOP and report.`,
            },
          ],
        },
      });

      state.sessions[sessionID] = {
        iterations: sessState.iterations + 1,
        lastPlanPath: planPath,
        lastHandoffMtime: handoffMtime ?? sessState.lastHandoffMtime,
        verification_pending: sessState.verification_pending,
        consecutive_missing_verdicts: sessState.consecutive_missing_verdicts,
      };
      await writeState(directory, state);
    },

    "chat.message": async ({ sessionID, agent }) => {
      if (!agent || !TARGET_AGENTS.has(agent)) return;
      const state = await readState(directory);
      const existing = state.sessions[sessionID];
      if (existing) {
        // Preserve lastHandoffMtime and lastPlanPath across user-message
        // resets. Clear iterations + all verifier fields — a user message
        // always wins over in-flight verification state.
        state.sessions[sessionID] = {
          iterations: 0,
          lastPlanPath: existing.lastPlanPath,
          lastHandoffMtime: existing.lastHandoffMtime,
        };
        await writeState(directory, state);
      }
    },
  };
};

export default plugin;
