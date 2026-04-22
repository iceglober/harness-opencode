import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function readPrompt(name: string): string {
  // In the bundled dist/index.js, import.meta.url resolves to dist/,
  // but prompts are at dist/commands/prompts/. In dev, HERE is src/commands/.
  const candidates = [
    join(HERE, "prompts", name),                                  // dev: src/commands/prompts/
    join(HERE, "commands", "prompts", name),                      // dist: dist/ → dist/commands/prompts/
    join(HERE, "..", "..", "src", "commands", "prompts", name),   // fallback dev
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`Could not find command prompt: ${name}`);
}

const autopilotPrompt = readPrompt("autopilot.md");
const shipPrompt = readPrompt("ship.md");
const reviewPrompt = readPrompt("review.md");
const initDeepPrompt = readPrompt("init-deep.md");
const researchPrompt = readPrompt("research.md");
const freshPrompt = readPrompt("fresh.md");
const costsPrompt = readPrompt("costs.md");

type CommandConfig = {
  template: string;
  description?: string;
  agent?: string;
};

export function createCommands(): Record<string, CommandConfig> {
  return {
    autopilot: {
      template: autopilotPrompt,
      description:
        "Self-driving run. Pass a ticket ref (any tracker), a task description, or a question.",
    },
    ship: {
      template: shipPrompt,
      description:
        "Finalize, commit, push, and open a PR/MR. Human-gated at each step.",
    },
    review: {
      template: reviewPrompt,
      description:
        "Adversarial read-only review of a PR, current branch, commit range, or file.",
    },
    "init-deep": {
      template: initDeepPrompt,
      description:
        "Generate hierarchical AGENTS.md files for the current repo.",
    },
    research: {
      template: researchPrompt,
      description: "Deep codebase exploration via parallel subagents.",
    },
    fresh: {
      template: freshPrompt,
      description:
        "Re-key the current worktree to a new task. Runs the repo's .glorious/hooks/fresh-reset if present; otherwise discards local changes and creates a new branch from latest origin/<default>. Writes a handoff brief for agent continuity.",
    },
    costs: {
      template: costsPrompt,
      description:
        "Show running LLM cost totals accrued by the cost-tracker plugin. Pass --json or --log for raw data.",
    },
  };
}
