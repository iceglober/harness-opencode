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

const ORCHESTRATOR_PERMISSIONS = {
  edit: "allow" as const,
  bash: {
    "*": "allow",
    "git push *": "allow",
    "git push --force*": "deny",
    "git push -f *": "deny",
    "git push * main*": "deny",
    "git push * master*": "deny",
    "git clean *": "deny",
    "git reset --hard*": "ask",
    "git checkout *": "ask",
    "git worktree *": "ask",
    "rm -rf *": "deny",
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
    "git push *": "allow",
    "git push --force*": "deny",
    "git push -f *": "deny",
    "git push * main*": "deny",
    "git push * master*": "deny",
    "git clean *": "deny",
    "git reset --hard*": "ask",
    "git checkout *": "ask",
    "git worktree *": "ask",
    "rm -rf *": "deny",
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

    // Subagents — model/mode/description from frontmatter
    "qa-reviewer": agentFromPrompt(qaReviewerPrompt),
    "plan-reviewer": agentFromPrompt(planReviewerPrompt),
    "autopilot-verifier": agentFromPrompt(autopilotVerifierPrompt),
    "code-searcher": agentFromPrompt(codeSearcherPrompt),
    "gap-analyzer": agentFromPrompt(gapAnalyzerPrompt),
    "architecture-advisor": agentFromPrompt(architectureAdvisorPrompt),
    "docs-maintainer": agentFromPrompt(docsMaintainerPrompt),
    "lib-reader": agentFromPrompt(libReaderPrompt),
    "agents-md-writer": agentFromPrompt(agentsMdWriterPrompt),
  };
}
