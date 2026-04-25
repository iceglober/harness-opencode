import { describe, it, expect } from "bun:test";
import { createAgents, AGENT_TIERS } from "../src/agents/index.js";
import { resolveHarnessModels, applyConfig } from "../src/config-hook.js";

describe("AGENT_TIERS", () => {
  it("covers every agent returned by createAgents()", () => {
    const agentNames = new Set(Object.keys(createAgents()));
    const tierNames = new Set(Object.keys(AGENT_TIERS));
    expect(tierNames).toEqual(agentNames);
  });

  it("every value is a valid tier", () => {
    const validTiers = new Set(["deep", "mid", "fast"]);
    for (const [name, tier] of Object.entries(AGENT_TIERS)) {
      expect(validTiers.has(tier)).toBe(true);
    }
  });

  it("tier assignments match expected groupings", () => {
    const deep = Object.entries(AGENT_TIERS)
      .filter(([, t]) => t === "deep")
      .map(([n]) => n)
      .sort();
    const mid = Object.entries(AGENT_TIERS)
      .filter(([, t]) => t === "mid")
      .map(([n]) => n)
      .sort();
    const fast = Object.entries(AGENT_TIERS)
      .filter(([, t]) => t === "fast")
      .map(([n]) => n)
      .sort();

    expect(deep).toEqual([
      "architecture-advisor",
      "gap-analyzer",
      "orchestrator",
      "pilot-planner",
      "plan",
      "plan-reviewer",
      "qa-thorough",
    ]);
    expect(mid).toEqual([
      "agents-md-writer",
      "build",
      "docs-maintainer",
      "lib-reader",
      "pilot-builder",
      "qa-reviewer",
    ]);
    expect(fast).toEqual(["code-searcher"]);
  });
});

describe("resolveHarnessModels", () => {
  /** Helper: build a minimal agents map with known defaults. */
  function makeAgents(): Record<string, { model?: string }> {
    const agents: Record<string, { model?: string }> = {};
    for (const name of Object.keys(createAgents())) {
      agents[name] = { model: `default-${name}` };
    }
    return agents;
  }

  it("tier resolution: deep/mid/fast arrays set correct models", () => {
    const agents = makeAgents();
    const config = {
      harness: {
        models: {
          deep: ["deep-model-1", "deep-model-2"],
          mid: ["mid-model-1"],
          fast: ["fast-model-1"],
        },
      },
    } as any;

    resolveHarnessModels(agents as any, config);

    // Deep tier agents
    for (const name of [
      "orchestrator",
      "plan",
      "qa-thorough",
      "architecture-advisor",
      "plan-reviewer",
      "gap-analyzer",
    ]) {
      expect(agents[name]!.model).toBe("deep-model-1");
    }

    // Mid tier agents
    for (const name of [
      "build",
      "qa-reviewer",
      "docs-maintainer",
      "lib-reader",
      "agents-md-writer",
    ]) {
      expect(agents[name]!.model).toBe("mid-model-1");
    }

    // Fast tier agents
    expect(agents["code-searcher"]!.model).toBe("fast-model-1");
  });

  it("per-agent override wins over tier", () => {
    const agents = makeAgents();
    const config = {
      harness: {
        models: {
          deep: ["tier-model"],
          orchestrator: ["agent-model"],
        },
      },
    } as any;

    resolveHarnessModels(agents as any, config);

    expect(agents["orchestrator"]!.model).toBe("agent-model");
    // Other deep agents still get tier model
    expect(agents["plan"]!.model).toBe("tier-model");
  });

  it("single string values are normalized (not arrays)", () => {
    const agents = makeAgents();
    const config = {
      harness: {
        models: {
          deep: "single-string-model",
        },
      },
    } as any;

    resolveHarnessModels(agents as any, config);

    expect(agents["orchestrator"]!.model).toBe("single-string-model");
    expect(agents["plan"]!.model).toBe("single-string-model");
  });

  it("single string per-agent override works", () => {
    const agents = makeAgents();
    const config = {
      harness: {
        models: {
          orchestrator: "direct-string",
        },
      },
    } as any;

    resolveHarnessModels(agents as any, config);

    expect(agents["orchestrator"]!.model).toBe("direct-string");
  });

  it("no harness config: all agents keep defaults", () => {
    const agents = makeAgents();
    const config = {} as any;

    resolveHarnessModels(agents as any, config);

    for (const name of Object.keys(agents)) {
      expect(agents[name]!.model).toBe(`default-${name}`);
    }
  });

  it("empty harness.models: all agents keep defaults", () => {
    const agents = makeAgents();
    const config = { harness: { models: {} } } as any;

    resolveHarnessModels(agents as any, config);

    for (const name of Object.keys(agents)) {
      expect(agents[name]!.model).toBe(`default-${name}`);
    }
  });

  it("unknown agent names in harness.models are silently ignored", () => {
    const agents = makeAgents();
    const config = {
      harness: {
        models: {
          nonexistent: ["whatever"],
          "also-fake": "nope",
        },
      },
    } as any;

    // Should not throw
    expect(() => resolveHarnessModels(agents as any, config)).not.toThrow();

    // All agents unchanged
    for (const name of Object.keys(agents)) {
      expect(agents[name]!.model).toBe(`default-${name}`);
    }
  });

  it("partial tier config: only specified tiers are overridden", () => {
    const agents = makeAgents();
    const config = {
      harness: {
        models: {
          deep: ["deep-override"],
          // mid and fast not specified
        },
      },
    } as any;

    resolveHarnessModels(agents as any, config);

    // Deep agents overridden
    expect(agents["orchestrator"]!.model).toBe("deep-override");
    // Mid agents keep defaults
    expect(agents["build"]!.model).toBe("default-build");
    // Fast agents keep defaults
    expect(agents["code-searcher"]!.model).toBe("default-code-searcher");
  });

  it("uses first element of array (v1 behavior)", () => {
    const agents = makeAgents();
    const config = {
      harness: {
        models: {
          deep: ["primary-model", "fallback-1", "fallback-2"],
        },
      },
    } as any;

    resolveHarnessModels(agents as any, config);

    expect(agents["orchestrator"]!.model).toBe("primary-model");
  });
});

describe("applyConfig — harness.models integration", () => {
  it("user-wins: agent.orchestrator.model in config wins over tier resolution", () => {
    const config: any = {
      harness: {
        models: {
          deep: ["tier-model"],
        },
      },
      agent: {
        orchestrator: {
          model: "user-direct-model",
          prompt: "user prompt",
          mode: "primary",
        },
      },
    };

    applyConfig(config);

    // User's direct agent override wins (applied AFTER tier resolution
    // via the user-wins spread).
    expect(config.agent.orchestrator.model).toBe("user-direct-model");
  });

  it("tier resolution applies when no user agent override exists", () => {
    const config: any = {
      harness: {
        models: {
          deep: ["bedrock/claude-opus-4"],
        },
      },
    };

    applyConfig(config);

    expect(config.agent.orchestrator.model).toBe("bedrock/claude-opus-4");
    expect(config.agent.plan.model).toBe("bedrock/claude-opus-4");
    // Mid/fast agents keep plugin defaults (no tier override specified)
    expect(config.agent.build.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("no harness config: plugin defaults preserved through applyConfig", () => {
    const config: any = {};

    applyConfig(config);

    expect(config.agent.orchestrator.model).toBe("anthropic/claude-opus-4-7");
    expect(config.agent.build.model).toBe("anthropic/claude-sonnet-4-6");
  });
});
