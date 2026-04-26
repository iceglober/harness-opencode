import { describe, it, expect } from "bun:test";
import {
  validateModelOverride,
  formatModelOverrideWarning,
} from "../src/model-validator.js";

describe("validateModelOverride", () => {
  describe("valid IDs — must not flag", () => {
    const validIds = [
      // Current Catwalk Anthropic (what the plugin ships)
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5-20251001",
      // Anthropic API aliases (valid per Anthropic docs; map to dated form)
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-5",
      // Canonical Bedrock IDs (include the `anthropic.` subpath)
      "bedrock/anthropic.claude-opus-4-6",
      "bedrock/anthropic.claude-opus-4-7",
      "bedrock/anthropic.claude-sonnet-4-6",
      "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
      // Canonical Vertex IDs (include @YYYYMMDD)
      "vertexai/claude-opus-4-6@20250610",
      "vertexai/claude-opus-4-7@20250610",
      "vertexai/claude-sonnet-4-6@20250725",
      "vertexai/claude-haiku-4-5@20251001",
      // AWS CRIS (cross-region) prefix — provider not in path; stay silent
      "global.anthropic.claude-opus-4-7",
      "us.anthropic.claude-sonnet-4-6",
      // Unknown providers we don't police
      "openai/gpt-5",
      "openai/gpt-5.4",
      "gemini/gemini-3.1-pro-preview",
      "xai/grok-4.20",
      "zai/glm-4.7",
      // Short-form Catwalk-ish IDs that don't match the bad pattern
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
    ];

    for (const id of validIds) {
      it(`accepts ${JSON.stringify(id)}`, () => {
        expect(validateModelOverride(id)).toEqual({ valid: true });
      });
    }
  });

  describe("invalid pre-#100 legacy IDs — must flag with suggestion", () => {
    const cases: Array<{ id: string; suggestion: string }> = [
      {
        id: "bedrock/claude-opus-4",
        suggestion: "bedrock/anthropic.claude-opus-4-6",
      },
      {
        id: "bedrock/claude-sonnet-4",
        suggestion: "bedrock/anthropic.claude-sonnet-4-6",
      },
      {
        id: "bedrock/claude-haiku-4",
        suggestion: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      // No version digit
      {
        id: "bedrock/claude-opus",
        suggestion: "bedrock/anthropic.claude-opus-4-6",
      },
      {
        id: "bedrock/claude-sonnet",
        suggestion: "bedrock/anthropic.claude-sonnet-4-6",
      },
      {
        id: "bedrock/claude-haiku",
        suggestion: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      // Vertex variants — same family of mistake
      {
        id: "vertexai/claude-opus-4",
        suggestion: "vertexai/claude-opus-4-6@20250610",
      },
      {
        id: "vertex/claude-opus-4",
        suggestion: "vertexai/claude-opus-4-6@20250610",
      },
      {
        id: "vertexai/claude-sonnet",
        suggestion: "vertexai/claude-sonnet-4-6@20250725",
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
      "bedrock/anthropic.claude-opus-4-6",
    );
    expect(out).toContain("bedrock/claude-opus-4");
    expect(out).toContain("models.deep");
    expect(out).toContain("bedrock/anthropic.claude-opus-4-6");
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
