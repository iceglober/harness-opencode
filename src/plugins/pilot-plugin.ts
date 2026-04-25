/**
 * Pilot runtime guards — belt-and-suspenders enforcement of the pilot
 * subsystem's invariants at the opencode plugin layer.
 *
 * What this plugin guards:
 *
 *   1. **pilot-builder MUST NOT** commit, push, tag, branch, or open
 *      PRs. The agent's permission map (see `PILOT_BUILDER_PERMISSIONS`
 *      in `src/agents/index.ts`) is the FIRST wall; this plugin is the
 *      SECOND wall. If a future opencode SDK release silently changes
 *      permission resolution, the plugin hook keeps working.
 *
 *   2. **pilot-planner MUST NOT** edit files outside the pilot plans
 *      directory. The agent has `edit: allow` so it can write the
 *      YAML plan; this hook re-checks the target path on every
 *      edit/write/patch/multiedit and denies anything outside the
 *      plans dir.
 *
 * Why this is a separate sub-plugin (not inlined in the main plugin
 * entry):
 *   - Mirrors `src/plugins/autopilot.ts` and `src/plugins/notify.ts` —
 *     each guard surface is a small, testable Plugin export. The main
 *     `src/index.ts` composes them.
 *   - Keeps the failure modes legible: if a future change subtly
 *     breaks the planner edit-restriction, the diff is in one file.
 *
 * Detection strategy:
 *
 * The opencode `tool.execute.before` hook gives us
 * `{tool, sessionID, callID}` plus mutable `output.args`, but NOT the
 * active agent name. To identify a pilot session we cache, per
 * sessionID, the session title (which the pilot worker sets to
 * `pilot/<runId>/<taskID>`) on first observation. Once cached, we can
 * apply pilot-specific rules without re-fetching the session metadata.
 *
 * Cache invalidation: the cache is process-lifetime; pilot sessions
 * are short-lived (one task each) so no eviction is needed in v0.1.
 *
 * Throwing from the hook is the documented opencode plugin pattern for
 * "deny this tool execution" (see `autopilot.ts` `event` hook for an
 * analogous pattern; `tool.execute.before` allows `await`-throw to
 * abort the call). The thrown message is what the agent sees; we
 * format it to be self-explanatory.
 */

import type { Plugin } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import * as path from "node:path";

// --- Constants -------------------------------------------------------------

/** Title prefix the pilot worker uses for every session it creates. */
const PILOT_SESSION_TITLE_PREFIX = "pilot/";

/**
 * Bash command patterns the pilot-builder is forbidden from running.
 * Each entry is a prefix the command (after stripping leading
 * whitespace) must NOT start with. We check `command.startsWith(p) ||
 * command === p` so both `git commit` and `git commit -am ...` match.
 *
 * Order matters only for human readability; matching is OR'd.
 */
const FORBIDDEN_BUILDER_BASH_PREFIXES = [
  "git commit",
  "git push",
  "git tag",
  "git checkout ",
  "git switch ",
  "git branch",
  "git restore --source",
  "git reset",
  "gh pr ",
  "gh release ",
];

/** Tools that mutate files; restricted for pilot-planner. */
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

// --- Plugin ----------------------------------------------------------------

const plugin: Plugin = async ({ client }) => {
  // sessionID → cached session-classification result.
  const sessionCache = new Map<string, SessionInfo>();

  return {
    "tool.execute.before": async (input, output) => {
      const info = await classifySession(client, sessionCache, input.sessionID);

      if (info.kind === "pilot-builder") {
        if (input.tool === "bash") {
          enforceBuilderBashDeny(output.args);
        }
      } else if (info.kind === "pilot-planner") {
        if (EDIT_TOOLS.has(input.tool)) {
          await enforcePlannerEditScope(output.args, info.plansDir);
        }
      }
      // Non-pilot sessions: pass through unchanged.
    },
  };
};

export default plugin;

// --- Session classification ------------------------------------------------

type SessionInfo =
  | { kind: "non-pilot" }
  | {
      kind: "pilot-builder";
      runId: string;
      taskId: string;
    }
  | {
      kind: "pilot-planner";
      plansDir: string;
    };

/**
 * Classify a session as pilot-builder / pilot-planner / non-pilot. Result
 * is cached per session id.
 *
 * The classification rule:
 *   - Title starts with `pilot/<runId>/<taskID>` → pilot-builder.
 *     (The worker creates sessions with this title in `runOneTask`.)
 *   - Title starts with `pilot/` BUT lacks a third path segment, OR the
 *     session was started via `opencode --agent pilot-planner` → planner.
 *     (We don't have a perfect signal for the planner. The planner is
 *     interactive — sessions a user starts in the TUI may have any
 *     title. Detection here uses the working directory: if the
 *     session's directory equals the pilot plans dir, treat as
 *     planner.)
 *   - Otherwise → non-pilot.
 *
 * If `client.session.get` fails (network blip), classify conservatively
 * as non-pilot — better to under-enforce than to deny innocent ops.
 */
async function classifySession(
  client: OpencodeClient,
  cache: Map<string, SessionInfo>,
  sessionID: string,
): Promise<SessionInfo> {
  const cached = cache.get(sessionID);
  if (cached !== undefined) return cached;

  let title = "";
  let directory = "";
  try {
    const r = await client.session.get({ path: { id: sessionID } });
    const data = r.data as { title?: string; directory?: string } | undefined;
    title = data?.title ?? "";
    directory = data?.directory ?? "";
  } catch {
    const v: SessionInfo = { kind: "non-pilot" };
    cache.set(sessionID, v);
    return v;
  }

  if (title.startsWith(PILOT_SESSION_TITLE_PREFIX)) {
    // Title shape: pilot/<runId>/<taskId>. Pilot worker sets this.
    const rest = title.slice(PILOT_SESSION_TITLE_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const runId = rest.slice(0, slash);
      const taskId = rest.slice(slash + 1);
      const v: SessionInfo = { kind: "pilot-builder", runId, taskId };
      cache.set(sessionID, v);
      return v;
    }
    // Two-segment title (`pilot/<slug>`) or one segment — treat as
    // non-pilot to be conservative. The worker always uses the
    // three-segment shape.
  }

  // Planner detection: session directory under <pilot-base>/<repo>/pilot/plans.
  // We use a path-substring heuristic so the plugin doesn't need to
  // know the exact base dir at startup. The plans dir always contains
  // the literal segment `/pilot/plans` (or `\pilot\plans` on Windows).
  const plansDir = inferPlannerPlansDir(directory);
  if (plansDir !== null) {
    const v: SessionInfo = { kind: "pilot-planner", plansDir };
    cache.set(sessionID, v);
    return v;
  }

  const v: SessionInfo = { kind: "non-pilot" };
  cache.set(sessionID, v);
  return v;
}

/**
 * Heuristically detect a pilot-planner session by its working
 * directory. Returns the plans dir (= the session's `directory`) when
 * the pattern matches, else null.
 *
 * The heuristic: a session whose `directory` is itself the pilot plans
 * dir (i.e. ends with `/pilot/plans`) is a planner session. Pilot
 * builds use a worktree path (`/pilot/worktrees/<runId>/00`), which
 * doesn't match.
 */
function inferPlannerPlansDir(directory: string): string | null {
  if (directory.length === 0) return null;
  // Normalize trailing slash and check the final two segments.
  const norm = directory.replace(/[\\/]+$/, "");
  const sepRegex = /[\\/]/;
  const parts = norm.split(sepRegex);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  if (last === "plans" && prev === "pilot") return norm;
  return null;
}

// --- pilot-builder bash deny -----------------------------------------------

/**
 * Inspect the bash tool's args for a forbidden command. Throws if the
 * command starts with any of the forbidden prefixes. The thrown
 * message names the offending pattern so the agent can read it in its
 * tool-result and react (typically with a STOP).
 *
 * The bash tool's args shape varies slightly across opencode versions:
 *   - Sometimes `{command: "<full string>"}`.
 *   - Sometimes nested under `{cmd: "..."}` or in a `body` field.
 *
 * We extract from each candidate location.
 */
function enforceBuilderBashDeny(args: unknown): void {
  const command = extractBashCommand(args);
  if (command === null) return;

  const trimmed = command.trimStart();
  for (const prefix of FORBIDDEN_BUILDER_BASH_PREFIXES) {
    if (
      trimmed.startsWith(prefix) ||
      // Exact match for `git branch` (no trailing space) — the prefix
      // already has no trailing space; covered.
      trimmed === prefix.trimEnd()
    ) {
      throw new Error(
        `pilot-plugin: pilot-builder is not permitted to run \`${prefix.trim()}\` ` +
          `commands (the worker handles commits/pushes/branches). ` +
          `If this is the right thing to do, respond with STOP: <reason>.`,
      );
    }
  }
}

function extractBashCommand(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const o = args as { command?: unknown; cmd?: unknown; body?: { command?: unknown } };
  if (typeof o.command === "string") return o.command;
  if (typeof o.cmd === "string") return o.cmd;
  if (
    typeof o.body === "object" &&
    o.body !== null &&
    typeof o.body.command === "string"
  ) {
    return o.body.command;
  }
  return null;
}

// --- pilot-planner edit scope ----------------------------------------------

/**
 * Inspect the edit/write/patch tool's args for a target file path. If
 * the path is outside the planner's plans dir (the session's directory
 * + descendants), throws to deny the call.
 *
 * Args shape varies by tool; the file path lives at one of:
 *   - `args.filePath` (Edit, Write)
 *   - `args.path` (some variants)
 *   - `args.file` (alternate naming)
 *
 * If we can't find a path field, we conservatively allow the call
 * (the agent's permission map is still in effect; this hook is only
 * a backstop).
 */
async function enforcePlannerEditScope(
  args: unknown,
  plansDir: string,
): Promise<void> {
  const target = extractTargetPath(args);
  if (target === null) return;

  const abs = path.isAbsolute(target) ? target : path.resolve(plansDir, target);
  // Normalize to compare prefixes.
  const normTarget = path.normalize(abs);
  const normPlans = path.normalize(plansDir).replace(/[\\/]+$/, "");
  if (
    normTarget === normPlans ||
    normTarget.startsWith(normPlans + path.sep) ||
    normTarget.startsWith(normPlans + "/")
  ) {
    return; // inside plans dir
  }
  throw new Error(
    `pilot-plugin: pilot-planner is restricted to the plans directory ` +
      `(${plansDir}). The path ${JSON.stringify(target)} is outside scope. ` +
      `Save your YAML plan inside the plans dir.`,
  );
}

function extractTargetPath(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const o = args as {
    filePath?: unknown;
    path?: unknown;
    file?: unknown;
  };
  if (typeof o.filePath === "string") return o.filePath;
  if (typeof o.path === "string") return o.path;
  if (typeof o.file === "string") return o.file;
  return null;
}

// --- Test exports ----------------------------------------------------------

/**
 * Re-export internal helpers under a single namespace so tests can
 * exercise them without spinning up a fake opencode client. Don't
 * import from this in production code — the public surface is the
 * default-exported Plugin.
 */
export const __test__ = {
  classifySession,
  inferPlannerPlansDir,
  enforceBuilderBashDeny,
  enforcePlannerEditScope,
  extractBashCommand,
  extractTargetPath,
  PILOT_SESSION_TITLE_PREFIX,
  FORBIDDEN_BUILDER_BASH_PREFIXES,
};
