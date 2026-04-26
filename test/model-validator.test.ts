import { describe, it, expect } from "bun:test";
import {
  validateModelOverride,
  formatModelOverrideWarning,
} from "../src/model-validator.js";

describe("validateModelOverride", () => {
  describe("valid IDs — must not flag", () => {
    const validIds = [
      // Anthropic direct API — provider ID identical in Catwalk and Models.dev
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5-20251001",
      // Anthropic API aliases (valid per Anthropic docs; map to dated form)
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-5",
      // Canonical Models.dev Bedrock IDs (correct provider prefix)
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
      "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
      "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
      "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
      "amazon-bedrock/eu.anthropic.claude-sonnet-4-6",
      "amazon-bedrock/anthropic.claude-opus-4-6-v1", // non-CRIS
      // Canonical Models.dev Vertex IDs (correct provider prefix)
      "google-vertex-anthropic/claude-opus-4-7@default",
      "google-vertex-anthropic/claude-sonnet-4-6@default",
      "google-vertex-anthropic/claude-haiku-4-5@20251001",
      // AWS CRIS (cross-region) prefix without a provider prefix — stay silent
      "global.anthropic.claude-opus-4-7",
      "us.anthropic.claude-sonnet-4-6",
      // Unknown providers we don't police
      "openai/gpt-5",
      "openai/gpt-5.4",
      "gemini/gemini-3.1-pro-preview",
      "xai/grok-4.20",
      "zai/glm-4.7",
      // Custom local providers
      "lmstudio/google/gemma-3n-e4b",
      "ollama/llama2",
    ];

    for (const id of validIds) {
      it(`accepts ${JSON.stringify(id)}`, () => {
        expect(validateModelOverride(id)).toEqual({ valid: true });
      });
    }
  });

  describe("invalid pre-#100 legacy IDs (no subpath) — must flag with Models.dev suggestion", () => {
    const cases: Array<{ id: string; suggestion: string }> = [
      {
        id: "bedrock/claude-opus-4",
        suggestion: "amazon-bedrock/global.anthropic.claude-opus-4-7",
      },
      {
        id: "bedrock/claude-sonnet-4",
        suggestion: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
      },
      {
        id: "bedrock/claude-haiku-4",
        suggestion:
          "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      // No version digit
      {
        id: "bedrock/claude-opus",
        suggestion: "amazon-bedrock/global.anthropic.claude-opus-4-7",
      },
      {
        id: "bedrock/claude-sonnet",
        suggestion: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
      },
      {
        id: "bedrock/claude-haiku",
        suggestion:
          "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      // Vertex variants — same family of mistake
      {
        id: "vertexai/claude-opus-4",
        suggestion: "google-vertex-anthropic/claude-opus-4-7@default",
      },
      {
        id: "vertex/claude-opus-4",
        suggestion: "google-vertex-anthropic/claude-opus-4-7@default",
      },
      {
        id: "vertexai/claude-sonnet",
        suggestion: "google-vertex-anthropic/claude-sonnet-4-6@default",
      },
    ];

    for (const { id, suggestion } of cases) {
      it(`flags ${JSON.stringify(id)} with correct suggestion`, () => {
        const result = validateModelOverride(id);
        expect(result.valid).toBe(false);
        expect(result.suggestion).toBe(suggestion);
        expect(result.reason).toBeTruthy();
        // Reason must mention the bad ID so it's obvious in the warn.
        expect(result.reason).toContain(id);
      });
    }
  });

  describe("invalid wrong-provider-prefix IDs — must flag with Models.dev suggestion", () => {
    // These IDs have the correct subpath shape but the wrong provider
    // prefix — bedrock/ instead of amazon-bedrock/, vertexai/ instead of
    // google-vertex-anthropic/. They were never valid at runtime.
    const cases: Array<{ id: string; suggestion: string }> = [
      {
        id: "bedrock/anthropic.claude-opus-4-6",
        suggestion: "amazon-bedrock/global.anthropic.claude-opus-4-7",
      },
      {
        id: "bedrock/anthropic.claude-opus-4-7",
        suggestion: "amazon-bedrock/global.anthropic.claude-opus-4-7",
      },
      {
        id: "bedrock/anthropic.claude-sonnet-4-6",
        suggestion: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
      },
      {
        id: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
        suggestion:
          "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      {
        id: "vertexai/claude-opus-4-6@20250610",
        suggestion: "google-vertex-anthropic/claude-opus-4-6@default",
      },
      {
        id: "vertexai/claude-sonnet-4-6@20250725",
        suggestion: "google-vertex-anthropic/claude-sonnet-4-6@default",
      },
      {
        id: "vertexai/claude-haiku-4-5@20251001",
        suggestion: "google-vertex-anthropic/claude-haiku-4-5@20251001",
      },
    ];

    for (const { id, suggestion } of cases) {
      it(`flags ${JSON.stringify(id)} with correct suggestion`, () => {
        const result = validateModelOverride(id);
        expect(result.valid).toBe(false);
        expect(result.suggestion).toBe(suggestion);
        expect(result.reason).toBeTruthy();
        expect(result.reason).toContain(id);
      });
    }
  });

  describe("invalid IDs without a specific mapping — must flag with generic suggestion", () => {
    // The validator flags any `bedrock/...` or `vertex(ai)/...` ID even
    // when we don't have a canonical replacement mapping. Users get a
    // generic "run install again" hint.
    const cases = [
      "bedrock/something-unknown",
      "bedrock/anthropic.some-future-model-v2",
      "vertexai/claude-something-new@20260601",
    ];

    for (const id of cases) {
      it(`flags ${JSON.stringify(id)} with generic suggestion`, () => {
        const result = validateModelOverride(id);
        expect(result.valid).toBe(false);
        expect(result.suggestion).toContain(
          "bunx @glrs-dev/harness-opencode install",
        );
        expect(result.reason).toContain(id);
      });
    }
  });

  describe("edge cases — must not crash", () => {
    it("empty string → valid (no override effectively)", () => {
      expect(validateModelOverride("")).toEqual({ valid: true });
    });

    it("non-string (number) → valid (defensive passthrough)", () => {
      expect(validateModelOverride(42 as unknown as string)).toEqual({
        valid: true,
      });
    });

    it("non-string (undefined) → valid (defensive passthrough)", () => {
      expect(validateModelOverride(undefined as unknown as string)).toEqual({
        valid: true,
      });
    });

    it("non-string (null) → valid (defensive passthrough)", () => {
      expect(validateModelOverride(null as unknown as string)).toEqual({
        valid: true,
      });
    });
  });
});

describe("formatModelOverrideWarning", () => {
  it("includes the bad ID, the source key, and the suggestion", () => {
    const out = formatModelOverrideWarning(
      "bedrock/claude-opus-4",
      "models.deep",
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
    expect(out).toContain("bedrock/claude-opus-4");
    expect(out).toContain("models.deep");
    expect(out).toContain(
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    );
    expect(out).toContain("bunx @glrs-dev/harness-opencode doctor");
    expect(out).toContain("@glrs-dev/harness-opencode");
  });

  it("handles missing suggestion gracefully", () => {
    const out = formatModelOverrideWarning(
      "something-weird/model",
      "models.deep",
      undefined,
    );
    expect(out).toContain("something-weird/model");
    expect(out).not.toContain("Suggested replacement");
  });
});
