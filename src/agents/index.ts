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
const planReviewerPrompt = readPrompt("plan-reviewer.md");
const autopilotVerifierPrompt = readPrompt("autopilot-verifier.md");
const codeSearcherPrompt = readPrompt("code-searcher.md");
const gapAnalyzerPrompt = readPrompt("gap-analyzer.md");
const architectureAdvisorPrompt = readPrompt("architecture-advisor.md");
const docsMaintainerPrompt = readPrompt("docs-maintainer.md");
const libReaderPrompt = readPrompt("lib-reader.md");
const agentsMdWriterPrompt = readPrompt("agents-md-writer.md");

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

// Shared bash rule-map for read-only reviewers (qa-reviewer, autopilot-verifier).
// These agents may run ANY non-destructive command but must never mutate history,
// force-push, or touch the filesystem root.
const NONDESTRUCTIVE_BASH_RULES = {
  "*": "allow",
  "git push --force*": "deny",
  "git push --force-with-lease*": "allow",
  "git push -f *": "deny",
  "git push * --force*": "deny",
  "git push * --force-with-lease*": "allow",
  "git push * -f": "deny",
  "git clean *": "deny",
  "git reset --hard*": "deny",
  "rm -rf /*": "deny",
  "rm -rf ~*": "deny",
  "chmod *": "deny",
  "chown *": "deny",
  "sudo *": "deny",
} as const;

const ORCHESTRATOR_PERMISSIONS = {
  edit: "allow" as const,
  bash: {
    // Non-destructive ops are allowed globally via plugin config hook.
    // Agent-level rules layer on top — last match wins.
    "*": "allow",
    "git push --force*": "deny",
    "git push --force-with-lease*": "allow",
    "git push -f *": "deny",
    "git push * --force*": "deny",
    "git push * --force-with-lease*": "allow",
    "git push * -f": "deny",
    "git push * main*": "deny",
    "git push * master*": "deny",
    // git clean & git reset --hard are allowed for orchestrator because
    // /fresh runs them after its own question-tool confirmation gate;
    // a permission-layer prompt on top is redundant noise (see issue #54).
    // Global and BUILD permissions keep the stricter default.
    "git clean *": "allow",
    "git reset --hard*": "allow",
    "rm -rf /*": "deny",
    "rm -rf ~*": "deny",
    "chmod *": "deny",
    "chown *": "deny",
    "sudo *": "deny",
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
  bash: "deny" as const,
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
    "git push --force*": "deny",
    "git push --force-with-lease*": "allow",
    "git push -f *": "deny",
    "git push * --force*": "deny",
    "git push * --force-with-lease*": "allow",
    "git push * -f": "deny",
    "git push * main*": "deny",
    "git push * master*": "deny",
    "git clean *": "deny",
    "git reset --hard*": "ask",
    "rm -rf /*": "deny",
    "rm -rf ~*": "deny",
    "chmod *": "deny",
    "chown *": "deny",
    "sudo *": "deny",
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
  bash: { ...NONDESTRUCTIVE_BASH_RULES },
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

const AUTOPILOT_VERIFIER_PERMISSIONS = {
  edit: "deny" as const,
  bash: { ...NONDESTRUCTIVE_BASH_RULES },
  webfetch: "deny" as const,
  ast_grep: "allow",
  tsc_check: "allow",
  eslint_check: "allow",
  todo_scan: "allow",
  comment_check: "allow",
  question: "deny",        // hard rule: verifier never asks
  serena: "allow",
  memory: "deny",
  git: "allow",
  playwright: "deny",
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
      description: "Interactive planner. Orchestrates gap analysis and adversarial review. Produces a written plan at .agent/plans/<slug>.md.",
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
    "plan-reviewer": agentFromPrompt(planReviewerPrompt, {
      permission: PLAN_REVIEWER_PERMISSIONS as AgentConfig["permission"],
    }),
    "autopilot-verifier": agentFromPrompt(autopilotVerifierPrompt, {
      permission: AUTOPILOT_VERIFIER_PERMISSIONS as AgentConfig["permission"],
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
  };
}
