/**
 * Models.dev client — fetches provider/model data from the Models.dev
 * registry at https://models.dev/api.json.
 *
 * This replaced `src/cli/catwalk.ts` after a root-cause investigation
 * revealed that Catwalk's provider IDs do NOT match OpenCode's runtime
 * provider IDs (Catwalk says `"bedrock"`; OpenCode's runtime says
 * `"amazon-bedrock"`). OpenCode uses the AI SDK + Models.dev to resolve
 * `<provider_id>/<model_id>` refs at agent-invocation time, so the
 * installer must use the same source of truth to avoid generating
 * configs that crash with `configured model ... is not valid`.
 *
 * Falls back gracefully (returns null) when the API is unreachable —
 * the installer then uses its hardcoded `MODEL_PRESETS`.
 */

const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types — subset of Models.dev's schema (verified 2026-04-26 against
// https://models.dev/api.json). We only declare fields we actually use;
// extras in the response are ignored.
// ---------------------------------------------------------------------------

export interface ModelsDevModel {
  id: string;
  name: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  modalities?: { input: string[]; output: string[] };
  open_weights?: boolean;
  /** All figures in USD per 1 million tokens. */
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: { context?: number; output?: number };
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  env?: string[];
  npm?: string;
  doc?: string;
  /** Object map keyed by model ID — NOT an array. */
  models: Record<string, ModelsDevModel>;
}

/** Top-level API shape: `Record<provider_id, ModelsDevProvider>`. */
export type ModelsDevRegistry = Record<string, ModelsDevProvider>;

// ---------------------------------------------------------------------------
// Tier suggestion
// ---------------------------------------------------------------------------

export type ModelTier = "deep" | "mid" | "fast";

export interface TierSuggestion {
  /** Full model ref: `<provider_id>/<model_id>`. */
  deep: string;
  mid: string;
  fast: string;
}

/**
 * Combined cost used for sorting (input + output per 1M tokens).
 * Treats missing cost fields as 0 — cheap local/free models sort to `fast`.
 */
function combinedCost(m: ModelsDevModel): number {
  const input = m.cost?.input ?? 0;
  const output = m.cost?.output ?? 0;
  return input + output;
}

/**
 * Suggest a deep/mid/fast tier mapping for a provider based on combined
 * input+output cost per 1M tokens.
 *
 *   - deep = most expensive model
 *   - fast = cheapest model
 *   - mid  = model closest to the midpoint, excluding deep and fast
 *
 * If the provider has fewer than 3 models, duplicates are used.
 */
export function suggestTiersFromModelsDev(
  provider: ModelsDevProvider,
): TierSuggestion {
  const models = Object.values(provider.models).sort(
    (a, b) => combinedCost(b) - combinedCost(a),
  );

  if (models.length === 0) {
    throw new Error(`Provider "${provider.id}" has no models`);
  }

  const deep = models[0]!;
  const fast = models[models.length - 1]!;

  let mid: ModelsDevModel;
  if (models.length <= 2) {
    mid = models.length === 1 ? deep : fast;
  } else {
    const midCost = (combinedCost(deep) + combinedCost(fast)) / 2;
    const candidates = models.filter(
      (m) => m.id !== deep.id && m.id !== fast.id,
    );
    mid = candidates.reduce((best, m) =>
      Math.abs(combinedCost(m) - midCost) <
      Math.abs(combinedCost(best) - midCost)
        ? m
        : best,
    );
  }

  const ref = (m: ModelsDevModel) => `${provider.id}/${m.id}`;

  return {
    deep: ref(deep),
    mid: ref(mid),
    fast: ref(fast),
  };
}

/**
 * Bedrock-specialized tier picker.
 *
 * Amazon Bedrock's Models.dev entry ships both CRIS-prefixed (e.g.
 * `global.anthropic.claude-opus-4-7`) and non-prefixed (e.g.
 * `anthropic.claude-opus-4-7`) variants of the same underlying model.
 * The `global.` CRIS route has the highest availability because it
 * routes across all regions where the user's account has Bedrock
 * access — so it's the safest default.
 *
 * Algorithm:
 *   1. Partition models by family (opus, sonnet, haiku).
 *   2. Within each family, prefer the most recent `global.anthropic.*`
 *      variant. If none exists, fall back to the most recent
 *      non-prefixed `anthropic.*` variant.
 *   3. Assign families to tiers: opus→deep, sonnet→mid, haiku→fast.
 *
 * Falls through to `suggestTiersFromModelsDev` if Anthropic models are
 * absent from the Bedrock provider entry (i.e. the user has a degraded
 * Models.dev response).
 */
export function pickBedrockTierIds(
  provider: ModelsDevProvider,
): TierSuggestion {
  const models = Object.values(provider.models);

  // Pick the "most recent" model from a candidate list. Heuristic: sort
  // by `last_updated` descending (ISO dates sort lexicographically); if
  // `last_updated` is missing, fall back to model ID lexicographic order
  // which for Anthropic IDs on Bedrock approximates recency well enough.
  const mostRecent = (candidates: ModelsDevModel[]): ModelsDevModel | null => {
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => {
      const aDate = a.last_updated ?? "";
      const bDate = b.last_updated ?? "";
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return b.id.localeCompare(a.id);
    })[0]!;
  };

  const pickFamily = (familyKeyword: string): ModelsDevModel | null => {
    const globalCandidates = models.filter((m) =>
      m.id.startsWith(`global.anthropic.claude-${familyKeyword}-`),
    );
    const globalPick = mostRecent(globalCandidates);
    if (globalPick) return globalPick;

    const nonPrefixedCandidates = models.filter((m) =>
      m.id.startsWith(`anthropic.claude-${familyKeyword}-`),
    );
    return mostRecent(nonPrefixedCandidates);
  };

  const opus = pickFamily("opus");
  const sonnet = pickFamily("sonnet");
  const haiku = pickFamily("haiku");

  if (!opus || !sonnet || !haiku) {
    // Anthropic family coverage incomplete — degrade to generic tier picker.
    return suggestTiersFromModelsDev(provider);
  }

  const ref = (m: ModelsDevModel) => `${provider.id}/${m.id}`;
  return {
    deep: ref(opus),
    mid: ref(sonnet),
    fast: ref(haiku),
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the Models.dev registry and return providers as an array.
 *
 * Returns `null` on any failure (network, timeout, HTTP non-2xx, parse,
 * unexpected shape). Callers fall through to hardcoded `MODEL_PRESETS`.
 *
 * Returns an array (not the raw map) so the installer can map/filter
 * ergonomically. Provider IDs are preserved on each `ModelsDevProvider.id`.
 */
export async function fetchModelsDevProviders(): Promise<
  ModelsDevProvider[] | null
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) return null;

    const data = (await res.json()) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;

    const providers: ModelsDevProvider[] = [];
    for (const [key, rawValue] of Object.entries(
      data as Record<string, unknown>,
    )) {
      if (!rawValue || typeof rawValue !== "object") continue;
      const value = rawValue as Partial<ModelsDevProvider>;
      if (typeof value.id !== "string" || value.id !== key) continue;
      if (typeof value.name !== "string") continue;
      if (!value.models || typeof value.models !== "object") continue;
      providers.push(value as ModelsDevProvider);
    }

    if (providers.length === 0) return null;
    return providers;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
