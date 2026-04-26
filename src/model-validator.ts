/**
 * Model-override validator.
 *
 * Detects pre-#100 legacy model-override IDs that silently stomp the
 * plugin's Catwalk-canonical defaults via `resolveHarnessModels()`.
 *
 * Background: before PR #100, the installer suggested model IDs like
 * `bedrock/claude-opus-4` (missing the `anthropic.` subpath and the
 * minor-version digit). These IDs don't resolve in OpenCode — there's
 * no provider/model matching them — so when a pre-#100 user runs the
 * plugin after updating, every agent whose tier or name is covered by
 * their stale `options.models` block gets its `.model` field overwritten
 * with an unresolvable ID. The first subagent to be invoked (typically
 * `pilot-planner` or `qa-reviewer`) crashes with `ProviderModelNotFoundError`.
 *
 * This validator is a pure, offline, pattern-based classifier. It flags
 * ONLY confidently-broken forms. Unknown / unrecognized / CRIS-style IDs
 * stay silent — validation is strictly additive and conservative.
 */

/**
 * The legacy pattern: `<bedrock|vertex|vertexai>/claude-<opus|sonnet|haiku>`
 * optionally followed by `-<digit>` (e.g. `-4`), with NO provider-specific
 * suffix (no `anthropic.` prefix, no `@YYYYMMDD` vertex suffix, no
 * `-YYYYMMDD-v1:0` bedrock suffix). This is what pre-#100 installs wrote
 * to `options.models.{deep,mid,fast}`.
 */
const LEGACY_PRE_100_PATTERN =
  /^(bedrock|vertex|vertexai)\/claude-(opus|sonnet|haiku)(-\d+)?$/;

/**
 * Map each legacy form to the Catwalk-canonical replacement. The values
 * mirror `MODEL_PRESETS` in `src/cli/install.ts` so the suggestion the
 * user sees in their terminal matches exactly what they'd get from a
 * fresh `bunx install`.
 *
 * We duplicate the mapping here (instead of importing from the CLI module)
 * to keep this validator free of any dependency on `src/cli/*` — the
 * runtime plugin and the CLI can evolve independently, and this file is
 * safe to import from both.
 */
const LEGACY_TO_CATWALK: Record<string, string> = {
  // Bedrock — no `anthropic.` subpath → canonical form
  "bedrock/claude-opus": "bedrock/anthropic.claude-opus-4-6",
  "bedrock/claude-opus-4": "bedrock/anthropic.claude-opus-4-6",
  "bedrock/claude-sonnet": "bedrock/anthropic.claude-sonnet-4-6",
  "bedrock/claude-sonnet-4": "bedrock/anthropic.claude-sonnet-4-6",
  "bedrock/claude-haiku": "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
  "bedrock/claude-haiku-4": "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
  // Vertex — missing `@YYYYMMDD` suffix (and for `vertex/` the wrong provider prefix)
  "vertex/claude-opus": "vertexai/claude-opus-4-6@20250610",
  "vertex/claude-opus-4": "vertexai/claude-opus-4-6@20250610",
  "vertex/claude-sonnet": "vertexai/claude-sonnet-4-6@20250725",
  "vertex/claude-sonnet-4": "vertexai/claude-sonnet-4-6@20250725",
  "vertex/claude-haiku": "vertexai/claude-haiku-4-5@20251001",
  "vertex/claude-haiku-4": "vertexai/claude-haiku-4-5@20251001",
  "vertexai/claude-opus": "vertexai/claude-opus-4-6@20250610",
  "vertexai/claude-opus-4": "vertexai/claude-opus-4-6@20250610",
  "vertexai/claude-sonnet": "vertexai/claude-sonnet-4-6@20250725",
  "vertexai/claude-sonnet-4": "vertexai/claude-sonnet-4-6@20250725",
  "vertexai/claude-haiku": "vertexai/claude-haiku-4-5@20251001",
  "vertexai/claude-haiku-4": "vertexai/claude-haiku-4-5@20251001",
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
 * broken — including current Catwalk forms, Anthropic API aliases, AWS
 * CRIS-prefixed IDs (`global.anthropic.*`), and any ID for providers we
 * don't recognize (openai, gemini, etc.). This is deliberately conservative:
 * the validator's job is to catch the specific pre-#100 failure mode, not
 * to police every user's model choice.
 */
export function validateModelOverride(id: unknown): ValidateModelResult {
  // Defensive: non-string inputs aren't valid overrides at all, but
  // the resolver's type contract (string | string[]) keeps this mostly
  // theoretical. Treat as valid-passthrough so we don't accidentally
  // warn on something we can't reason about.
  if (typeof id !== "string") return { valid: true };
  if (id.length === 0) return { valid: true };

  if (LEGACY_PRE_100_PATTERN.test(id)) {
    const suggestion =
      LEGACY_TO_CATWALK[id] ??
      "run `bunx @glrs-dev/harness-opencode install` to pick a current preset";
    return {
      valid: false,
      reason: `"${id}" is a pre-PR-#100 model ID format that does not resolve in OpenCode. Bedrock IDs need an \`anthropic.\` subpath and a minor-version digit; Vertex IDs need an \`@YYYYMMDD\` date suffix.`,
      suggestion,
    };
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
