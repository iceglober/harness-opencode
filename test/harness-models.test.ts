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
      "pilot-planner",
      "plan",
      "plan-reviewer",
      "prime",
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
    const config = {} as any;
    const pluginOptions = {
      models: {
        deep: ["deep-model-1", "deep-model-2"],
        mid: ["mid-model-1"],
        fast: ["fast-model-1"],
      },
    };

    resolveHarnessModels(agents as any, config, pluginOptions);

    // Deep tier agents
    for (const name of [
      "prime",
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
    const config = {} as any;
    const pluginOptions = {
      models: {
        deep: ["tier-model"],
        prime: ["agent-model"],
      },
    };

    resolveHarnessModels(agents as any, config, pluginOptions);

    expect(agents["prime"]!.model).toBe("agent-model");
    // Other deep agents still get tier model
    expect(agents["plan"]!.model).toBe("tier-model");
  });

  it("single string values are normalized (not arrays)", () => {
    const agents = makeAgents();
    const pluginOptions = {
      models: { deep: "single-string-model" },
    };

    resolveHarnessModels(agents as any, {} as any, pluginOptions);

    expect(agents["prime"]!.model).toBe("single-string-model");
    expect(agents["plan"]!.model).toBe("single-string-model");
  });

  it("single string per-agent override works", () => {
    const agents = makeAgents();
    const pluginOptions = {
      models: { prime: "direct-string" },
    };

    resolveHarnessModels(agents as any, {} as any, pluginOptions);

    expect(agents["prime"]!.model).toBe("direct-string");
  });

  it("no plugin options and no legacy config: all agents keep defaults", () => {
    const agents = makeAgents();
    resolveHarnessModels(agents as any, {} as any);
    for (const name of Object.keys(agents)) {
      expect(agents[name]!.model).toBe(`default-${name}`);
    }
  });

  it("empty models in plugin options: all agents keep defaults", () => {
    const agents = makeAgents();
    resolveHarnessModels(agents as any, {} as any, { models: {} });
    for (const name of Object.keys(agents)) {
      expect(agents[name]!.model).toBe(`default-${name}`);
    }
  });

  it("legacy harness.models still works as fallback", () => {
    const agents = makeAgents();
    const config = { harness: { models: { deep: "legacy-model" } } } as any;
    resolveHarnessModels(agents as any, config);
    expect(agents["prime"]!.model).toBe("legacy-model");
  });

  it("plugin options win over legacy harness.models", () => {
    const agents = makeAgents();
    const config = { harness: { models: { deep: "legacy" } } } as any;
    resolveHarnessModels(agents as any, config, { models: { deep: "new" } });
    expect(agents["prime"]!.model).toBe("new");
  });

  it("unknown agent names in plugin options are silently ignored", () => {
    const agents = makeAgents();
    const pluginOptions = {
      models: { nonexistent: ["whatever"], "also-fake": "nope" },
    };

    expect(() => resolveHarnessModels(agents as any, {} as any, pluginOptions)).not.toThrow();
    for (const name of Object.keys(agents)) {
      expect(agents[name]!.model).toBe(`default-${name}`);
    }
  });

  it("partial tier config: only specified tiers are overridden", () => {
    const agents = makeAgents();
    const pluginOptions = { models: { deep: ["deep-override"] } };

    resolveHarnessModels(agents as any, {} as any, pluginOptions);

    // Deep agents overridden
    expect(agents["prime"]!.model).toBe("deep-override");
    // Mid agents keep defaults
    expect(agents["build"]!.model).toBe("default-build");
    // Fast agents keep defaults
    expect(agents["code-searcher"]!.model).toBe("default-code-searcher");
  });

  it("uses first element of array (v1 behavior)", () => {
    const agents = makeAgents();
    const pluginOptions = {
      models: { deep: ["primary-model", "fallback-1", "fallback-2"] },
    };

    resolveHarnessModels(agents as any, {} as any, pluginOptions);

    expect(agents["prime"]!.model).toBe("primary-model");
  });
});

describe("applyConfig — plugin options integration", () => {
  it("user-wins: agent.prime.model in config wins over tier resolution", () => {
    const config: any = {
      agent: {
        prime: {
          model: "user-direct-model",
          prompt: "user prompt",
          mode: "primary",
        },
      },
    };
    const pluginOptions = { models: { deep: ["tier-model"] } };

    applyConfig(config, pluginOptions);

    // User's direct agent override wins (applied AFTER tier resolution
    // via the user-wins spread).
    expect(config.agent.prime.model).toBe("user-direct-model");
  });

  it("tier resolution applies when no user agent override exists", () => {
    const config: any = {};
    const pluginOptions = { models: { deep: ["bedrock/claude-opus-4"] } };

    applyConfig(config, pluginOptions);

    expect(config.agent.prime.model).toBe("bedrock/claude-opus-4");
    expect(config.agent.plan.model).toBe("bedrock/claude-opus-4");
    // Mid/fast agents keep plugin defaults (no tier override specified)
    expect(config.agent.build.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("no plugin options: plugin defaults preserved through applyConfig", () => {
    const config: any = {};

    applyConfig(config);

    expect(config.agent.prime.model).toBe("anthropic/claude-opus-4-7");
    expect(config.agent.build.model).toBe("anthropic/claude-sonnet-4-6");
  });
});
