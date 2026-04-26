/**
 * Model-override validator.
 *
 * Detects model-ID forms that OpenCode's runtime will reject, warning
 * users before their next agent invocation crashes with "configured model
 * ... is not valid". The validator is a pure, offline, pattern-based
 * classifier — no network, no side effects.
 *
 * # Background
 *
 * OpenCode resolves `<provider_id>/<model_id>` refs at agent-invocation
 * time against the Models.dev registry (per
 * https://opencode.ai/docs/models/: "OpenCode uses the AI SDK and
 * Models.dev to support 75+ LLM providers"). The plugin's installer
 * previously used a different registry (Catwalk) whose provider IDs
 * did not match Models.dev's for AWS Bedrock and Google Vertex:
 *
 *   | Provider              | Catwalk ID   | Models.dev ID              |
 *   | --------------------- | ------------ | -------------------------- |
 *   | AWS Bedrock           | `bedrock`    | `amazon-bedrock`           |
 *   | Vertex AI (Claude)    | `vertexai`   | `google-vertex-anthropic`  |
 *
 * Every model ID the installer emitted with the `bedrock/` or `vertexai/`
 * prefix is broken at runtime. The validator now flags both families and
 * suggests the correct Models.dev-format replacement.
 *
 * Additionally, the original pre-PR-#100 failure mode is still detected:
 * IDs like `bedrock/claude-opus-4` (missing the `anthropic.` subpath)
 * never resolved in any registry.
 *
 * # Scope
 *
 * The validator flags ONLY confidently-broken forms. Unknown / ambiguous
 * IDs (CRIS-style `global.anthropic.*` without a provider prefix, unknown
 * provider prefixes like `openai/`, custom local IDs like `lmstudio/...`)
 * stay silent — validation is strictly additive and conservative. The
 * happy path is unaffected.
 */

/**
 * Legacy Catwalk-provider patterns — any ID starting with these prefixes
 * is broken at runtime because the provider name doesn't exist in Models.dev.
 *
 * The leading `(?:...)` groups make clear that `bedrock/` and `vertex/` /
 * `vertexai/` are INVALID as OpenCode runtime provider prefixes regardless
 * of what follows (with or without `anthropic.` subpath, with or without
 * version suffix).
 */
const CATWALK_PROVIDER_PATTERN = /^(?:bedrock|vertex|vertexai)\//;

/**
 * Pre-#100 form: `<bedrock|vertex|vertexai>/claude-<opus|sonnet|haiku>(-\d+)?`
 * with no `anthropic.` subpath. These never resolved in any registry and
 * are a strict subset of the Catwalk-provider pattern above — we keep
 * a separate pattern for targeted suggestion lookups.
 */
const LEGACY_PRE_100_PATTERN =
  /^(bedrock|vertex|vertexai)\/claude-(opus|sonnet|haiku)(-\d+)?$/;

/**
 * Map specific broken legacy IDs to their Models.dev-valid replacement.
 *
 * - Bedrock legacy IDs → `amazon-bedrock/global.anthropic.*` (CRIS global
 *   route for broadest availability; the PRIME session that authored this
 *   file also runs on a `global.anthropic.*` ID in production).
 * - Vertex legacy IDs → `google-vertex-anthropic/claude-*@default`
 *   (the `@default` variant points at whatever Vertex flags as the current
 *   default, per Models.dev's convention).
 *
 * Keys that aren't in this map but still match the broken patterns get a
 * generic "run install again" suggestion.
 */
const LEGACY_TO_MODELS_DEV: Record<string, string> = {
  // --- Pre-PR-#100 Bedrock (no subpath) ---
  "bedrock/claude-opus":
    "amazon-bedrock/global.anthropic.claude-opus-4-7",
  "bedrock/claude-opus-4":
    "amazon-bedrock/global.anthropic.claude-opus-4-7",
  "bedrock/claude-sonnet":
    "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
  "bedrock/claude-sonnet-4":
    "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
  "bedrock/claude-haiku":
    "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "bedrock/claude-haiku-4":
    "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",

  // --- Pre-Models.dev Bedrock (had subpath, but wrong provider prefix) ---
  "bedrock/anthropic.claude-opus-4-6":
    "amazon-bedrock/global.anthropic.claude-opus-4-7",
  "bedrock/anthropic.claude-opus-4-7":
    "amazon-bedrock/global.anthropic.claude-opus-4-7",
  "bedrock/anthropic.claude-sonnet-4-6":
    "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
  "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0":
    "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",

  // --- Pre-PR-#100 Vertex (no @date suffix) ---
  "vertex/claude-opus": "google-vertex-anthropic/claude-opus-4-7@default",
  "vertex/claude-opus-4": "google-vertex-anthropic/claude-opus-4-7@default",
  "vertex/claude-sonnet":
    "google-vertex-anthropic/claude-sonnet-4-6@default",
  "vertex/claude-sonnet-4":
    "google-vertex-anthropic/claude-sonnet-4-6@default",
  "vertex/claude-haiku":
    "google-vertex-anthropic/claude-haiku-4-5@20251001",
  "vertex/claude-haiku-4":
    "google-vertex-anthropic/claude-haiku-4-5@20251001",
  "vertexai/claude-opus": "google-vertex-anthropic/claude-opus-4-7@default",
  "vertexai/claude-opus-4":
    "google-vertex-anthropic/claude-opus-4-7@default",
  "vertexai/claude-sonnet":
    "google-vertex-anthropic/claude-sonnet-4-6@default",
  "vertexai/claude-sonnet-4":
    "google-vertex-anthropic/claude-sonnet-4-6@default",
  "vertexai/claude-haiku":
    "google-vertex-anthropic/claude-haiku-4-5@20251001",
  "vertexai/claude-haiku-4":
    "google-vertex-anthropic/claude-haiku-4-5@20251001",

  // --- Pre-Models.dev Vertex (had @date suffix, wrong provider prefix) ---
  "vertexai/claude-opus-4-6@20250610":
    "google-vertex-anthropic/claude-opus-4-6@default",
  "vertexai/claude-opus-4-7@20250610":
    "google-vertex-anthropic/claude-opus-4-7@default",
  "vertexai/claude-sonnet-4-6@20250725":
    "google-vertex-anthropic/claude-sonnet-4-6@default",
  "vertexai/claude-haiku-4-5@20251001":
    "google-vertex-anthropic/claude-haiku-4-5@20251001",
};

export interface ValidateModelResult {
  valid: boolean;
  reason?: string;
  suggestion?: string;
}

/**
 * Validate a single model-override ID.
 *
 * Returns `{ valid: true }` for any ID we don't confidently know to be
 * broken — including current Models.dev-canonical forms, Anthropic API
 * aliases, CRIS-prefixed IDs without a provider prefix (`global.anthropic.*`),
 * and any ID for providers we don't recognize (openai, gemini, etc.).
 *
 * Flags:
 *   - IDs starting with `bedrock/` or `vertex(ai)/` (wrong provider prefix
 *     — OpenCode uses `amazon-bedrock` / `google-vertex-anthropic`).
 *   - Pre-PR-#100 short forms without a provider subpath.
 *
 * Either match returns `{ valid: false, reason, suggestion }`.
 */
export function validateModelOverride(id: unknown): ValidateModelResult {
  // Defensive: non-string inputs aren't valid overrides at all, but
  // the resolver's type contract (string | string[]) keeps this mostly
  // theoretical. Treat as valid-passthrough so we don't accidentally
  // warn on something we can't reason about.
  if (typeof id !== "string") return { valid: true };
  if (id.length === 0) return { valid: true };

  // The Catwalk-provider check catches both the pre-#100 short form
  // AND the pre-Models.dev long form. Run it first.
  if (CATWALK_PROVIDER_PATTERN.test(id)) {
    const suggestion =
      LEGACY_TO_MODELS_DEV[id] ??
      "run `bunx @glrs-dev/harness-opencode install` to pick a current preset";

    // Distinguish pre-#100 short form (no subpath) from the longer forms
    // — the reason text guides the user to the correct mental model.
    const reason = LEGACY_PRE_100_PATTERN.test(id)
      ? `"${id}" is a pre-PR-#100 model ID format that does not resolve in OpenCode. Bedrock IDs need the \`amazon-bedrock\` provider prefix (not \`bedrock\`); Vertex Claude IDs need the \`google-vertex-anthropic\` provider prefix (not \`vertex\` / \`vertexai\`).`
      : `"${id}" uses a provider prefix (\`${id.split("/")[0]}\`) that does not exist in OpenCode's runtime. AWS Bedrock's provider ID is \`amazon-bedrock\`; Vertex Claude's is \`google-vertex-anthropic\`.`;

    return { valid: false, reason, suggestion };
  }

  return { valid: true };
}

/**
 * Format the runtime warn line for a single invalid override.
 * Exported so the resolver and doctor can share the exact wording.
 */
export function formatModelOverrideWarning(
  id: string,
  source: string,
  suggestion: string | undefined,
): string {
  const suggestionText = suggestion
    ? ` Suggested replacement: \`${suggestion}\`.`
    : "";
  return `[@glrs-dev/harness-opencode] Warning: invalid model override "${id}" (from ${source}).${suggestionText} Run \`bunx @glrs-dev/harness-opencode doctor\` for details.`;
}
