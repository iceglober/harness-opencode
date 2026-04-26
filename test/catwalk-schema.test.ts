/**
 * Catwalk schema-validation tests.
 *
 * The Catwalk response flows into the user's `opencode.json` during
 * interactive install, so a malicious or malformed upstream response
 * must fail closed. `parseCatwalkResponse` returns `null` for any
 * invalid shape; the installer treats `null` as "upstream unreachable,
 * fall back to built-in presets".
 */
import { describe, it, expect } from "bun:test";
import { parseCatwalkResponse } from "../src/cli/catwalk.js";

const validModel = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  cost_per_1m_in: 3,
  cost_per_1m_out: 15,
  context_window: 200000,
  default_max_tokens: 8192,
  can_reason: false,
  supports_attachments: true,
};

const validProvider = {
  id: "anthropic",
  name: "Anthropic",
  type: "anthropic",
  default_large_model_id: "claude-opus-4-7",
  default_small_model_id: "claude-haiku-4-5-20251001",
  models: [validModel],
};

describe("parseCatwalkResponse", () => {
  it("accepts a valid response", () => {
    const result = parseCatwalkResponse([validProvider]);
    expect(result).not.toBeNull();
    expect(result![0]!.id).toBe("anthropic");
    expect(result![0]!.models[0]!.id).toBe("claude-sonnet-4-6");
  });

  it("rejects non-array responses", () => {
    expect(parseCatwalkResponse({ providers: [] })).toBeNull();
    expect(parseCatwalkResponse("not-an-array")).toBeNull();
    expect(parseCatwalkResponse(null)).toBeNull();
    expect(parseCatwalkResponse(undefined)).toBeNull();
    expect(parseCatwalkResponse(42)).toBeNull();
  });

  it("rejects an empty array", () => {
    expect(parseCatwalkResponse([])).toBeNull();
  });

  it("rejects providers with unsafe id characters", () => {
    // Shell metacharacters — could be dangerous if ever interpolated.
    const badId = { ...validProvider, id: "anthropic; rm -rf /" };
    expect(parseCatwalkResponse([badId])).toBeNull();
  });

  it("rejects providers with newlines in id", () => {
    const badId = { ...validProvider, id: "anthropic\nline" };
    expect(parseCatwalkResponse([badId])).toBeNull();
  });

  it("rejects providers with no models", () => {
    const noModels = { ...validProvider, models: [] };
    expect(parseCatwalkResponse([noModels])).toBeNull();
  });

  it("rejects models with negative cost", () => {
    const negCost = {
      ...validProvider,
      models: [{ ...validModel, cost_per_1m_in: -1 }],
    };
    expect(parseCatwalkResponse([negCost])).toBeNull();
  });

  it("rejects models with NaN cost", () => {
    const nanCost = {
      ...validProvider,
      models: [{ ...validModel, cost_per_1m_in: NaN }],
    };
    expect(parseCatwalkResponse([nanCost])).toBeNull();
  });

  it("rejects models with Infinity cost", () => {
    const infCost = {
      ...validProvider,
      models: [{ ...validModel, cost_per_1m_in: Infinity }],
    };
    expect(parseCatwalkResponse([infCost])).toBeNull();
  });

  it("rejects models with non-integer context_window", () => {
    const floatCtx = {
      ...validProvider,
      models: [{ ...validModel, context_window: 1.5 }],
    };
    expect(parseCatwalkResponse([floatCtx])).toBeNull();
  });

  it("rejects providers missing required fields", () => {
    const { name: _name, ...noName } = validProvider;
    expect(parseCatwalkResponse([noName])).toBeNull();
  });

  it("rejects models missing required fields", () => {
    const { cost_per_1m_in: _cost, ...noCost } = validModel;
    const noModelCost = { ...validProvider, models: [noCost] };
    expect(parseCatwalkResponse([noModelCost])).toBeNull();
  });

  it("rejects arrays larger than the max bound", () => {
    // 201 providers — must be rejected to prevent DoS via huge payload.
    const many = Array.from({ length: 201 }, (_, i) => ({
      ...validProvider,
      id: `p${i}`,
    }));
    expect(parseCatwalkResponse(many)).toBeNull();
  });

  it("rejects a provider with 501 models", () => {
    const bloat = {
      ...validProvider,
      models: Array.from({ length: 501 }, (_, i) => ({
        ...validModel,
        id: `m${i}`,
      })),
    };
    expect(parseCatwalkResponse([bloat])).toBeNull();
  });

  it("accepts an id with dots, dashes, underscores, and colons", () => {
    // Real catwalk ids include things like `claude-haiku-4-5-20251001-v1:0`
    // (Bedrock). This test anchors the allowed character set for future
    // reviewers.
    const okId = { ...validProvider, id: "a-b_c.d" };
    const result = parseCatwalkResponse([okId]);
    expect(result).not.toBeNull();

    const bedrockModelId = {
      ...validProvider,
      models: [{ ...validModel, id: "anthropic.claude-haiku-4-5-20251001-v1:0" }],
    };
    const bedrockResult = parseCatwalkResponse([bedrockModelId]);
    expect(bedrockResult).not.toBeNull();
  });
});
