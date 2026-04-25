/**
 * Zod schema for the `pilot.yaml` plan format consumed by the pilot
 * subsystem (`src/pilot/...`).
 *
 * This is the source of truth for what a pilot plan IS — a list of tasks
 * (with deps, prompts, touch-globs, and verify commands) grouped under
 * optional milestones, with run-wide defaults. Every other module in
 * `src/pilot/plan/*` operates on the typed `Plan` produced by this schema.
 *
 * Why Zod (not just TypeScript types):
 *   - YAML is untyped at the file level. Without runtime validation, a
 *     malformed plan would explode somewhere deep in the worker loop
 *     instead of failing fast at `pilot validate`.
 *   - Defaults need real fill-in semantics (defaults.model, defaults.agent,
 *     etc.). Zod's `.default(...)` does this in one place; sprinkling
 *     `?? "anthropic/claude-sonnet-4-6"` everywhere would diverge.
 *   - The CLI's `pilot validate` subcommand needs structured error
 *     reporting (path-into-document + message). Zod's issue list is
 *     exactly that.
 *
 * What this module deliberately does NOT do:
 *   - Cross-task validation: dependency cycles, dangling `depends_on`,
 *     duplicate IDs, glob conflicts. Those live in `dag.ts` and `globs.ts`
 *     because they need to walk the whole plan, not validate one node.
 *   - Slug derivation. That's `slug.ts` — different concern (fs paths).
 *   - Loading from disk. That's `load.ts`.
 *
 * Ship-checklist alignment: Phase A1 of `PILOT_TODO.md`.
 */

import { z } from "zod";

// --- Constants -------------------------------------------------------------

/**
 * Default builder agent name. Matches `pilot-builder` registered via
 * `createAgents()` (Phase F1).
 */
export const DEFAULT_AGENT = "pilot-builder";

/**
 * Default model spec. Format: `<providerID>/<modelID>` per opencode SDK
 * convention (see `@opencode-ai/sdk` `Options.body.model`).
 *
 * Rationale: Sonnet-4-6 is fast enough for the iterate-on-test-failures
 * loop and cheap enough that a v0.1 5-task plan completes for ~$5. Plans
 * needing harder reasoning override per-task or per-defaults.
 */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * Default per-task max turns before the worker gives up. A "turn" is one
 * assistant response. 50 covers a fix-loop of ~16 iterations (3 turns each:
 * read-edit-test) plus headroom; well below opencode's own session caps.
 */
export const DEFAULT_MAX_TURNS = 50;

/**
 * Default per-task cost cap in USD. Reporting-only in v0.1 (worker logs
 * but does not preempt — preemption is a v0.4+ deferral per
 * `PILOT_TODO.md`).
 */
export const DEFAULT_MAX_COST_USD = 5.0;

/**
 * Task ID grammar: uppercase letter, then uppercase / digits / dashes.
 * Matches Linear-style IDs (`ENG-1234`, `PILOT-API-1`) but is intentionally
 * stricter than Linear's so plan authors don't accidentally use IDs that
 * conflict with branch-name escaping (no dots, no slashes, no spaces).
 *
 * Rejects: lowercase, leading digit, leading dash, special chars.
 */
export const TASK_ID_PATTERN = /^[A-Z][A-Z0-9-]*$/;

// --- Sub-schemas -----------------------------------------------------------

/**
 * Provider/model spec. Strings only — opencode's
 * `SessionPromptAsyncData.body.model` accepts an object with `providerID`
 * + `modelID`, but a single string `<providerID>/<modelID>` is the
 * canonical wire format and what users actually type. Splitting happens
 * at the call site (`pilot/opencode/session.ts`).
 */
const ModelSchema = z
  .string()
  .min(3, "model must be a non-empty string")
  .refine((s) => s.includes("/"), {
    message: "model must be in the form '<providerID>/<modelID>' (e.g. 'anthropic/claude-sonnet-4-6')",
  });

/**
 * Plan defaults — applied to every task that doesn't override the field.
 * Every field has a literal default so the loader never sees `undefined`
 * post-parse.
 *
 * Note on the `.default(...)` argument: Zod 4 does NOT cascade child
 * `.default(...)` values when the parent itself receives a literal `{}`
 * default. The parent's default is the value used verbatim — no inner
 * parse pass — so we must list every field's default explicitly here.
 * (Tested with zod 4.3.6: `.default({})` produced `{}` post-parse, not
 * the field-by-field defaults below.)
 */
const DefaultsSchema = z
  .object({
    model: ModelSchema.default(DEFAULT_MODEL),
    agent: z.string().min(1).default(DEFAULT_AGENT),
    max_turns: z.number().int().positive().default(DEFAULT_MAX_TURNS),
    max_cost_usd: z.number().positive().default(DEFAULT_MAX_COST_USD),
    /**
     * Verify commands run after EVERY task (in addition to per-task
     * `verify`). Useful for repo-wide checks like `bun run typecheck` that
     * every task must pass.
     */
    verify_after_each: z.array(z.string().min(1)).default([]),
  })
  .default({
    model: DEFAULT_MODEL,
    agent: DEFAULT_AGENT,
    max_turns: DEFAULT_MAX_TURNS,
    max_cost_usd: DEFAULT_MAX_COST_USD,
    verify_after_each: [],
  });

/**
 * Touch globs — file-path patterns describing which paths a task is
 * allowed to modify. Empty array means "no edits permitted" — enforced
 * post-task by the worker (Phase C2).
 *
 * The schema only validates the syntactic shape of each glob string here
 * (non-empty, no leading slash). Conflict detection across tasks is
 * cross-task and lives in `globs.ts`.
 */
const TouchesSchema = z.array(
  z
    .string()
    .min(1, "touches entries must be non-empty")
    .refine((s) => !s.startsWith("/"), {
      message: "touches globs must be repo-relative (no leading '/')",
    }),
);

/**
 * Verify command — a shell string. Run via `bash -c <cmd>` in the task's
 * worktree (Phase D4 runner). Single string, not array-of-args, because
 * pipes/redirects in verify commands are common (`bun test 2>&1 | grep -v noise`).
 */
const VerifyCommandSchema = z.string().min(1, "verify entries must be non-empty");

/**
 * Single task — the unit of work the builder agent executes.
 *
 * Field semantics:
 *   - `id`: stable identifier; appears in branch names (`pilot/<slug>/<id>`),
 *     state DB, logs. Must be unique within a plan.
 *   - `title`: short human label (~60 chars). Shown in `pilot status`.
 *     Distinct from `prompt` so status output stays compact.
 *   - `prompt`: the actual instruction for the builder agent. Multi-line
 *     allowed (YAML `|` block scalar).
 *   - `touches`: glob patterns. Empty array = "no edits" (verify-only task).
 *   - `verify`: shell commands run after the agent reports done. ALL must
 *     pass for the task to succeed.
 *   - `depends_on`: list of task IDs this task waits for. Validated as
 *     existing IDs by `dag.ts`.
 *   - `agent` / `model` / `max_turns` / `max_cost_usd`: per-task overrides
 *     of `defaults`.
 *   - `milestone`: optional grouping label. Used by status output and to
 *     attach milestone-level extra `verify` (see MilestoneSchema).
 */
const TaskSchema = z
  .object({
    id: z
      .string()
      .regex(TASK_ID_PATTERN, "task id must match /^[A-Z][A-Z0-9-]*$/"),
    title: z.string().min(1, "task title must be non-empty"),
    prompt: z.string().min(1, "task prompt must be non-empty"),
    touches: TouchesSchema.default([]),
    verify: z.array(VerifyCommandSchema).default([]),
    depends_on: z
      .array(z.string().regex(TASK_ID_PATTERN, "depends_on entries must be valid task IDs"))
      .default([]),
    agent: z.string().min(1).optional(),
    model: ModelSchema.optional(),
    max_turns: z.number().int().positive().optional(),
    max_cost_usd: z.number().positive().optional(),
    milestone: z.string().min(1).optional(),
  })
  // Strict mode catches typos like `dependencies` instead of `depends_on`.
  // Zod 4's `.strict()` takes no arguments — message is built-in
  // ("Unrecognized key: <key>").
  .strict();

/**
 * Optional milestone block. v0.1 represents milestones as a flat list with
 * `name` (matched by `task.milestone`) + extra verify commands run when
 * the LAST task of that milestone completes. This lets plan authors group
 * related tasks and run integration tests once per milestone instead of
 * after every task.
 *
 * Milestones are a presentation/grouping concept; they do NOT change DAG
 * scheduling.
 */
const MilestoneSchema = z
  .object({
    name: z.string().min(1, "milestone name must be non-empty"),
    description: z.string().optional(),
    verify: z.array(VerifyCommandSchema).default([]),
  })
  .strict();

// --- Top-level Plan schema -------------------------------------------------

/**
 * Full plan schema. The top-level `pilot.yaml` document.
 *
 *   - `name`: human-readable plan name. Becomes part of the run row in
 *     state DB. Required so `pilot status` has something to show.
 *   - `branch_prefix`: optional override for branch naming. Defaults are
 *     applied by the loader (`load.ts`) once it knows the slug —
 *     specifically `pilot/<slug>` — so we leave this optional here.
 *   - `defaults`: see DefaultsSchema.
 *   - `milestones`: see MilestoneSchema. Optional.
 *   - `tasks`: REQUIRED, at least one task. The whole point of a plan.
 */
export const PlanSchema = z
  .object({
    name: z.string().min(1, "plan name must be non-empty"),
    branch_prefix: z.string().min(1).optional(),
    defaults: DefaultsSchema,
    milestones: z.array(MilestoneSchema).default([]),
    tasks: z.array(TaskSchema).min(1, "plan must declare at least one task"),
  })
  .strict();

// --- Public types ----------------------------------------------------------

export type Plan = z.infer<typeof PlanSchema>;
export type PlanDefaults = z.infer<typeof DefaultsSchema>;
export type PlanTask = z.infer<typeof TaskSchema>;
export type PlanMilestone = z.infer<typeof MilestoneSchema>;

// --- Helpers ---------------------------------------------------------------

/**
 * Validate an arbitrary parsed YAML object against the schema. Returns a
 * discriminated union so callers can branch on success/failure without
 * try/catch noise.
 *
 * On failure, `errors` is the formatted `ZodError.issues` list with each
 * issue's `.path` joined into a YAML-like dotted/bracketed path
 * (`tasks[2].verify[0]`). Suitable for direct printing by `pilot validate`.
 */
export function parsePlan(
  input: unknown,
):
  | { ok: true; plan: Plan }
  | { ok: false; errors: Array<{ path: string; message: string }> } {
  const result = PlanSchema.safeParse(input);
  if (result.success) {
    return { ok: true, plan: result.data };
  }
  const errors = result.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
  return { ok: false, errors };
}

/**
 * Format a Zod issue path as a YAML-aware dotted/bracketed string.
 *
 *   - `["tasks", 2, "verify", 0]` → `tasks[2].verify[0]`
 *   - `["defaults", "model"]`     → `defaults.model`
 *   - `[]`                        → `<root>`
 *
 * Numbers become bracket indices; strings become dotted segments. The
 * leading dot for a numeric-first path (`[0]`) is suppressed.
 */
function formatPath(parts: ReadonlyArray<PropertyKey>): string {
  if (parts.length === 0) return "<root>";
  let out = "";
  for (const p of parts) {
    if (typeof p === "number") {
      out += `[${p}]`;
    } else {
      // Symbols are vanishingly unlikely in YAML-derived input, but Zod
      // types `path` as `PropertyKey[]`, so handle them.
      const s = typeof p === "symbol" ? p.toString() : p;
      out += out.length === 0 ? s : `.${s}`;
    }
  }
  return out;
}
