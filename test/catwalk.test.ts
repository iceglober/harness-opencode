import { describe, it, expect } from "bun:test";
import { suggestTiers, type CatwalkProvider } from "../src/cli/catwalk.js";

describe("suggestTiers", () => {
  it("picks deep=most expensive, fast=cheapest, mid=midpoint", () => {
    const provider: CatwalkProvider = {
      id: "test",
      name: "Test",
      type: "test",
      models: [
        { id: "cheap", name: "Cheap", cost_per_1m_in: 1, cost_per_1m_out: 5, context_window: 200000, default_max_tokens: 8192, can_reason: false, supports_attachments: false },
        { id: "mid", name: "Mid", cost_per_1m_in: 5, cost_per_1m_out: 15, context_window: 200000, default_max_tokens: 16384, can_reason: true, supports_attachments: true },
        { id: "expensive", name: "Expensive", cost_per_1m_in: 15, cost_per_1m_out: 75, context_window: 200000, default_max_tokens: 32000, can_reason: true, supports_attachments: true },
      ],
    };

    const tiers = suggestTiers(provider);
    expect(tiers.deep).toBe("test/expensive");
    expect(tiers.mid).toBe("test/mid");
    expect(tiers.fast).toBe("test/cheap");
  });

  it("handles provider with exactly 2 models", () => {
    const provider: CatwalkProvider = {
      id: "duo",
      name: "Duo",
      type: "test",
      models: [
        { id: "big", name: "Big", cost_per_1m_in: 10, cost_per_1m_out: 50, context_window: 200000, default_max_tokens: 32000, can_reason: true, supports_attachments: true },
        { id: "small", name: "Small", cost_per_1m_in: 1, cost_per_1m_out: 5, context_window: 200000, default_max_tokens: 8192, can_reason: false, supports_attachments: false },
      ],
    };

    const tiers = suggestTiers(provider);
    expect(tiers.deep).toBe("duo/big");
    expect(tiers.mid).toBe("duo/small");
    expect(tiers.fast).toBe("duo/small");
  });

  it("handles provider with exactly 1 model", () => {
    const provider: CatwalkProvider = {
      id: "solo",
      name: "Solo",
      type: "test",
      models: [
        { id: "only", name: "Only", cost_per_1m_in: 5, cost_per_1m_out: 15, context_window: 200000, default_max_tokens: 16384, can_reason: true, supports_attachments: true },
      ],
    };

    const tiers = suggestTiers(provider);
    expect(tiers.deep).toBe("solo/only");
    expect(tiers.mid).toBe("solo/only");
    expect(tiers.fast).toBe("solo/only");
  });

  it("throws for provider with no models", () => {
    const provider: CatwalkProvider = {
      id: "empty",
      name: "Empty",
      type: "test",
      models: [],
    };

    expect(() => suggestTiers(provider)).toThrow('Provider "empty" has no models');
  });

  it("picks correct mid when costs are unevenly distributed", () => {
    const provider: CatwalkProvider = {
      id: "skewed",
      name: "Skewed",
      type: "test",
      models: [
        { id: "a", name: "A", cost_per_1m_in: 100, cost_per_1m_out: 500, context_window: 200000, default_max_tokens: 32000, can_reason: true, supports_attachments: true },
        { id: "b", name: "B", cost_per_1m_in: 3, cost_per_1m_out: 15, context_window: 200000, default_max_tokens: 16384, can_reason: true, supports_attachments: true },
        { id: "c", name: "C", cost_per_1m_in: 1, cost_per_1m_out: 5, context_window: 200000, default_max_tokens: 8192, can_reason: false, supports_attachments: false },
        { id: "d", name: "D", cost_per_1m_in: 45, cost_per_1m_out: 200, context_window: 200000, default_max_tokens: 32000, can_reason: true, supports_attachments: true },
      ],
    };

    const tiers = suggestTiers(provider);
    expect(tiers.deep).toBe("skewed/a");
    expect(tiers.fast).toBe("skewed/c");
    // Midpoint cost = (100 + 1) / 2 = 50.5. Closest candidate: d (45)
    expect(tiers.mid).toBe("skewed/d");
  });

  it("produces correct refs for real Anthropic provider shape", () => {
    const provider: CatwalkProvider = {
      id: "anthropic",
      name: "Anthropic",
      type: "anthropic",
      models: [
        { id: "claude-opus-4-7", name: "Claude Opus 4.7", cost_per_1m_in: 5, cost_per_1m_out: 25, context_window: 1000000, default_max_tokens: 126000, can_reason: true, supports_attachments: true },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", cost_per_1m_in: 3, cost_per_1m_out: 15, context_window: 1000000, default_max_tokens: 64000, can_reason: true, supports_attachments: true },
        { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku", cost_per_1m_in: 1, cost_per_1m_out: 5, context_window: 200000, default_max_tokens: 64000, can_reason: true, supports_attachments: true },
      ],
    };

    const tiers = suggestTiers(provider);
    expect(tiers.deep).toBe("anthropic/claude-opus-4-7");
    expect(tiers.mid).toBe("anthropic/claude-sonnet-4-6");
    expect(tiers.fast).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("produces correct refs for real Bedrock provider shape", () => {
    const provider: CatwalkProvider = {
      id: "bedrock",
      name: "AWS Bedrock",
      type: "bedrock",
      models: [
        { id: "anthropic.claude-opus-4-6", name: "AWS Claude Opus 4.6", cost_per_1m_in: 15, cost_per_1m_out: 75, context_window: 200000, default_max_tokens: 32000, can_reason: true, supports_attachments: true },
        { id: "anthropic.claude-sonnet-4-6", name: "AWS Claude Sonnet 4.6", cost_per_1m_in: 3, cost_per_1m_out: 15, context_window: 200000, default_max_tokens: 16384, can_reason: true, supports_attachments: true },
        { id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "AWS Claude 4.5 Haiku", cost_per_1m_in: 0.8, cost_per_1m_out: 4, context_window: 200000, default_max_tokens: 16384, can_reason: false, supports_attachments: true },
      ],
    };

    const tiers = suggestTiers(provider);
    expect(tiers.deep).toBe("bedrock/anthropic.claude-opus-4-6");
    expect(tiers.mid).toBe("bedrock/anthropic.claude-sonnet-4-6");
    expect(tiers.fast).toBe("bedrock/anthropic.claude-haiku-4-5-20251001-v1:0");
  });
});
