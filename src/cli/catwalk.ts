/**
 * Catwalk client — fetches provider/model data from Crush's community
 * model registry at https://catwalk.charm.land/v2/providers.
 *
 * Used by the installer to offer the full set of providers and models
 * instead of hardcoded presets. Falls back gracefully (returns null)
 * when the API is unreachable.
 */

const CATWALK_URL = "https://catwalk.charm.land/v2/providers";
const FETCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatwalkModel {
  id: string;
  name: string;
  cost_per_1m_in: number;
  cost_per_1m_out: number;
  context_window: number;
  default_max_tokens: number;
  can_reason: boolean;
  supports_attachments: boolean;
}

export interface CatwalkProvider {
  id: string;
  name: string;
  type: string;
  default_large_model_id?: string;
  default_small_model_id?: string;
  models: CatwalkModel[];
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

  const deep = models[0]!;
  const fast = models[models.length - 1]!;

  let mid: CatwalkModel;
  if (models.length <= 2) {
    // Not enough models for a distinct mid — use the cheaper of the two,
    // or the only model if there's just one.
    mid = models.length === 1 ? deep : fast;
  } else {
    // Find the model closest to the midpoint cost.
    const midCost = (deep.cost_per_1m_in + fast.cost_per_1m_in) / 2;
    const candidates = models.filter(
      (m) => m.id !== deep.id && m.id !== fast.id,
    );
    mid = candidates.reduce((best, m) =>
      Math.abs(m.cost_per_1m_in - midCost) <
      Math.abs(best.cost_per_1m_in - midCost)
        ? m
        : best,
    );
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
 * Fetch all providers from the Catwalk API.
 * Returns `null` on any failure (network, timeout, parse).
 */
export async function fetchProviders(): Promise<CatwalkProvider[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CATWALK_URL, { signal: controller.signal });
    if (!res.ok) return null;

    const data = (await res.json()) as CatwalkProvider[];
    // Basic shape validation — must be an array with at least one provider.
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
