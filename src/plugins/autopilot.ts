import type { Plugin } from "@opencode-ai/plugin";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

/**
 * Canonical Ralph loop, hardened. When the user invokes `/autopilot`, the
 * PRIME runs its normal five-phase workflow on a plan. This plugin
 * nudges the session to keep going whenever opencode goes idle before the
 * plan's `## Acceptance criteria` boxes are all checked.
 *
 * Activation: the session's **first user message** must contain `/autopilot`
 * (as a slash-command token) or the literal `AUTOPILOT mode` phrase that
 * the `/autopilot` command injects into the prompt. The activation is
 * sticky for the lifetime of the session; to re-activate in a fresh
 * session, the user invokes `/autopilot` again.
 *
 * Circuit breakers (mechanical, non-interactive):
 *
 *   1. **Plan shape.** Only *unit plans* get nudged. Umbrella plans
 *      (tracking multiple Linear issues or large roadmaps),
 *      measurement-gated plans (7-day windows, post-deploy SLOs), and
 *      opt-out plans (magic `<!-- autopilot: skip -->` comment) are
 *      detected via `classifyPlan` and stop the session silently.
 *   2. **Branch mismatch.** If the plan's `## Goal` references a Linear
 *      ID that doesn't appear in the current branch name, the work
 *      belongs elsewhere. Session stops silently.
 *   3. **PR merged.** If the current branch has a merged PR (via
 *      `gh pr view`), the work is already shipped. Session stops
 *      silently. Graceful degrade when `gh` is unavailable.
 *   4. **Kill switch.** A file at `.agent/autopilot-disable` stops ALL
 *      sessions in this worktree. Deterministic, external, works from
 *      any terminal.
 *   5. **STOP backoff.** After two consecutive assistant messages matching
 *      a STOP pattern (`^STOP[:.\\s—]`) on the same plan, the plugin
 *      stops. The agent's STOP is authoritative; we don't nudge past it.
 *   6. **Max iterations cap.** Hard ceiling at `MAX_ITERATIONS`. Fires one
 *      "stopped, something's stuck" nudge (or silently stops if debounced)
 *      and the session is terminally stopped either way.
 *
 * State: `.agent/autopilot-state.json` stores per-session
 * `{ enabled, iterations, lastNudgeAt, stopped, stopReason,
 *    consecutiveStops, prState, prCheckedAt, lastUncheckedCount }`.
 *
 * Important design rule: the plugin never asks the user anything.
 * Circuit breakers are mechanical — a session that can't make progress
 * stops silently. PRIME's Phase 5 handoff (or its STOP report)
 * is the final output the user sees; the plugin respects that.
 */

const STATE_PATH = ".agent/autopilot-state.json";
const KILL_SWITCH_PATH = ".agent/autopilot-disable";
const MAX_ITERATIONS = 20;
const TARGET_AGENTS = new Set(["build", "prime"]);
const MESSAGE_LIMIT = 40;
const NUDGE_DEBOUNCE_MS = 30_000;
const PR_CACHE_MS = 5 * 60 * 1_000; // 5 minutes
const MAX_CONSECUTIVE_STOPS = 2;

/**
 * Umbrella-plan detection thresholds. `UMBRELLA_MIN_BYTES` maps to the
 * ~500-line rule from the proposal (500 lines * ~100 chars/line = 50KB).
 * `UMBRELLA_MIN_LINEAR_IDS` is the "many distinct tickets" heuristic.
 */
const UMBRELLA_MIN_BYTES = 50_000;
const UMBRELLA_MIN_LINEAR_IDS = 3;

/**
 * Activation marker. Matches either `/autopilot` as a whole token (the
 * slash-command form) or the literal phrase `AUTOPILOT mode` (the
 * prompt-injected form). We scan only the first user message of the
 * session, so a later message mentioning `/autopilot` descriptively — or
 * a pasted session transcript — does not retroactively activate the
 * session.
 */
const AUTOPILOT_MARKER_RE = /(^|\s)\/autopilot(\s|$)|AUTOPILOT mode/;

/**
 * Magic-comment opt-out. Plan authors drop this anywhere in the plan file
 * to tell autopilot "do not nudge this plan." Chosen as a comment rather
 * than YAML frontmatter so plans without existing frontmatter don't need
 * a schema migration.
 */
const OPT_OUT_RE = /<!--\s*autopilot:\s*(skip|false)\s*-->/i;

/**
 * Umbrella-plan structural signals. Presence of any `## Chunks`,
 * `## Milestones`, or `## Workstreams` header strongly suggests the plan
 * is tracking multiple units of work rather than a single ticket's ACs.
 */
const UMBRELLA_SECTION_RE = /^##\s+(Chunks|Milestones|Workstreams)\b/m;

/**
 * Linear-style ticket IDs (`PROJ-123`). Used two ways: count distinct IDs
 * in the plan to detect umbrella shape, and extract the ID from the
 * `## Goal` section to check branch/plan alignment.
 */
const LINEAR_ID_RE = /\b[A-Z]{2,10}-\d+\b/g;

/**
 * Measurement-gate phrases in `## Acceptance criteria`. An AC that says
 * "success rate reaches 70% over a 7-day production window" cannot be
 * ticked by the agent mid-session; nudging it is counterproductive.
 *
 * Scoped to the AC section only — "SLO" in the Constraints section is
 * fine, for example.
 */
const MEASUREMENT_GATE_RE =
  /\b(7-day|production window|post-deploy|post-launch|SLO|success rate reaches|after deploy|bake time)\b/i;

/**
 * STOP-report pattern from an assistant message. Anchored to line-start
 * to avoid matching "I won't stop until done" prose. When this matches we
 * consider the assistant to have escalated; two in a row → session stops.
 */
const STOP_REPORT_RE = /^STOP[:.\s—]/m;

const NUDGE_TEXT =
  "[autopilot] Session idled with unchecked acceptance criteria. " +
  "Re-read the plan, do the most important unchecked item, check its box when " +
  "done, then move to the next. When all boxes are `[x]`, print the Phase 5 " +
  "handoff and stop — the user runs `/ship` manually.";

const MAX_ITERATIONS_TEXT =
  `[autopilot] Stopped: hit max iterations (${MAX_ITERATIONS}). ` +
  "Either the work is complete or the loop is stuck. Review and resume " +
  "manually; a new `/autopilot` session will re-enable nudges.";

type StopReason =
  | "max-iterations"
  | "plan-shape:umbrella"
  | "plan-shape:measurement-gated"
  | "plan-shape:opted-out"
  | "branch-mismatch"
  | "pr-merged"
  | "kill-switch"
  | "agent-stop-report";

interface SessionState {
  enabled?: boolean;
  iterations: number;
  lastNudgeAt?: number;
  /** Once set, no further nudges fire for this session. Cleared only by
   * a brand-new session (i.e. never, within this session). */
  stopped?: boolean;
  /** Why the session stopped — surfaced for debugging and future UI. */
  stopReason?: StopReason | string;
  /** Count of consecutive assistant STOP reports on the same plan. Resets
   * when the unchecked-count decreases (agent made progress). */
  consecutiveStops?: number;
  /** Cached PR state ("MERGED", "OPEN", "none", or "unknown") for the
   * current branch. Refreshed no more than once per `PR_CACHE_MS`. */
  prState?: string;
  /** Epoch ms when `prState` was last populated. */
  prCheckedAt?: number;
  /** Last observed unchecked-box count; used to detect progress between
   * idles, which resets `consecutiveStops`. */
  lastUncheckedCount?: number;
}

interface PluginState {
  sessions: Record<string, SessionState>;
}

type RawMessage = { info: any; parts: Array<any> };

type PlanShape = "unit" | "umbrella" | "measurement-gated" | "opted-out";

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
 * Return the text of the most-recent assistant message, or `""` if none.
 * Used by STOP-report detection.
 */
function latestAssistantText(messages: RawMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "assistant") continue;
    const parts = msg.parts ?? [];
    return parts
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text as string)
      .join("\n");
  }
  return "";
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
  // Only `- [ ]` counts. `- [x]` is done, `- [~]` is pending/measurement,
  // `- [-]` is blocked/conditional — none of those are actionable by the
  // agent in-session so they must not trigger nudges.
  const matches = section[1].match(/^- \[ \]/gm);
  return matches?.length ?? 0;
}

/**
 * Classify a plan's shape from its content. This decides whether autopilot
 * should nudge (unit) or stop silently (umbrella, measurement-gated,
 * opted-out).
 *
 * Priority:
 *   1. Explicit opt-out (`<!-- autopilot: skip -->`) — authoritative.
 *   2. Umbrella signals (structural section headers, size, many Linear IDs).
 *   3. Measurement-gated phrases scoped to the `## Acceptance criteria`
 *      section only.
 *   4. Otherwise: unit.
 *
 * We check umbrella before measurement-gated because an umbrella that
 * happens to mention "post-deploy" is still primarily an umbrella problem
 * (multi-chunk, multi-branch) — the right fix is a unit plan, not stricter
 * marker hygiene.
 */
function classifyPlan(content: string): PlanShape {
  if (OPT_OUT_RE.test(content)) return "opted-out";

  if (UMBRELLA_SECTION_RE.test(content)) return "umbrella";
  if (content.length > UMBRELLA_MIN_BYTES) return "umbrella";
  const linearIds = content.match(LINEAR_ID_RE) ?? [];
  const unique = new Set(linearIds);
  if (unique.size >= UMBRELLA_MIN_LINEAR_IDS) return "umbrella";

  const acSection = /## Acceptance criteria([\s\S]*?)(?=\n##|$)/.exec(content);
  if (acSection && MEASUREMENT_GATE_RE.test(acSection[1])) {
    return "measurement-gated";
  }

  return "unit";
}

/**
 * Extract the first Linear-style ticket ID from the plan's `## Goal`
 * section. Returns `null` if no `## Goal` or no ID within it. Used by
 * branch/plan alignment — if the goal cites a ticket, the branch should
 * too.
 */
function planGoalLinearId(content: string): string | null {
  const goal = /## Goal([\s\S]*?)(?=\n##|$)/.exec(content);
  if (!goal) return null;
  const m = goal[1].match(LINEAR_ID_RE);
  return m ? m[0] : null;
}

/**
 * Return true when the assistant's most recent message reads as a STOP
 * report — the agent telling us it can't proceed.
 *
 * Anchored to start-of-line + delimiter to avoid pattern-matching
 * innocuous uses of the word STOP ("I won't stop until the tests pass").
 */
function detectStopReport(assistantText: string): boolean {
  if (!assistantText) return false;
  return STOP_REPORT_RE.test(assistantText);
}

// ---- external checks ----

const execFile = promisify(execFileCb);

/**
 * Return the current branch name by shelling out to `git`. Graceful
 * degrade: on any failure (not a git dir, git missing, detached HEAD),
 * returns `null`. Never throws.
 */
async function currentBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "git",
      ["-C", dir, "branch", "--show-current"],
      { timeout: 2_000 },
    );
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Return the PR state for the current branch ("MERGED", "OPEN", "CLOSED",
 * etc.) via `gh pr view`. Returns `null` if `gh` isn't installed, there's
 * no PR, or any other failure. Never throws.
 */
async function pullRequestState(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "gh",
      ["pr", "view", "--json", "state", "--jq", ".state"],
      { cwd: dir, timeout: 5_000 },
    );
    const state = stdout.trim();
    return state.length > 0 ? state : null;
  } catch {
    return null;
  }
}

/**
 * Return true iff `.agent/autopilot-disable` exists in the worktree. Any
 * read error (not existing, permission issues, etc.) is treated as
 * "kill switch not engaged."
 */
async function killSwitchEngaged(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, KILL_SWITCH_PATH));
    return true;
  } catch {
    return false;
  }
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

      // Only act on build/prime sessions.
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

      // Kill-switch: cheapest external signal, check first. A file on
      // disk is the user's (or the agent's) unambiguous way to stop the
      // loop without relying on chat-message heuristics.
      if (await killSwitchEngaged(directory)) {
        state.sessions[sessionID] = {
          ...sessState,
          stopped: true,
          stopReason: "kill-switch",
        };
        await writeState(directory, state);
        return;
      }

      // Max-iterations cap. Set `stopped` unconditionally — if sendNudge
      // gets debounced the cap must still terminate the session, not
      // leave it re-testable on the next idle cycle.
      if (sessState.iterations >= MAX_ITERATIONS) {
        await sendNudge(client, sessionID, sessState, MAX_ITERATIONS_TEXT);
        state.sessions[sessionID] = {
          ...sessState,
          stopped: true,
          stopReason: "max-iterations",
        };
        await writeState(directory, state);
        return;
      }

      // Find the plan. If none referenced yet, nothing to nudge about —
      // PRIME hasn't decided on a plan path yet; wait quietly.
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

      // Plan-shape classifier. Non-unit plans (umbrella, measurement,
      // opt-out) stop the session silently — nudging against an
      // un-tickable AC is what wedged us in the transcript that motivated
      // this whole set of circuit breakers.
      const shape = classifyPlan(planContent);
      if (shape !== "unit") {
        state.sessions[sessionID] = {
          ...sessState,
          stopped: true,
          stopReason: `plan-shape:${shape}`,
        };
        await writeState(directory, state);
        return;
      }

      // Branch/plan alignment. If the plan's Goal cites a Linear ID and
      // the current branch doesn't contain it, we're on the wrong
      // branch — stop rather than churn.
      const planLinearId = planGoalLinearId(planContent);
      if (planLinearId) {
        const branch = await currentBranch(directory);
        if (branch && !branch.toLowerCase().includes(planLinearId.toLowerCase())) {
          state.sessions[sessionID] = {
            ...sessState,
            stopped: true,
            stopReason: "branch-mismatch",
          };
          await writeState(directory, state);
          return;
        }
      }

      // PR-state short-circuit. If the current branch has a merged PR,
      // the work is shipped regardless of local checkbox state. Cache
      // the answer for PR_CACHE_MS to avoid shelling out on every idle.
      const now = Date.now();
      let prState = sessState.prState;
      const prExpired =
        sessState.prCheckedAt === undefined ||
        now - sessState.prCheckedAt > PR_CACHE_MS;
      if (prExpired) {
        const fetched = await pullRequestState(directory);
        prState = fetched ?? "none";
        sessState.prState = prState;
        sessState.prCheckedAt = now;
      }
      if (prState === "MERGED") {
        state.sessions[sessionID] = {
          ...sessState,
          stopped: true,
          stopReason: "pr-merged",
        };
        await writeState(directory, state);
        return;
      }

      const unchecked = countUnchecked(planContent);
      if (unchecked === 0) {
        // Work is done. Persist enabled state but don't nudge. Reset
        // STOP counter / last count so a future un-tick wouldn't see
        // stale counters.
        state.sessions[sessionID] = {
          ...sessState,
          consecutiveStops: 0,
          lastUncheckedCount: 0,
        };
        await writeState(directory, state);
        return;
      }

      // STOP-report backoff. When the agent's most recent message reads
      // as a STOP report, count it; after MAX_CONSECUTIVE_STOPS in a row
      // the plugin stops. If the unchecked count dropped since last idle
      // (agent made real progress), the counter resets.
      const lastUnchecked = sessState.lastUncheckedCount;
      const madeProgress =
        lastUnchecked !== undefined && unchecked < lastUnchecked;
      const stopReported = detectStopReport(latestAssistantText(messages));

      let consecutiveStops = sessState.consecutiveStops ?? 0;
      if (madeProgress) {
        consecutiveStops = 0;
      } else if (stopReported) {
        consecutiveStops += 1;
      } else {
        // Assistant message wasn't a STOP — treat this idle as neutral
        // (neither progress nor a STOP). Don't reset the counter,
        // because two STOPs separated by a non-STOP idle still means
        // the agent keeps declining to proceed.
      }
      sessState.consecutiveStops = consecutiveStops;
      sessState.lastUncheckedCount = unchecked;

      if (consecutiveStops >= MAX_CONSECUTIVE_STOPS) {
        state.sessions[sessionID] = {
          ...sessState,
          stopped: true,
          stopReason: "agent-stop-report",
        };
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
      } else {
        // Debounced — persist the updated counters (consecutiveStops,
        // lastUncheckedCount, prState cache) so subsequent idles see
        // the latest view.
        state.sessions[sessionID] = { ...sessState };
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
  MAX_CONSECUTIVE_STOPS,
  NUDGE_DEBOUNCE_MS,
  PR_CACHE_MS,
  KILL_SWITCH_PATH,
  TARGET_AGENTS,
  AUTOPILOT_MARKER_RE,
  NUDGE_TEXT,
  MAX_ITERATIONS_TEXT,
  detectActivation,
  findPlanPath,
  countUnchecked,
  classifyPlan,
  planGoalLinearId,
  detectStopReport,
  sendNudge,
};
export type { SessionState, PluginState, RawMessage, PlanShape, StopReason };
