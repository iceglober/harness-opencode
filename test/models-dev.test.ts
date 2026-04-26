import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  suggestTiersFromModelsDev,
  pickBedrockTierIds,
  fetchModelsDevProviders,
  type ModelsDevModel,
  type ModelsDevProvider,
} from "../src/cli/models-dev.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeModel(
  id: string,
  input: number,
  output: number,
  extras: Partial<ModelsDevModel> = {},
): ModelsDevModel {
  return {
    id,
    name: id,
    cost: { input, output },
    ...extras,
  };
}

function makeProvider(
  id: string,
  models: ModelsDevModel[],
  extras: Partial<ModelsDevProvider> = {},
): ModelsDevProvider {
  return {
    id,
    name: id,
    models: Object.fromEntries(models.map((m) => [m.id, m])),
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// suggestTiersFromModelsDev
// ---------------------------------------------------------------------------

describe("suggestTiersFromModelsDev", () => {
  it("returns deep=most expensive, fast=cheapest, mid=middle", () => {
    const provider = makeProvider("anthropic", [
      makeModel("claude-opus", 15, 75),
      makeModel("claude-sonnet", 3, 15),
      makeModel("claude-haiku", 1, 5),
    ]);
    const tiers = suggestTiersFromModelsDev(provider);
    expect(tiers.deep).toBe("anthropic/claude-opus");
    expect(tiers.mid).toBe("anthropic/claude-sonnet");
    expect(tiers.fast).toBe("anthropic/claude-haiku");
  });

  it("uses `${provider.id}/${model.id}` ref format", () => {
    const provider = makeProvider("amazon-bedrock", [
      makeModel("global.anthropic.claude-opus-4-7", 5, 25),
    ]);
    const tiers = suggestTiersFromModelsDev(provider);
    expect(tiers.deep).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
  });

  it("falls back to duplicates when fewer than 3 models", () => {
    const provider = makeProvider("two", [
      makeModel("big", 10, 50),
      makeModel("small", 1, 5),
    ]);
    const tiers = suggestTiersFromModelsDev(provider);
    expect(tiers.deep).toBe("two/big");
    expect(tiers.mid).toBe("two/small");
    expect(tiers.fast).toBe("two/small");
  });

  it("treats missing cost fields as 0", () => {
    const provider = makeProvider("free", [
      { id: "paid", name: "Paid", cost: { input: 5, output: 10 } },
      { id: "freebie", name: "Freebie" }, // no cost
      { id: "midpaid", name: "Midpaid", cost: { input: 2, output: 4 } },
    ]);
    const tiers = suggestTiersFromModelsDev(provider);
    expect(tiers.deep).toBe("free/paid");
    expect(tiers.fast).toBe("free/freebie");
    expect(tiers.mid).toBe("free/midpaid");
  });

  it("throws on zero models", () => {
    const provider = makeProvider("empty", []);
    expect(() => suggestTiersFromModelsDev(provider)).toThrow(
      /has no models/,
    );
  });
});

// ---------------------------------------------------------------------------
// pickBedrockTierIds
// ---------------------------------------------------------------------------

describe("pickBedrockTierIds", () => {
  it("prefers `global.anthropic.*` variants when present", () => {
    const provider = makeProvider("amazon-bedrock", [
      makeModel("anthropic.claude-opus-4-7", 5, 25, {
        last_updated: "2026-04-16",
      }),
      makeModel("global.anthropic.claude-opus-4-7", 5, 25, {
        last_updated: "2026-04-16",
      }),
      makeModel("anthropic.claude-sonnet-4-6", 3, 15, {
        last_updated: "2026-03-01",
      }),
      makeModel("global.anthropic.claude-sonnet-4-6", 3, 15, {
        last_updated: "2026-03-01",
      }),
      makeModel("anthropic.claude-haiku-4-5-20251001-v1:0", 1, 5, {
        last_updated: "2025-10-01",
      }),
      makeModel("global.anthropic.claude-haiku-4-5-20251001-v1:0", 1, 5, {
        last_updated: "2025-10-01",
      }),
    ]);
    const tiers = pickBedrockTierIds(provider);
    expect(tiers.deep).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
    expect(tiers.mid).toBe(
      "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
    );
    expect(tiers.fast).toBe(
      "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  it("falls back to non-prefixed when global variant is missing", () => {
    // Simulate a Bedrock provider entry that only has non-prefixed Opus.
    const provider = makeProvider("amazon-bedrock", [
      makeModel("anthropic.claude-opus-4-1-20250805-v1:0", 15, 75, {
        last_updated: "2025-08-05",
      }),
      makeModel("global.anthropic.claude-sonnet-4-6", 3, 15, {
        last_updated: "2026-03-01",
      }),
      makeModel("global.anthropic.claude-haiku-4-5-20251001-v1:0", 1, 5, {
        last_updated: "2025-10-01",
      }),
    ]);
    const tiers = pickBedrockTierIds(provider);
    expect(tiers.deep).toBe(
      "amazon-bedrock/anthropic.claude-opus-4-1-20250805-v1:0",
    );
    expect(tiers.mid).toBe(
      "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
    );
    expect(tiers.fast).toBe(
      "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  it("picks most recent within a family via last_updated", () => {
    const provider = makeProvider("amazon-bedrock", [
      makeModel("global.anthropic.claude-opus-4-5-20251101-v1:0", 5, 25, {
        last_updated: "2025-11-01",
      }),
      makeModel("global.anthropic.claude-opus-4-7", 5, 25, {
        last_updated: "2026-04-16",
      }),
      makeModel("global.anthropic.claude-opus-4-6-v1", 5, 25, {
        last_updated: "2026-02-15",
      }),
      makeModel("global.anthropic.claude-sonnet-4-6", 3, 15),
      makeModel("global.anthropic.claude-haiku-4-5-20251001-v1:0", 1, 5),
    ]);
    const tiers = pickBedrockTierIds(provider);
    expect(tiers.deep).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
  });

  it("degrades to suggestTiers when Anthropic family coverage is incomplete", () => {
    // Only Opus, no Sonnet or Haiku — unusual for Bedrock but guards against
    // a degraded Models.dev response.
    const provider = makeProvider("amazon-bedrock", [
      makeModel("global.anthropic.claude-opus-4-7", 5, 25),
      makeModel("something.else.entirely", 2, 8),
    ]);
    const tiers = pickBedrockTierIds(provider);
    // suggestTiersFromModelsDev sorts by cost: opus (30) > something.else (10).
    expect(tiers.deep).toBe(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
  });
});

// ---------------------------------------------------------------------------
// fetchModelsDevProviders
// ---------------------------------------------------------------------------

describe("fetchModelsDevProviders", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset to a no-op that will be overridden per-test.
    globalThis.fetch = (() =>
      Promise.reject(new Error("no mock configured"))) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses a valid Models.dev response into an array of providers", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          anthropic: {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-opus-4-7": {
                id: "claude-opus-4-7",
                name: "Claude Opus 4.7",
                cost: { input: 5, output: 25 },
              },
            },
          },
          "amazon-bedrock": {
            id: "amazon-bedrock",
            name: "Amazon Bedrock",
            models: {
              "global.anthropic.claude-opus-4-7": {
                id: "global.anthropic.claude-opus-4-7",
                name: "Claude Opus 4.7 (Global)",
                cost: { input: 5, output: 25 },
              },
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await fetchModelsDevProviders();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    const bedrock = result!.find((p) => p.id === "amazon-bedrock");
    expect(bedrock).toBeTruthy();
    expect(
      bedrock!.models["global.anthropic.claude-opus-4-7"]?.cost?.input,
    ).toBe(5);
  });

  it("returns null on HTTP non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    const result = await fetchModelsDevProviders();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENETUNREACH");
    }) as typeof fetch;
    const result = await fetchModelsDevProviders();
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("not json at all", { status: 200 })) as typeof fetch;
    const result = await fetchModelsDevProviders();
    expect(result).toBeNull();
  });

  it("returns null when response is an array instead of an object", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: "foo" }]), {
        status: 200,
      })) as typeof fetch;
    const result = await fetchModelsDevProviders();
    expect(result).toBeNull();
  });

  it("skips malformed provider entries without failing the whole request", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          good: {
            id: "good",
            name: "Good",
            models: { a: { id: "a", name: "A" } },
          },
          "wrong-id": {
            id: "mismatch",
            name: "Wrong",
            models: {},
          },
          "missing-models": {
            id: "missing-models",
            name: "Missing",
          },
          "missing-name": {
            id: "missing-name",
            models: {},
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const result = await fetchModelsDevProviders();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0]!.id).toBe("good");
  });

  it("returns null when all providers are malformed", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          "bad-1": { id: "mismatch" },
          "bad-2": "not an object",
        }),
        { status: 200 },
      )) as typeof fetch;
    const result = await fetchModelsDevProviders();
    expect(result).toBeNull();
  });
});
