import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAgents } from "../src/agents/index.js";

describe("createAgents", () => {
  const agents = createAgents();

  it("returns exactly 13 agents", () => {
    expect(Object.keys(agents).length).toBe(13);
  });

  it("has the 3 primary agents with mode=primary", () => {
    for (const name of ["orchestrator", "plan", "build"]) {
      expect(agents[name]).toBeDefined();
      expect(agents[name]!.mode).toBe("primary");
    }
  });

  it("has the 10 subagents with mode=subagent", () => {
    const subagents = [
      "qa-reviewer",
      "qa-thorough",
      "plan-reviewer",
      "autopilot-verifier",
      "code-searcher",
      "gap-analyzer",
      "architecture-advisor",
      "docs-maintainer",
      "lib-reader",
      "agents-md-writer",
    ];
    for (const name of subagents) {
      expect(agents[name]).toBeDefined();
      expect(agents[name]!.mode).toBe("subagent");
    }
  });

  it("every agent has a non-empty prompt", () => {
    for (const [name, cfg] of Object.entries(agents)) {
      expect(typeof cfg.prompt).toBe("string");
      expect((cfg.prompt as string).length).toBeGreaterThan(10);
    }
  });

  it("every agent has a non-empty description", () => {
    for (const [name, cfg] of Object.entries(agents)) {
      expect(typeof cfg.description).toBe("string");
      expect((cfg.description as string).length).toBeGreaterThan(0);
    }
  });

  it("orchestrator has correct model and temperature", () => {
    const orch = agents["orchestrator"]!;
    expect(orch.model).toBe("anthropic/claude-opus-4-7");
    expect(orch.temperature).toBe(0.2);
  });

  it("build has correct model and temperature", () => {
    const build = agents["build"]!;
    expect(build.model).toBe("anthropic/claude-sonnet-4-6");
    expect(build.temperature).toBe(0.1);
  });

  it("qa-reviewer model is sonnet-4-6", () => {
    expect(agents["qa-reviewer"]!.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("qa-thorough subagent is registered with opus model", () => {
    const qt = agents["qa-thorough"]!;
    expect(qt).toBeDefined();
    expect(qt.model).toBe("anthropic/claude-opus-4-7");
    expect(qt.mode).toBe("subagent");
    expect((qt.description as string).toLowerCase()).toContain("re-run");
  });

  it("no agent prompt contains dangling ~/.claude or home/.claude paths", () => {
    const FORBIDDEN = [
      "~/.claude",
      "home/.claude",
      "~/.config/opencode",
      "home/.config/opencode",
    ];
    for (const [name, cfg] of Object.entries(agents)) {
      const prompt = cfg.prompt as string;
      for (const pattern of FORBIDDEN) {
        expect(prompt).not.toContain(pattern);
      }
    }
  });

  it("user-wins precedence: user agent overrides plugin agent", () => {
    // Simulate what src/index.ts does: { ...ourAgents, ...(input.agent ?? {}) }
    const userOverride = {
      orchestrator: {
        model: "anthropic/claude-haiku-4-5",
        prompt: "custom prompt",
        mode: "primary" as const,
      },
    };
    const merged = { ...agents, ...userOverride };
    expect(merged["orchestrator"]!.model).toBe("anthropic/claude-haiku-4-5");
    expect(merged["orchestrator"]!.prompt).toBe("custom prompt");
    // Other agents unaffected
    expect(merged["plan"]).toEqual(agents["plan"]);
  });
});

describe("subagent permissions", () => {
  const agents = createAgents();

  const subagentsWithPerms = [
    "qa-reviewer",
    "qa-thorough",
    "plan-reviewer",
    "autopilot-verifier",
    "code-searcher",
    "gap-analyzer",
    "architecture-advisor",
    "lib-reader",
    "agents-md-writer",
  ];

  it("subagents with perms have a non-empty permission block", () => {
    for (const name of subagentsWithPerms) {
      const cfg = agents[name];
      expect(cfg).toBeDefined();
      expect((cfg as any).permission).toBeDefined();
      expect(typeof (cfg as any).permission).toBe("object");
    }
  });

  it("docs-maintainer has no permission override", () => {
    // Explicitly unchanged — it never had frontmatter perms, so overrides
    // pass nothing, and the AgentConfig has no permission key set.
    const cfg = agents["docs-maintainer"];
    expect(cfg).toBeDefined();
    expect((cfg as any).permission).toBeUndefined();
  });

  it("qa-reviewer bash map allows-all-then-denies-destructive", () => {
    const bash = (agents["qa-reviewer"] as any).permission.bash;
    expect(typeof bash).toBe("object");
    expect(bash["*"]).toBe("allow");
    expect(bash["git push --force*"]).toBe("deny");
    expect(bash["rm -rf /*"]).toBe("deny");
    expect(bash["sudo *"]).toBe("deny");
  });

  const READ_ONLY_GIT_COMMANDS = [
    "git log --oneline -5",
    "git merge-base HEAD main",
    "git diff --name-only 2f356893d..HEAD",
    "git diff",
    "git status",
    "git branch --show-current",
  ];

  const assertReadOnlyGitAllowed = (bash: Record<string, string>) => {
    const denyKeys = Object.entries(bash)
      .filter(([, v]) => v === "deny")
      .map(([k]) => k);
    for (const cmd of READ_ONLY_GIT_COMMANDS) {
      for (const denyKey of denyKeys) {
        // Convert glob-style to regex: "*" → ".*", escape other metachars.
        const regex = new RegExp(
          "^" +
            denyKey
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*") +
            "$",
        );
        expect(regex.test(cmd)).toBe(false);
      }
    }
  };

  it("qa-reviewer allows read-only git (log, merge-base, diff, status)", () => {
    // Regression test: the reported friction commands must hit the
    // "*": "allow" rule with no more-specific deny overriding them.
    const bash = (agents["qa-reviewer"] as any).permission.bash;
    assertReadOnlyGitAllowed(bash);
  });

  it("qa-thorough allows read-only git (log, merge-base, diff, status)", () => {
    // Same regression guarantee as qa-reviewer — both variants need
    // `git log -- <file>` for scope-creep verification.
    const bash = (agents["qa-thorough"] as any).permission.bash;
    assertReadOnlyGitAllowed(bash);
  });

  it("qa-thorough permission block matches qa-reviewer shape", () => {
    const qr = (agents["qa-reviewer"] as any).permission;
    const qt = (agents["qa-thorough"] as any).permission;
    // Flat-keyed tool perms must match
    for (const key of [
      "edit",
      "webfetch",
      "ast_grep",
      "tsc_check",
      "eslint_check",
      "todo_scan",
      "comment_check",
      "question",
      "serena",
      "memory",
      "git",
      "playwright",
      "linear",
    ]) {
      expect(qt[key]).toBe(qr[key]);
    }
    // Bash rule-map keys must match
    expect(Object.keys(qt.bash).sort()).toEqual(Object.keys(qr.bash).sort());
    for (const k of Object.keys(qr.bash)) {
      expect(qt.bash[k]).toBe(qr.bash[k]);
    }
  });

  it("autopilot-verifier permissions preserve frontmatter values", () => {
    const perm = (agents["autopilot-verifier"] as any).permission;
    expect(perm.edit).toBe("deny");
    expect(perm.webfetch).toBe("deny");
    expect(perm.question).toBe("deny");
    expect(perm.memory).toBe("deny");
    expect(perm.playwright).toBe("deny");
    expect(perm.linear).toBe("deny");
    expect(perm.serena).toBe("allow");
    expect(perm.bash["*"]).toBe("allow");
  });

  it("read-only subagents have bash: deny", () => {
    for (const name of [
      "plan-reviewer",
      "gap-analyzer",
      "code-searcher",
      "architecture-advisor",
      "lib-reader",
    ]) {
      const perm = (agents[name] as any).permission;
      expect(perm.bash).toBe("deny");
    }
  });

  it("agents-md-writer preserves bash: ask and edit: allow", () => {
    const perm = (agents["agents-md-writer"] as any).permission;
    expect(perm.bash).toBe("ask");
    expect(perm.edit).toBe("allow");
  });

  it("no subagent .md file contains a permission: frontmatter block", () => {
    // Guards against the "dead frontmatter decoration" footgun returning.
    const promptsDir = path.join(
      import.meta.dir,
      "..",
      "src",
      "agents",
      "prompts",
    );
    const files = fs
      .readdirSync(promptsDir)
      .filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const content = fs.readFileSync(path.join(promptsDir, f), "utf8");
      // Only scan frontmatter — split on the closing ---.
      if (!content.startsWith("---")) continue;
      const end = content.indexOf("\n---", 3);
      if (end === -1) continue;
      const fm = content.slice(3, end);
      expect(fm).not.toContain("permission:");
    }
  });
});

describe("prompt content assertions", () => {
  const agents = createAgents();
  const qaReviewer = agents["qa-reviewer"]!.prompt as string;
  const qaThorough = agents["qa-thorough"]!.prompt as string;
  const orchestrator = agents["orchestrator"]!.prompt as string;

  // ---- qa-reviewer (fast variant) ----

  it("qa-reviewer prompt contains trust-recent-green clause", () => {
    expect(qaReviewer).toContain("tests passed at");
    expect(qaReviewer).toContain("lint passed at");
    expect(qaReviewer).toContain("typecheck passed at");
  });

  it("qa-reviewer prompt requires git log verification for untracked-in-plan files", () => {
    expect(qaReviewer).toContain("git log --oneline -- <file>");
  });

  it("qa-reviewer prompt contains plan-drift auto-fail rule", () => {
    expect(qaReviewer.toLowerCase()).toContain("plan drift");
    expect(qaReviewer.toLowerCase()).toContain("auto-fail");
    expect(qaReviewer).toContain("## File-level changes");
  });

  it("qa-reviewer prompt retains plan-state verify step", () => {
    expect(qaReviewer).toContain("plan-check --run");
  });

  it("qa-reviewer prompt guards full-suite re-run behind trust-recent-green", () => {
    expect(qaReviewer.toLowerCase()).toMatch(
      /skip re-running|skip running|skip these|skip this step/,
    );
  });

  // ---- qa-thorough (opus variant) ----

  it("qa-thorough prompt contains strengthened scope and plan-drift rules", () => {
    expect(qaThorough).toContain("git log --oneline -- <file>");
    expect(qaThorough.toLowerCase()).toContain("plan drift");
    expect(qaThorough.toLowerCase()).toContain("auto-fail");
  });

  it("qa-thorough prompt unconditionally re-runs full suite", () => {
    expect(qaThorough.toLowerCase()).toContain("re-run");
  });

  it("qa-thorough prompt does NOT contain trust-recent-green clause", () => {
    expect(qaThorough).not.toContain("tests passed at");
    expect(qaThorough).not.toContain("trust-recent-green");
  });

  // ---- orchestrator (picker + delegation + pre-existing-failure rule) ----

  it("orchestrator prompt contains qa-fast-vs-thorough heuristic", () => {
    expect(orchestrator).toContain("@qa-thorough");
    expect(orchestrator).toContain("@qa-reviewer");
    expect(orchestrator).toMatch(/>10 files|>500 lines/);
    expect(orchestrator.toLowerCase()).toContain("risk: high");
    expect(orchestrator.toLowerCase()).toMatch(
      /auth|security|crypto|billing|migration/,
    );
  });

  it("orchestrator prompt requires session-green summary for qa-reviewer delegation", () => {
    expect(orchestrator).toContain("tests passed at");
    expect(orchestrator).toContain("lint passed at");
    expect(orchestrator).toContain("typecheck passed at");
  });

  it("orchestrator prompt requires logging pre-existing failures to plan Open questions", () => {
    expect(orchestrator).toContain("## Open questions");
    expect(orchestrator.toLowerCase()).toContain("pre-existing failure");
    expect(orchestrator.toLowerCase()).toContain(
      "not introduced by this change",
    );
  });

  it("orchestrator subagent reference lists both qa-reviewer and qa-thorough", () => {
    expect(orchestrator).toMatch(/- `@qa-reviewer`/);
    expect(orchestrator).toMatch(/- `@qa-thorough`/);
  });
});
