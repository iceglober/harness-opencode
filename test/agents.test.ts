import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAgents } from "../src/agents/index.js";

describe("createAgents", () => {
  const agents = createAgents();

  it("returns exactly 12 agents", () => {
    expect(Object.keys(agents).length).toBe(12);
  });

  it("has the 3 primary agents with mode=primary", () => {
    for (const name of ["orchestrator", "plan", "build"]) {
      expect(agents[name]).toBeDefined();
      expect(agents[name]!.mode).toBe("primary");
    }
  });

  it("has the 9 subagents with mode=subagent", () => {
    const subagents = [
      "qa-reviewer",
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

  it("qa-reviewer allows read-only git (log, merge-base, diff, status)", () => {
    // Regression test: the reported friction commands must hit the
    // "*": "allow" rule with no more-specific deny overriding them.
    const bash = (agents["qa-reviewer"] as any).permission.bash;
    const denyKeys = Object.entries(bash)
      .filter(([, v]) => v === "deny")
      .map(([k]) => k);

    const readOnlyCommands = [
      "git log --oneline -5",
      "git merge-base HEAD main",
      "git diff --name-only 2f356893d..HEAD",
      "git diff",
      "git status",
      "git branch --show-current",
    ];

    for (const cmd of readOnlyCommands) {
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
