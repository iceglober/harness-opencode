/**
 * Prompt templates the worker sends into the builder agent's session.
 *
 * Two templates:
 *
 *   - `kickoffPrompt(task, ctx)`: the FIRST message of a task's
 *     session. Sets the agent's framing (this is a pilot task, here's
 *     your scope, here are the rules), then states the task itself.
 *   - `fixPrompt(task, lastFailure)`: subsequent messages when verify
 *     failed and we want the agent to try again. Quotes the failure
 *     output verbatim and asks for a focused fix.
 *
 * Both functions are pure: same input → same string. No filesystem,
 * no network. Tests assert on substring presence and exact-text
 * snippets to lock down the core invariants without making test
 * maintenance brittle.
 *
 * **Hard constraints baked into every kickoff** (these are
 * worker-side enforcement, but stating them in the prompt reduces
 * needless attempts):
 *
 *   1. Do NOT commit, push, or open a PR. The worker commits when the
 *      task succeeds; the agent committing prematurely breaks the
 *      worker's diff-since-baseline accounting.
 *   2. Do NOT ask clarifying questions. Pilot is unattended. If the
 *      task is genuinely ambiguous, the agent must STOP (see #4).
 *   3. Do NOT edit files outside the declared `touches:` scope.
 *   4. STOP protocol: if the agent cannot make progress, it must
 *      respond with a single line beginning `STOP:` and a brief
 *      reason. The worker detects this and fails the task fast.
 *
 * Ship-checklist alignment: Phase D3 of `PILOT_TODO.md`.
 */

import type { PlanTask } from "../plan/schema.js";

// --- Public types ----------------------------------------------------------

/**
 * Run-level context passed into kickoffPrompt. Lives at this scope
 * because plan defaults / branch info aren't on `PlanTask` itself.
 */
export type RunContext = {
  /** Plan name, for the agent to ground itself. */
  planName: string;

  /**
   * Branch the worker has checked out for this task. The agent should
   * NOT switch branches; this is informational so the agent can
   * mention it if relevant.
   */
  branch: string;

  /**
   * Worktree absolute path. The agent operates on files relative to
   * this. The agent's tools default to this dir (set via the session's
   * `directory` query param), but the prompt mentions it for transparency.
   */
  worktreePath: string;

  /**
   * Optional milestone label (`task.milestone`). When present, the
   * prompt frames the work as part of that milestone.
   */
  milestone?: string;

  /**
   * Defaults-derived `verify_after_each`, appended after the task's
   * own verify. The prompt informs the agent so it knows what
   * checks will run.
   */
  verifyAfterEach: ReadonlyArray<string>;

  /**
   * Optional milestone-level extra verify (matched by `milestones[].verify`
   * for the task's milestone). Empty array if no milestone match.
   */
  verifyMilestone: ReadonlyArray<string>;
};

/**
 * Captured failure for the fix-prompt: command + exit + output.
 */
export type LastFailure = {
  /** The verify command that failed (e.g. `bun test`). */
  command: string;
  /** Exit code from the command. */
  exitCode: number;
  /**
   * Combined stdout+stderr output. Caller should truncate before
   * passing — the prompt does not re-truncate (truncation is a
   * single-source-of-truth concern; we don't want the prompt and the
   * worker JSONL log diverging).
   */
  output: string;
  /**
   * Optional touches violation context. When set, indicates the
   * previous attempt edited files outside scope and the agent should
   * back those out.
   */
  touchesViolators?: ReadonlyArray<string>;
};

// --- Public API ------------------------------------------------------------

/**
 * Produce the FIRST message for a task's session.
 *
 * Structure (in order):
 *   1. Header: identifies this as a pilot task and names the task ID.
 *   2. Worktree + branch context.
 *   3. Hard rules (commit/push/questions/scope/STOP).
 *   4. Allowed scope (touches globs).
 *   5. Verify commands.
 *   6. The task prompt itself (verbatim from `pilot.yaml`).
 *
 * Single string output — opencode's `session.promptAsync` body is a
 * `parts: [{ type: "text", text: ... }]` array; the worker wraps this
 * function's return value into that shape.
 */
export function kickoffPrompt(
  task: PlanTask,
  ctx: RunContext,
): string {
  const sections: string[] = [];

  sections.push(
    `# Pilot task: ${task.id} — ${task.title}`,
    ``,
    `You are running unattended as the **pilot-builder** agent under the pilot subsystem ` +
      `of \`@glrs-dev/harness-opencode\`. This is task **${task.id}** of the plan **"${ctx.planName}"**` +
      (ctx.milestone ? ` (milestone: **${ctx.milestone}**)` : "") +
      `.`,
    ``,
    `## Workspace`,
    ``,
    `- Worktree: \`${ctx.worktreePath}\``,
    `- Branch: \`${ctx.branch}\` (the worker has already created and checked out this branch — DO NOT switch branches)`,
  );

  sections.push(``, `## Hard rules`, ``);
  sections.push(
    `1. **DO NOT commit, push, tag, or open a PR.** The worker commits the work for you when the task succeeds. Running git commit yourself breaks the worker's accounting and will fail the task.`,
    `2. **DO NOT ask clarifying questions.** Pilot is unattended. If you genuinely cannot proceed, follow the STOP protocol below.`,
    `3. **DO NOT edit files outside the declared scope** (see "Allowed scope" below). The worker enforces this after you finish; out-of-scope edits fail the task.`,
    `4. **STOP protocol.** If you hit an unrecoverable problem (missing tool, fundamentally ambiguous task, environmental issue), respond with a single message whose FIRST non-whitespace line begins with \`STOP:\` followed by a one-sentence reason. The worker will fail this task fast and preserve the worktree for human inspection.`,
    `5. **Repo conventions.** Read \`AGENTS.md\` (or \`CLAUDE.md\` / \`README.md\` if those don't exist) at the worktree root before editing — match existing style, dependencies, and test patterns.`,
  );

  sections.push(``, `## Allowed scope (\`touches\`)`, ``);
  if (task.touches.length === 0) {
    sections.push(
      `**Empty.** This is a verify-only task — you must NOT edit any files. ` +
        `If you genuinely need to edit files to make the verify commands pass, that's a STOP.`,
    );
  } else {
    sections.push(`You may only modify files matching:`, ``);
    for (const g of task.touches) sections.push(`- \`${g}\``);
  }

  sections.push(``, `## Verify commands`, ``);
  const allVerify = [
    ...task.verify,
    ...ctx.verifyAfterEach,
    ...ctx.verifyMilestone,
  ];
  if (allVerify.length === 0) {
    sections.push(
      `No verify commands were declared. The worker will commit your changes as soon as you finish without protest.`,
    );
  } else {
    sections.push(
      `After you finish, the worker will run the following commands (in order). All must exit zero for the task to succeed:`,
      ``,
    );
    for (const v of allVerify) sections.push(`- \`${v}\``);
    if (ctx.verifyAfterEach.length > 0) {
      sections.push(
        ``,
        `(The last ${ctx.verifyAfterEach.length} commands above are run after every task in this plan, not just this one.)`,
      );
    }
  }

  if (task.context !== undefined && task.context.trim().length > 0) {
    // Placed BEFORE the task directive so the directive is the last
    // thing in the builder's kickoff context — the most recent, most
    // salient framing when it starts making edits. Reading order:
    // hard rules → scope → verify → context (grounding) → task (act).
    sections.push(``, `## Context`, ``, task.context.trim());
  }

  sections.push(``, `## Task`, ``, task.prompt.trim());

  return sections.join("\n");
}

/**
 * Produce a follow-up message for a task whose verify failed (or whose
 * touches enforcement caught out-of-scope edits). Sent to the SAME
 * session — the agent already has all the context from the kickoff.
 *
 * Quotes the failure verbatim. Re-states the STOP protocol (the agent
 * may now realize it needs to stop after seeing the failure that the
 * kickoff didn't anticipate).
 */
export function fixPrompt(_task: PlanTask, last: LastFailure): string {
  void _task; // task context is implicit in the conversation history
  const sections: string[] = [];

  if (last.touchesViolators && last.touchesViolators.length > 0) {
    sections.push(
      `# Verify-pass but out-of-scope edits detected`,
      ``,
      `The verify commands passed, but you edited files outside the declared scope:`,
      ``,
    );
    for (const v of last.touchesViolators) sections.push(`- \`${v}\``);
    sections.push(
      ``,
      `Revert your changes to those files. They must not appear in the final diff.`,
      ``,
      `Run the verify commands again after reverting (the worker will).`,
      ``,
      `Reminder: if reverting them would make the verify commands fail, that's a STOP — the task is asking you to do something the scope forbids.`,
    );
    return sections.join("\n");
  }

  // Standard verify-failure path.
  sections.push(
    `# Verify failed — please fix and try again`,
    ``,
    `The command \`${last.command}\` exited with code ${last.exitCode}.`,
    ``,
    `## Output`,
    ``,
    "```",
    last.output.trimEnd(),
    "```",
    ``,
    `## What to do`,
    ``,
    `1. Read the output carefully. The failure is the source of truth — do not assume the test or check is wrong unless the output explicitly indicates a stale snapshot, environment issue, or flaky external dependency.`,
    `2. Make targeted edits within the declared \`touches\` scope to address the failure.`,
    `3. Do NOT commit. Do NOT ask questions. The worker will re-run verify when you finish.`,
    ``,
    `If the failure indicates an unrecoverable problem (missing tool, contradictory requirements), respond with \`STOP: <reason>\` as your first line.`,
  );
  return sections.join("\n");
}
