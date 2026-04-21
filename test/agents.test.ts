import { describe, it, expect } from "bun:test";
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
