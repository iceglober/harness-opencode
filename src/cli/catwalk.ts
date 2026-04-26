/**
 * Catwalk client — fetches provider/model data from Crush's community
 * model registry at https://catwalk.charm.land/v2/providers.
 *
 * Used by the installer to offer the full set of providers and models
 * instead of hardcoded presets. Falls back gracefully (returns null)
 * when the API is unreachable.
 */

import { z } from "zod";

const CATWALK_URL = "https://catwalk.charm.land/v2/providers";
const FETCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
//
// We validate the response because it flows into the user's `opencode.json`
// (via interactive install). A malicious or malformed upstream response
// should never produce data we write to disk. Unknown fields are tolerated
// (catwalk may add new ones); the fields we care about are constrained.

// Identifier pattern for model and provider IDs. Allows alphanumerics,
// `.`, `_`, `-`, and `:` (Bedrock uses colons like `...haiku-4-5-v1:0`).
// Explicitly rejects whitespace, shell metacharacters, and path separators
// so the id is safe to interpolate into `<provider>/<model>` refs that end
// up in `opencode.json`.
const IDENTIFIER = z.string().regex(/^[a-zA-Z0-9.:_-]{1,120}$/);

const CatwalkModelSchema = z.object({
  id: IDENTIFIER,
  name: z.string().min(1).max(200),
  cost_per_1m_in: z.number().nonnegative().finite(),
  cost_per_1m_out: z.number().nonnegative().finite(),
  context_window: z.number().int().nonnegative(),
  default_max_tokens: z.number().int().nonnegative(),
  can_reason: z.boolean(),
  supports_attachments: z.boolean(),
});

const CatwalkProviderSchema = z.object({
  id: IDENTIFIER,
  name: z.string().min(1).max(200),
  type: z.string().max(100),
  default_large_model_id: IDENTIFIER.optional(),
  default_small_model_id: IDENTIFIER.optional(),
  models: z.array(CatwalkModelSchema).min(1).max(500),
});

const CatwalkResponseSchema = z.array(CatwalkProviderSchema).min(1).max(200);

// ---------------------------------------------------------------------------
// Types (derived from schemas so types and runtime validation stay in lockstep)
// ---------------------------------------------------------------------------

export type CatwalkModel = z.infer<typeof CatwalkModelSchema>;
export type CatwalkProvider = z.infer<typeof CatwalkProviderSchema>;

/**
 * Parse and validate a raw Catwalk response (exposed for testing).
 * Returns `null` on any validation failure; the contract matches
 * `fetchProviders` — callers treat `null` as "treat upstream as
 * unreachable and fall back to built-in defaults".
 */
export function parseCatwalkResponse(raw: unknown): CatwalkProvider[] | null {
  const parsed = CatwalkResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Tier suggestion
// ---------------------------------------------------------------------------

export type ModelTier = "deep" | "mid" | "fast";

export interface TierSuggestion {
  deep: string; // full model ref: "<provider-id>/<model-id>"
  mid: string;
  fast: string;
}

/**
 * Suggest a deep/mid/fast tier mapping for a provider based on model cost.
 *
 * Heuristic:
 *   - deep  = most expensive model (highest cost_per_1m_in)
 *   - fast  = cheapest model
 *   - mid   = model closest to the midpoint cost, excluding deep and fast
 *
 * If the provider has fewer than 3 models, duplicates are used.
 */
export function suggestTiers(provider: CatwalkProvider): TierSuggestion {
  const models = [...provider.models].sort(
    (a, b) => b.cost_per_1m_in - a.cost_per_1m_in,
  );

  if (models.length === 0) {
    throw new Error(`Provider "${provider.id}" has no models`);
  }

  const deep: CatwalkModel = models[0]!;
  const fast: CatwalkModel = models[models.length - 1]!;

  let mid: CatwalkModel;
  if (models.length >= 3) {
    // Pick the model closest to the cost midpoint, excluding deep and fast.
    const interior = models.slice(1, -1);
    const mid_target = (deep.cost_per_1m_in + fast.cost_per_1m_in) / 2;
    mid = interior.reduce((best, m) =>
      Math.abs(m.cost_per_1m_in - mid_target) <
      Math.abs(best.cost_per_1m_in - mid_target)
        ? m
        : best,
    );
  } else if (models.length === 2) {
    mid = fast;
  } else {
    mid = deep;
  }

  const ref = (m: CatwalkModel) => `${provider.id}/${m.id}`;
  return {
    deep: ref(deep),
    mid: ref(mid),
    fast: ref(fast),
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch all providers from the Catwalk API and validate the response shape.
 * Returns `null` on any failure (network, timeout, non-OK response, or
 * schema-validation failure — we treat malformed responses as unreachable
 * so the installer falls back to built-in defaults).
 */
export async function fetchProviders(): Promise<CatwalkProvider[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CATWALK_URL, { signal: controller.signal });
    if (!res.ok) return null;

    const raw: unknown = await res.json();
    return parseCatwalkResponse(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
