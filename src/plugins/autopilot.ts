import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Canonical Ralph loop, minimal. When the user invokes `/autopilot`, the
 * orchestrator runs its normal five-phase workflow on a plan. This plugin
 * nudges the session to keep going whenever opencode goes idle before the
 * plan's `## Acceptance criteria` boxes are all checked.
 *
 * No sentinels. No verifier. No shipped-probe. No stagnation detector. No
 * exit tokens. The plugin looks at the plan file on disk and at the first
 * user message; everything else is just the agent doing its job.
 *
 * Activation: the session's **first user message** must contain `/autopilot`
 * (as a slash-command token) or the literal `AUTOPILOT mode` phrase that
 * the `/autopilot` command injects into the prompt. The activation is
 * sticky for the lifetime of the session; to re-activate in a fresh
 * session, the user invokes `/autopilot` again.
 *
 * Stop conditions:
 *   1. The plan file has zero unchecked `- [ ]` boxes under `## Acceptance
 *      criteria` → plugin silently stops nudging. Orchestrator's Phase 5
 *      handoff message is the terminal state; user runs `/ship` manually.
 *   2. The iteration counter reaches `MAX_ITERATIONS` → plugin emits one
 *      "stopped, something's stuck" nudge and then stops for this session.
 *   3. The user types anything → iterations reset to 0, loop continues.
 *
 * State: `.agent/autopilot-state.json` stores per-session `{ enabled,
 * iterations, lastNudgeAt }`. That's it.
 */

const STATE_PATH = ".agent/autopilot-state.json";
const MAX_ITERATIONS = 20;
const TARGET_AGENTS = new Set(["build", "orchestrator"]);
const MESSAGE_LIMIT = 40;
const NUDGE_DEBOUNCE_MS = 30_000;

/**
 * Activation marker. Matches either `/autopilot` as a whole token (the
 * slash-command form) or the literal phrase `AUTOPILOT mode` (the
 * prompt-injected form). We scan only the first user message of the
 * session, so a later message mentioning `/autopilot` descriptively — or
 * a pasted session transcript — does not retroactively activate the
 * session.
 */
const AUTOPILOT_MARKER_RE = /(^|\s)\/autopilot(\s|$)|AUTOPILOT mode/;

// PLAN_PATH_RE is defined further down, next to findPlanPath where the
// matching rules live.

const NUDGE_TEXT =
  "[autopilot] Session idled with unchecked acceptance criteria. " +
  "Re-read the plan, do the most important unchecked item, check its box when " +
  "done, then move to the next. When all boxes are `[x]`, print the Phase 5 " +
  "handoff and stop — the user runs `/ship` manually.";

const MAX_ITERATIONS_TEXT =
  `[autopilot] Stopped: hit max iterations (${MAX_ITERATIONS}). ` +
  "Either the work is complete or the loop is stuck. Review and resume " +
  "manually; a new `/autopilot` session will re-enable nudges.";

interface SessionState {
  enabled?: boolean;
  iterations: number;
  lastNudgeAt?: number;
  /** Once set, no further nudges fire for this session. Cleared only by
   * a brand-new session (i.e. never, within this session). */
  stopped?: boolean;
}

interface PluginState {
  sessions: Record<string, SessionState>;
}

type RawMessage = { info: any; parts: Array<any> };

// ---- state I/O ----

async function readState(dir: string): Promise<PluginState> {
  try {
    const raw = await fs.readFile(path.join(dir, STATE_PATH), "utf8");
    const parsed = JSON.parse(raw) as PluginState;
    return { sessions: parsed.sessions ?? {} };
  } catch {
    return { sessions: {} };
  }
}

async function writeState(dir: string, state: PluginState): Promise<void> {
  const p = path.join(dir, STATE_PATH);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ---- message helpers ----

function userText(msg: RawMessage): string {
  if (msg.info?.role !== "user") return "";
  const parts = msg.parts ?? [];
  return parts
    .filter((p: any) => p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text as string)
    .join("\n");
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
 * Activation is opt-in: only the session's FIRST user message can activate
 * autopilot. Later messages that mention `/autopilot` or `AUTOPILOT mode`
 * are treated as ordinary prose and do NOT flip the bit — this closes the
 * self-activation loophole where pasted transcripts or quoted plan text
 * could flip a vanilla session into autopilot mode.
 */
function detectActivation(messages: RawMessage[]): boolean {
  for (const msg of messages) {
    if (msg.info?.role !== "user") continue;
    return AUTOPILOT_MARKER_RE.test(userText(msg));
  }
  return false;
}

// Plan paths come in two shapes:
//
//   1. Legacy (per-worktree):
//        .agent/plans/<slug>.md
//
//   2. Repo-shared (current, since the plan-storage migration):
//        <absolute-prefix>/<repo-folder>/plans/<slug>.md
//        e.g. /Users/alice/.glorious/opencode/my-repo/plans/fix-bug.md
//
// The regex matches BOTH shapes so autopilot can still latch onto plan
// references in older sessions / legacy fixtures. Constraints:
//   - slug matches `[\w-]+` (letters, digits, underscore, dash)
//   - path ends in `.md`
//   - prefix is either `.agent/plans/` (legacy) or any non-whitespace run
//     ending in `/plans/` whose preceding segment is a repo-folder token
//     (`[\w.-]+`). This filters out noise like `foo/plans/bar.md` buried
//     in a sentence while still catching every legitimate absolute path.
//
// We scan messages newest-to-oldest and alternation is left-to-right, so
// the first match wins — legacy references surface first when present,
// which matches the pre-migration behavior.
const PLAN_PATH_RE =
  /(?:\.agent\/plans\/[\w-]+\.md|(?:\/[^\s`"']*)?\/[\w.-]+\/plans\/[\w-]+\.md)/;

function findPlanPath(messages: RawMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts ?? [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") {
        const m = part.text.match(PLAN_PATH_RE);
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

// ---- nudge dispatch ----

async function sendNudge(
  client: any,
  sessionID: string,
  sessState: SessionState,
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

// ---- plugin entry ----

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

      // Only act on build/orchestrator sessions.
      const agent = latestUserAgent(messages);
      if (!agent || !TARGET_AGENTS.has(agent)) return;

      const state = await readState(directory);
      const sessState: SessionState = state.sessions[sessionID] ?? {
        iterations: 0,
      };

      // Stopped sessions are terminally stopped.
      if (sessState.stopped) return;

      // Activation gate. Non-autopilot sessions exit here silently — no
      // state write, no nudge.
      if (!sessState.enabled) {
        if (!detectActivation(messages)) return;
        sessState.enabled = true;
      }

      // Max-iterations cap.
      if (sessState.iterations >= MAX_ITERATIONS) {
        const sent = await sendNudge(
          client,
          sessionID,
          sessState,
          MAX_ITERATIONS_TEXT,
        );
        state.sessions[sessionID] = { ...sessState, stopped: sent };
        await writeState(directory, state);
        return;
      }

      // Find the plan. If none referenced yet, nothing to nudge about —
      // the orchestrator hasn't decided on a plan path yet; wait quietly.
      const planPath = findPlanPath(messages);
      if (!planPath) return;

      // Plan paths may be legacy-relative (`.agent/plans/<slug>.md`) or
      // absolute (`~/.glorious/opencode/<repo>/plans/<slug>.md`) — after
      // the plan-storage migration both shapes can appear in chat. Use
      // `path.isAbsolute` to decide whether to anchor against the
      // worktree directory or pass through as-is. `path.join(cwd, abs)`
      // would be wrong because Node concatenates rather than preserving
      // the absolute-ness of the second argument.
      const resolvedPlanPath = path.isAbsolute(planPath)
        ? planPath
        : path.join(directory, planPath);

      let planContent: string;
      try {
        planContent = await fs.readFile(resolvedPlanPath, "utf8");
      } catch {
        // Plan path referenced but file missing — could be pre-Phase-2;
        // wait for the plan to appear.
        return;
      }

      const unchecked = countUnchecked(planContent);
      if (unchecked === 0) {
        // Work is done. Persist enabled state but don't nudge. If the
        // user keeps the session alive and later marks boxes unchecked
        // (unlikely), we'd resume — harmless.
        state.sessions[sessionID] = { ...sessState };
        await writeState(directory, state);
        return;
      }

      // Fire one nudge.
      const sent = await sendNudge(client, sessionID, sessState, NUDGE_TEXT);
      if (sent) {
        state.sessions[sessionID] = {
          ...sessState,
          iterations: sessState.iterations + 1,
        };
        await writeState(directory, state);
      }
    },

    "chat.message": async ({ sessionID, agent }) => {
      if (!agent || !TARGET_AGENTS.has(agent)) return;
      const state = await readState(directory);
      const existing = state.sessions[sessionID];
      // Non-autopilot sessions are none of our business.
      if (!existing?.enabled) return;
      // User message resets iterations (user is engaged / correcting),
      // but leaves `enabled` and `stopped` untouched. A stopped session
      // stays stopped until the user starts a new one.
      state.sessions[sessionID] = {
        ...existing,
        iterations: 0,
      };
      await writeState(directory, state);
    },
  };
};

export default plugin;

// Exports for unit tests. Named exports keep the test harness simple; the
// plugin consumer uses the default export.
export {
  MAX_ITERATIONS,
  NUDGE_DEBOUNCE_MS,
  TARGET_AGENTS,
  AUTOPILOT_MARKER_RE,
  NUDGE_TEXT,
  MAX_ITERATIONS_TEXT,
  detectActivation,
  findPlanPath,
  countUnchecked,
  sendNudge,
};
export type { SessionState, PluginState, RawMessage };
