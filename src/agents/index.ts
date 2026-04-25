import type { AgentConfig } from "@opencode-ai/sdk";
import { WORKFLOW_MECHANICS_RULE } from "./shared/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Read prompt files at runtime from the bundled location.
// We use readFileSync rather than static imports because bun's markdown
// handling converts .md files to HTML when imported, which breaks frontmatter
// parsing. tsup's text loader works correctly for the built dist, but during
// development/test bun intercepts the import.
const HERE = dirname(fileURLToPath(import.meta.url));

function readPrompt(name: string): string {
  // In the bundled dist/index.js, import.meta.url resolves to dist/,
  // but prompts are at dist/agents/prompts/. In dev, HERE is src/agents/.
  const candidates = [
    join(HERE, "prompts", name),                               // dev: src/agents/prompts/
    join(HERE, "agents", "prompts", name),                     // dist: dist/ → dist/agents/prompts/
    join(HERE, "..", "..", "src", "agents", "prompts", name),  // fallback dev
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`Could not find prompt file: ${name}`);
}

const orchestratorPrompt = readPrompt("orchestrator.md");
const planPrompt = readPrompt("plan.md");
const buildPrompt = readPrompt("build.md");
const qaReviewerPrompt = readPrompt("qa-reviewer.md");
const qaThoroughPrompt = readPrompt("qa-thorough.md");
const planReviewerPrompt = readPrompt("plan-reviewer.md");
const codeSearcherPrompt = readPrompt("code-searcher.md");
const gapAnalyzerPrompt = readPrompt("gap-analyzer.md");
const architectureAdvisorPrompt = readPrompt("architecture-advisor.md");
const docsMaintainerPrompt = readPrompt("docs-maintainer.md");
const libReaderPrompt = readPrompt("lib-reader.md");
const agentsMdWriterPrompt = readPrompt("agents-md-writer.md");
const pilotBuilderPrompt = readPrompt("pilot-builder.md");
const pilotPlannerPrompt = readPrompt("pilot-planner.md");

/** Strip YAML frontmatter (--- ... ---) from a markdown string. */
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(end + 4).trimStart();
}

/** Parse a simple YAML frontmatter block into a key→value map.
 * Handles multi-line values (indented continuation lines). */
function parseFrontmatter(md: string): Record<string, string> {
  if (!md.startsWith("---")) return {};
  const end = md.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = md.slice(4, end);
  const result: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  const flush = () => {
    if (currentKey) {
      result[currentKey] = currentValue.join(" ").trim();
    }
  };

  for (const line of block.split("\n")) {
    // Indented continuation line (multi-line value)
    if (currentKey && (line.startsWith("  ") || line.startsWith("\t"))) {
      currentValue.push(line.trim());
      continue;
    }
    // New key
    const colon = line.indexOf(":");
    if (colon === -1) {
      flush();
      currentKey = null;
      currentValue = [];
      continue;
    }
    flush();
    currentKey = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    currentValue = value ? [value] : [];
  }
  flush();
  return result;
}

/** Inject the WORKFLOW_MECHANICS_RULE into prompts that use the placeholder. */
function injectWorkflowMechanics(prompt: string): string {
  return prompt.replace("{WORKFLOW_MECHANICS_RULE}", WORKFLOW_MECHANICS_RULE);
}

/** Build an AgentConfig from a prompt markdown file. */
function agentFromPrompt(
  raw: string,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  const fm = parseFrontmatter(raw);
  const body = stripFrontmatter(raw);
  const prompt = injectWorkflowMechanics(body);

  const base: AgentConfig = {
    description: fm["description"] ?? "",
    mode: (fm["mode"] as AgentConfig["mode"]) ?? "subagent",
    model: fm["model"] ?? undefined,
    prompt,
  };

  return { ...base, ...overrides };
}

// ---- Permission blocks (reused across primary agents) ----

// Root-cause finding (v0.7.0 bash-prompt fix, 2026-04-24):
//
// An upstream OpenCode layer (suspected to be the built-in "subagent"
// mode's permission defaults — exact source not pinpointed) injects
// `{permission: "bash", pattern: "*", action: "ask"}` into the effective
// ruleset passed to `Permission.evaluate` AFTER our agent config reaches
// OpenCode. We have hard evidence of this: user log at
//   ~/.local/share/opencode/log/2026-04-24T014426.log lines 40292-40293
//   (subagent with shape matching qa-reviewer: the agent-level block
//   ends `{bash, *, ask}` despite our source shipping `bash: "allow"`)
// and 46605-46606 (same ruleset wins `bash * ask` → prompt fires for
// `git merge-base main HEAD`).
//
// `Permission.evaluate` walks the merged ruleset top-to-bottom and the
// LAST matching rule wins. `Permission.fromConfig` sorts top-level
// permission keys as "wildcard-in-name first, specific-in-name last"
// before flattening into rules. Consequence: for the `bash` permission,
// specific-pattern keys like `"git log *"` sort AFTER the upstream
// `bash * ask` and win via last-match-wins for commands they match.
// The wildcard `"*"` key does NOT beat the upstream ask — their names
// are equally wildcard-only, so merge-position determines the winner
// and the upstream ask lands AFTER us.
//
// Mitigation: enumerated object-form bash maps. `CORE_BASH_ALLOW_LIST`
// contains the specific-pattern allows that cover the reported pain
// points (pnpm lint, tail, ls, git status/diff/log/merge-base, etc.).
// `CORE_DESTRUCTIVE_BASH_DENIES` contains the non-negotiable denies
// that every agent capable of running bash must carry. Both are
// shared across qa-reviewer, qa-thorough, orchestrator, and build
// so the shape stays consistent as the allow-list evolves.
//
// Prior attempts (`c9a288d`, `3483448`) shipped scalar `bash: "allow"`
// on the reviewers and diagnosed the loss of that allow at the wrong
// layer (the global `permission.bash` map). That map was correctly
// removed, but the scalar allow on the agent itself is still losing
// to the upstream `bash * ask` — because the merge order puts their
// wildcard rule last. Specific patterns in our agent block win the
// evaluation; wildcards don't. See `docs/plugin-architecture.md`
// "Permission resolution" for the full writeup and do NOT simplify
// back to scalar `"allow"` without understanding this.

/** Non-destructive commands the reviewers/primary agents need to run
 * freely. Each entry is a glob-style pattern matching the FULL command
 * string (tokens separated by spaces; trailing `*` matches any args).
 * Keep entries specific enough that a destructive form (e.g. `rm -rf`)
 * is NOT inadvertently matched — those live in `CORE_DESTRUCTIVE_BASH_DENIES`.
 */
const CORE_BASH_ALLOW_LIST = {
  // File inspection — safe read-only commands the reviewers use heavily.
  "ls *": "allow",
  "cat *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "wc *": "allow",
  "grep *": "allow",
  "rg *": "allow",
  "find *": "allow",
  "file *": "allow",
  "stat *": "allow",
  "which *": "allow",
  "whereis *": "allow",
  "basename *": "allow",
  "dirname *": "allow",
  "realpath *": "allow",
  "readlink *": "allow",
  "diff *": "allow",
  "sort *": "allow",
  "uniq *": "allow",
  "xxd *": "allow",
  "tree *": "allow",
  "date *": "allow",
  "echo *": "allow",
  // Git read-only subcommands (explicit rather than `git *` so we don't
  // accidentally whitelist `git push` variants the destructive-deny
  // table counteracts via longer-pattern matches — but clarity > trust).
  "git status *": "allow",
  "git log *": "allow",
  "git diff *": "allow",
  "git show *": "allow",
  "git branch *": "allow",
  "git merge-base *": "allow",
  "git rev-parse *": "allow",
  "git rev-list *": "allow",
  "git blame *": "allow",
  "git config --get *": "allow",
  "git config --get": "allow",
  "git remote *": "allow",
  "git stash list *": "allow",
  "git stash list": "allow",
  "git ls-files *": "allow",
  "git describe *": "allow",
  "git tag *": "allow",
  "git fetch *": "allow",
  // Package/build tooling — the reviewers run lint/test/typecheck.
  "pnpm lint *": "allow",
  "pnpm test *": "allow",
  "pnpm typecheck *": "allow",
  "pnpm build *": "allow",
  "pnpm run *": "allow",
  "pnpm install *": "allow",
  "pnpm --filter *": "allow",
  "pnpm -w *": "allow",
  "bun run *": "allow",
  "bun test *": "allow",
  "bun install *": "allow",
  "bunx *": "allow",
  "npm run *": "allow",
  "npm test *": "allow",
  "npx *": "allow",
  "yarn *": "allow",
  "tsc *": "allow",
  "eslint *": "allow",
  "prettier *": "allow",
  "biome *": "allow",
  // Our own CLI — the plan agent and qa-reviewer both call plan-check/plan-dir.
  "bunx @glrs-dev/harness-opencode *": "allow",
  "glrs-oc *": "allow",
  // GitHub CLI — read-only gh calls are fine; destructive `gh pr merge`
  // is gated at the orchestrator level by human intent (user runs /ship).
  "gh pr view *": "allow",
  "gh pr list *": "allow",
  "gh issue view *": "allow",
  "gh issue list *": "allow",
  "gh api *": "allow",
};

/** Destructive-command denies. Applied to EVERY agent block that allows
 * bash at all. Pattern order matters for readability, not for evaluation
 * (findLast doesn't care about insertion order within the same specific
 * pattern; it matches the LAST rule whose both permission AND pattern
 * match). Each pattern here is specific enough to beat `"*": "allow"`.
 */
const CORE_DESTRUCTIVE_BASH_DENIES = {
  "rm -rf /*": "deny",
  "rm -rf ~*": "deny",
  "chmod *": "deny",
  "chown *": "deny",
  "sudo *": "deny",
  "git push --force*": "deny",
  "git push -f *": "deny",
  "git push * --force*": "deny",
  "git push * -f": "deny",
  "git push * main*": "deny",
  "git push * master*": "deny",
  // --force-with-lease is the safe variant — explicit allow rule sorts
  // after the broad --force deny so the lease variant survives.
  "git push --force-with-lease*": "allow",
  "git push * --force-with-lease*": "allow",
};

const ORCHESTRATOR_PERMISSIONS = {
  edit: "allow" as const,
  bash: {
    "*": "allow",
    ...CORE_BASH_ALLOW_LIST,
    ...CORE_DESTRUCTIVE_BASH_DENIES,
    // git clean & git reset --hard are allowed for orchestrator because
    // /fresh runs them after its own question-tool confirmation gate;
    // a permission-layer prompt on top is redundant noise (see issue #54).
    // BUILD keeps the stricter default (deny/ask).
    "git clean *": "allow",
    "git reset --hard*": "allow",
  },
  webfetch: "allow" as const,
  // Per-tool permissions (index signature on AgentConfig allows these)
  ast_grep: "allow",
  tsc_check: "allow",
  eslint_check: "allow",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "allow",
  git: "allow",
  playwright: "allow",
  linear: "allow",
};

const PLAN_PERMISSIONS = {
  edit: "allow" as const,
  // Plan agent is read-only aside from writing under the plan dir — but
  // it does need to RESOLVE the plan dir via the `plan-dir` CLI
  // subcommand (returns an absolute path derived from the worktree's
  // repo-folder key; see src/plan-paths.ts and src/cli.ts). The object-
  // form denies bash broadly and re-allows only `bunx
  // @glrs-dev/harness-opencode plan-dir[...]`. No other bash invocation
  // is permitted, so the read-only-aside-from-plans invariant holds.
  bash: {
    "*": "deny",
    "bunx @glrs-dev/harness-opencode plan-dir": "allow",
    "bunx @glrs-dev/harness-opencode plan-dir *": "allow",
    "glrs-oc plan-dir": "allow",
    "glrs-oc plan-dir *": "allow",
  },
  webfetch: "allow" as const,
  ast_grep: "deny",
  tsc_check: "deny",
  eslint_check: "deny",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "allow",
  git: "allow",
  playwright: "deny",
  linear: "allow",
};

const BUILD_PERMISSIONS = {
  edit: "allow" as const,
  bash: {
    "*": "allow",
    ...CORE_BASH_ALLOW_LIST,
    ...CORE_DESTRUCTIVE_BASH_DENIES,
    // Build is stricter than orchestrator on mutation: no `git clean`
    // (build shouldn't wipe worktree mid-execution), and
    // `git reset --hard` must prompt explicitly.
    "git clean *": "deny",
    "git reset --hard*": "ask",
  },
  webfetch: "allow" as const,
  ast_grep: "allow",
  tsc_check: "allow",
  eslint_check: "allow",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "allow",
  git: "allow",
  playwright: "allow",
  linear: "allow",
};

// ---- Subagent permission blocks ----
// Values mirror what was previously (ineffectively) declared in each
// subagent's `.md` frontmatter. Moving to TS constants so overrides
// actually reach AgentConfig — the flat YAML parser silently dropped
// the nested `permission:` maps, and `agentFromPrompt` never read them.

const QA_REVIEWER_PERMISSIONS = {
  edit: "deny" as const,
  // Object-form bash: the scalar `"allow"` shape loses to OpenCode's
  // upstream subagent-default `{bash, *, ask}` via last-match-wins (see
  // the root-cause comment near ORCHESTRATOR_PERMISSIONS). Enumerated
  // specific patterns in CORE_BASH_ALLOW_LIST sort AFTER the upstream
  // wildcard ask and win for the commands they match. `"*": "allow"`
  // is kept as a backstop but may still lose to the upstream rule for
  // commands not in the enumerated list; those are the known blind spot.
  bash: {
    "*": "allow",
    ...CORE_BASH_ALLOW_LIST,
    ...CORE_DESTRUCTIVE_BASH_DENIES,
  },
  webfetch: "deny" as const,
  ast_grep: "allow",
  tsc_check: "allow",
  eslint_check: "allow",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "deny",
  git: "allow",
  playwright: "allow",
  linear: "deny",
};

// qa-thorough has an identical permission shape to qa-reviewer — both are
// read-only adversarial reviewers that need bash access for `git log`
// scope-creep verification and running lint/test/typecheck (qa-thorough
// always, qa-reviewer conditionally via trust-recent-green). They differ
// only in model, description, and prompt body.
const QA_THOROUGH_PERMISSIONS = {
  edit: "deny" as const,
  // Same object-form as QA_REVIEWER_PERMISSIONS — see the shape rationale
  // there. qa-thorough re-runs the full suite unconditionally (per its
  // prompt), so it touches the same command surface as qa-reviewer and
  // needs the identical bash allow-list.
  bash: {
    "*": "allow",
    ...CORE_BASH_ALLOW_LIST,
    ...CORE_DESTRUCTIVE_BASH_DENIES,
  },
  webfetch: "deny" as const,
  ast_grep: "allow",
  tsc_check: "allow",
  eslint_check: "allow",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "deny",
  git: "allow",
  playwright: "allow",
  linear: "deny",
};

const PLAN_REVIEWER_PERMISSIONS = {
  edit: "deny" as const,
  bash: "deny" as const,
  webfetch: "deny" as const,
  ast_grep: "allow",
  tsc_check: "deny",
  eslint_check: "deny",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "deny",
  git: "allow",
  playwright: "deny",
  linear: "deny",
};

const GAP_ANALYZER_PERMISSIONS = {
  edit: "deny" as const,
  bash: "deny" as const,
  webfetch: "deny" as const,
  ast_grep: "deny",
  tsc_check: "deny",
  eslint_check: "deny",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "allow",
  git: "deny",
  playwright: "deny",
  linear: "allow",
};

const CODE_SEARCHER_PERMISSIONS = {
  edit: "deny" as const,
  bash: "deny" as const,
  webfetch: "deny" as const,
  ast_grep: "allow",
  tsc_check: "deny",
  eslint_check: "deny",
  todo_scan: "deny",
  comment_check: "deny",
  question: "allow",
  serena: "allow",
  memory: "deny",
  git: "deny",
  playwright: "deny",
  linear: "deny",
};

const ARCHITECTURE_ADVISOR_PERMISSIONS = {
  edit: "deny" as const,
  bash: "deny" as const,
  webfetch: "deny" as const,
  ast_grep: "allow",
  tsc_check: "deny",
  eslint_check: "deny",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "allow",
  git: "allow",
  playwright: "deny",
  linear: "allow",
};

const LIB_READER_PERMISSIONS = {
  edit: "deny" as const,
  bash: "deny" as const,
  webfetch: "deny" as const,
  ast_grep: "deny",
  tsc_check: "deny",
  eslint_check: "deny",
  todo_scan: "deny",
  comment_check: "deny",
  question: "allow",
  serena: "deny",
  memory: "allow",
  git: "deny",
  playwright: "deny",
  linear: "deny",
};

const AGENTS_MD_WRITER_PERMISSIONS = {
  edit: "allow" as const,
  bash: "ask" as const,         // preserve ask-semantics from frontmatter
  webfetch: "deny" as const,
  ast_grep: "allow",
  tsc_check: "deny",
  eslint_check: "deny",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",
  serena: "allow",
  memory: "deny",
  git: "allow",
  playwright: "deny",
  linear: "deny",
};

// ---- Pilot agents ---------------------------------------------------------

/**
 * pilot-builder: invoked by the pilot worker (Phase E) one task at a
 * time. Runs inside a per-task git worktree. Must NEVER commit, push,
 * tag, or open a PR — the worker handles commits when verify+touches
 * pass. The runtime worker enforces this via its own state machine,
 * but the permission map is the FIRST wall — denials here mean the
 * agent can't even attempt the destructive command, saving a turn.
 *
 * The DESTRUCTIVE_BUILDER_DENIES include all the standard CORE_DESTRUCTIVE
 * patterns plus pilot-specific commit/push/branch operations. Since
 * specific patterns sort AFTER `*: allow` (per the root-cause comment
 * near ORCHESTRATOR_PERMISSIONS), the denies win for the matching commands
 * even though we keep `*: allow` for general bash usage.
 *
 * (Phase H1 will add a plugin-layer hook that ALSO denies these — belt
 * and suspenders. If a future opencode SDK release subtly changes
 * permission resolution, the plugin hook is the durable safety net.)
 */
const PILOT_BUILDER_PERMISSIONS = {
  edit: "allow" as const,
  bash: {
    "*": "allow",
    ...CORE_BASH_ALLOW_LIST,
    ...CORE_DESTRUCTIVE_BASH_DENIES,
    // Pilot-specific destructive denies — the builder NEVER commits,
    // pushes, switches branches, or opens PRs. The worker does this
    // for the agent.
    "git commit*": "deny",
    "git push*": "deny",
    "git tag*": "deny",
    "git checkout *": "deny",
    "git switch *": "deny",
    "git branch *": "deny",
    "git restore --source*": "deny",
    "git reset *": "deny",
    "gh pr *": "deny",
    "gh release *": "deny",
  },
  webfetch: "allow" as const,
  ast_grep: "allow",
  tsc_check: "allow",
  eslint_check: "allow",
  todo_scan: "allow",
  comment_check: "allow",
  // Builder is unattended — must never call the question tool. (The
  // worker enforces this via the prompt + STOP protocol; permission
  // denial is a backstop.)
  question: "deny",
  serena: "allow",
  memory: "deny",   // pilot tasks are stateless; no per-session memory.
  git: "allow",     // read-only git tools (status, log, diff).
  playwright: "deny",
  linear: "deny",
};

/**
 * pilot-planner: produces YAML plans for the pilot subsystem. Reads
 * the codebase liberally (Serena, ast_grep, todo_scan, linear,
 * webfetch for ticket research), but writes ONLY inside the pilot
 * plans directory. Phase H1 adds a plugin hook that double-enforces
 * the path restriction at edit-tool execution time.
 *
 * Bash is mostly denied to keep the planner from running mutating
 * commands; we open up a narrow allow for the validate subcommand
 * so the planner can self-check its draft plans.
 */
const PILOT_PLANNER_PERMISSIONS = {
  edit: "allow" as const,
  bash: {
    "*": "deny",
    // Read-only inspection — same surface as PLAN_PERMISSIONS, plus a few.
    "ls *": "allow",
    "cat *": "allow",
    "head *": "allow",
    "tail *": "allow",
    "wc *": "allow",
    "grep *": "allow",
    "rg *": "allow",
    "find *": "allow",
    "git status *": "allow",
    "git log *": "allow",
    "git diff *": "allow",
    "git show *": "allow",
    "git branch *": "allow",
    "git rev-parse *": "allow",
    // Pilot CLI: validate, plan-dir for self-check + path resolution.
    "bunx @glrs-dev/harness-opencode pilot validate *": "allow",
    "bunx @glrs-dev/harness-opencode pilot validate": "allow",
    "bunx @glrs-dev/harness-opencode pilot plan-dir": "allow",
    "bunx @glrs-dev/harness-opencode pilot plan-dir *": "allow",
    "bunx @glrs-dev/harness-opencode plan-dir": "allow",
    "bunx @glrs-dev/harness-opencode plan-dir *": "allow",
    "glrs-oc pilot validate *": "allow",
    "glrs-oc pilot validate": "allow",
    "glrs-oc pilot plan-dir": "allow",
    "glrs-oc pilot plan-dir *": "allow",
    "glrs-oc plan-dir": "allow",
    "glrs-oc plan-dir *": "allow",
  },
  // No webfetch by default — the planner reads tickets via the linear
  // MCP. If the user invokes with a GitHub URL, they need the linear
  // / webfetch combination explicitly. Mark deny here and the operator
  // can override per-session.
  webfetch: "deny" as const,
  ast_grep: "allow",
  tsc_check: "deny",       // no need to typecheck; we're writing YAML.
  eslint_check: "deny",
  todo_scan: "allow",
  comment_check: "allow",
  question: "allow",       // the planner CAN ask the human (interactive).
  serena: "allow",
  memory: "deny",
  git: "allow",            // read-only git tools.
  playwright: "deny",
  linear: "allow",
};


// ---- Tier map ----

export type ModelTier = "deep" | "mid" | "fast";

/**
 * Maps every agent name to its model tier. Used by the harness.models
 * config resolution in src/config-hook.ts.
 *
 * - deep: expensive, high-capability models (opus-class)
 * - mid:  balanced cost/capability (sonnet-class)
 * - fast: cheap, low-latency (haiku-class)
 *
 * Adding an agent to createAgents() without adding it here will fail
 * the AGENT_TIERS completeness test — that's intentional.
 */
export const AGENT_TIERS: Record<string, ModelTier> = {
  orchestrator: "deep",
  plan: "deep",
  "qa-thorough": "deep",
  "architecture-advisor": "deep",
  "plan-reviewer": "deep",
  "gap-analyzer": "deep",
  "pilot-planner": "deep",
  build: "mid",
  "qa-reviewer": "mid",
  "docs-maintainer": "mid",
  "lib-reader": "mid",
  "agents-md-writer": "mid",
  "pilot-builder": "mid",
  "code-searcher": "fast",
};

// ---- Public API ----

export function createAgents(): Record<string, AgentConfig> {
  return {
    // Primary agents
    orchestrator: agentFromPrompt(orchestratorPrompt, {
      description: "End-to-end orchestrator. Takes a request from intent to ready-to-ship in one session. Default primary agent.",
      mode: "primary",
      model: "anthropic/claude-opus-4-7",
      temperature: 0.2,
      permission: ORCHESTRATOR_PERMISSIONS as AgentConfig["permission"],
    }),
    plan: agentFromPrompt(planPrompt, {
      description: "Interactive planner. Orchestrates gap analysis and adversarial review. Produces a written plan in the repo-shared plan directory (resolve via `bunx @glrs-dev/harness-opencode plan-dir`).",
      mode: "primary",
      model: "anthropic/claude-opus-4-7",
      temperature: 0.3,
      permission: PLAN_PERMISSIONS as AgentConfig["permission"],
    }),
    build: agentFromPrompt(buildPrompt, {
      description: "Executes a written plan. Runs tests inline, gates completion on QA review.",
      mode: "primary",
      model: "anthropic/claude-sonnet-4-6",
      temperature: 0.1,
      permission: BUILD_PERMISSIONS as AgentConfig["permission"],
    }),

    // Subagents — model/mode/description from frontmatter, permissions
    // via overrides (see permission blocks above). docs-maintainer has no
    // frontmatter permission declaration and keeps that behavior.
    "qa-reviewer": agentFromPrompt(qaReviewerPrompt, {
      permission: QA_REVIEWER_PERMISSIONS as AgentConfig["permission"],
    }),
    "qa-thorough": agentFromPrompt(qaThoroughPrompt, {
      permission: QA_THOROUGH_PERMISSIONS as AgentConfig["permission"],
    }),
    "plan-reviewer": agentFromPrompt(planReviewerPrompt, {
      permission: PLAN_REVIEWER_PERMISSIONS as AgentConfig["permission"],
    }),
    "code-searcher": agentFromPrompt(codeSearcherPrompt, {
      permission: CODE_SEARCHER_PERMISSIONS as AgentConfig["permission"],
    }),
    "gap-analyzer": agentFromPrompt(gapAnalyzerPrompt, {
      permission: GAP_ANALYZER_PERMISSIONS as AgentConfig["permission"],
    }),
    "architecture-advisor": agentFromPrompt(architectureAdvisorPrompt, {
      permission: ARCHITECTURE_ADVISOR_PERMISSIONS as AgentConfig["permission"],
    }),
    "docs-maintainer": agentFromPrompt(docsMaintainerPrompt),
    "lib-reader": agentFromPrompt(libReaderPrompt, {
      permission: LIB_READER_PERMISSIONS as AgentConfig["permission"],
    }),
    "agents-md-writer": agentFromPrompt(agentsMdWriterPrompt, {
      permission: AGENTS_MD_WRITER_PERMISSIONS as AgentConfig["permission"],
    }),

    // Pilot subsystem agents (Phase F1 + F2). The frontmatter sets
    // mode/model/description; temperature is passed via override
    // because `agentFromPrompt` doesn't currently parse the
    // temperature field (and we don't want to change that helper for
    // every agent at once — out of scope for F1/F2).
    "pilot-builder": agentFromPrompt(pilotBuilderPrompt, {
      mode: "primary",
      model: "anthropic/claude-sonnet-4-6",
      temperature: 0.1,
      permission: PILOT_BUILDER_PERMISSIONS as AgentConfig["permission"],
    }),
    "pilot-planner": agentFromPrompt(pilotPlannerPrompt, {
      mode: "primary",
      model: "anthropic/claude-opus-4-7",
      temperature: 0.3,
      permission: PILOT_PLANNER_PERMISSIONS as AgentConfig["permission"],
    }),
  };
}
