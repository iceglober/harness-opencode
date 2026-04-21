// cost-tracker — accrues running LLM spend by provider/model across sessions.
//
// Writes two files under a data directory (default ~/.glorious/opencode/):
//   - costs.jsonl : append-only event log, one JSON line per cost-changing event
//                   or finalization. Source of truth; rollup is always derivable.
//   - costs.json  : rollup snapshot (provider → model → {cost, tokens, messages}
//                   plus grand total). Refreshed in-memory on every non-zero
//                   delta; persisted via atomic rename on finalization and at
//                   most once per 5 seconds during active streaming.
//
// Env vars:
//   GLORIOUS_COST_TRACKER=0        — disable the plugin entirely
//   GLORIOUS_COST_TRACKER_DIR=<p>  — override the default data directory. Tilde
//                                    (~) is expanded via os.homedir().
//
// Design notes:
//   - `message.updated` events fire many times per streaming message; we
//     compute deltas against an in-memory `lastSeen` map and only append a
//     jsonl line when there's a non-zero delta OR on finalization. This keeps
//     the log lean.
//   - Finalization is detected via `info.time.completed != null` — the only
//     reliable signal per the OpenCode SDK. `info.error` and `info.finish`
//     are NOT used as independent triggers (they can appear transiently or
//     alongside a completion).
//   - On startup, we replay `costs.jsonl` to rebuild the in-memory rollup and
//     to restore `lastSeen` for any messages that were mid-stream when the
//     previous process exited. This prevents double-counting across restarts.
//   - jsonl appends must stay ≤ 4096 bytes (PIPE_BUF on Linux/macOS) for
//     atomic concurrent writes across sessions. Our payload is tiny
//     (numbers + short IDs), but we defensively cap each line at 2048 bytes
//     and skip + warn if a line would exceed that.
//   - All fs errors are swallowed (one stderr warning per category per
//     session) so the plugin never disrupts the host agent loop.

import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

type Tokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

const ZERO_TOKENS: Tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

type JsonlLine = {
  ts: string;
  sessionID: string;
  messageID: string;
  providerID: string;
  modelID: string;
  costDelta: number;
  tokensDelta: Tokens;
  costTotal: number;
  tokensTotal: Tokens;
  finalized: boolean;
};

type ModelBucket = { cost: number; tokens: Tokens; messages: number };
type ProviderBucket = {
  cost: number;
  tokens: Tokens;
  messages: number;
  byModel: Record<string, ModelBucket>;
};
type Rollup = {
  version: 1;
  updatedAt: string;
  grandTotal: { cost: number; tokens: Tokens; messages: number };
  byProvider: Record<string, ProviderBucket>;
};

const MAX_LINE_BYTES = 2048;
const ROLLUP_DEBOUNCE_MS = 5000;

function resolveDataDir(): string {
  const override = process.env.GLORIOUS_COST_TRACKER_DIR;
  if (override) {
    if (override.startsWith("~")) {
      return path.join(os.homedir(), override.slice(1));
    }
    return override;
  }
  return path.join(os.homedir(), ".glorious", "opencode");
}

function zeroTokens(): Tokens {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
}

function readTokens(src: unknown): Tokens {
  // Defensive: some providers may omit fields. Coerce everything to numbers.
  const s = (src ?? {}) as Partial<{
    input: number;
    output: number;
    reasoning: number;
    cache: Partial<{ read: number; write: number }>;
  }>;
  const cache = (s.cache ?? {}) as Partial<{ read: number; write: number }>;
  return {
    input: Number(s.input) || 0,
    output: Number(s.output) || 0,
    reasoning: Number(s.reasoning) || 0,
    cache: {
      read: Number(cache.read) || 0,
      write: Number(cache.write) || 0,
    },
  };
}

function subTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input - b.input,
    output: a.output - b.output,
    reasoning: a.reasoning - b.reasoning,
    cache: {
      read: a.cache.read - b.cache.read,
      write: a.cache.write - b.cache.write,
    },
  };
}

function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: {
      read: a.cache.read + b.cache.read,
      write: a.cache.write + b.cache.write,
    },
  };
}

function clampTokens(t: Tokens): Tokens {
  // Negative deltas mean a model retry reset a counter. Clamp to 0 so we
  // don't subtract from totals. We lose the delta for the reset portion of
  // the new attempt until the message finalizes, but this is acceptable —
  // finalization writes the correct `costTotal`/`tokensTotal` regardless.
  return {
    input: Math.max(0, t.input),
    output: Math.max(0, t.output),
    reasoning: Math.max(0, t.reasoning),
    cache: {
      read: Math.max(0, t.cache.read),
      write: Math.max(0, t.cache.write),
    },
  };
}

function anyNonZero(cost: number, tokens: Tokens): boolean {
  return (
    cost !== 0 ||
    tokens.input !== 0 ||
    tokens.output !== 0 ||
    tokens.reasoning !== 0 ||
    tokens.cache.read !== 0 ||
    tokens.cache.write !== 0
  );
}

function emptyRollup(): Rollup {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    grandTotal: { cost: 0, tokens: zeroTokens(), messages: 0 },
    byProvider: {},
  };
}

const plugin: Plugin = async () => {
  if (process.env.GLORIOUS_COST_TRACKER === "0") {
    return {};
  }

  const dataDir = resolveDataDir();
  const jsonlPath = path.join(dataDir, "costs.jsonl");
  const rollupPath = path.join(dataDir, "costs.json");

  // ---- in-memory state ----
  // Keyed by messageID. Holds the last-seen cumulative values so we can
  // compute deltas on each `message.updated`.
  const lastSeen = new Map<string, { cost: number; tokens: Tokens }>();

  // Per-messageID snapshot of provider/model and whether the message has
  // been counted toward the `messages` counter in the rollup. We only
  // increment `messages` once, on finalization.
  const messageMeta = new Map<
    string,
    { providerID: string; modelID: string; counted: boolean }
  >();

  const rollup: Rollup = emptyRollup();

  // ---- error-debounce flags (warn once per category per session) ----
  const warned = new Set<string>();
  function warnOnce(category: string, err: unknown) {
    if (warned.has(category)) return;
    warned.add(category);
    const msg =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    process.stderr.write(`[cost-tracker] ${category}: ${msg}\n`);
  }

  // `disabled` is set if we fail to create the data dir — subsequent writes
  // are short-circuited so we don't spam stderr.
  let disabled = false;

  async function ensureDir(): Promise<boolean> {
    if (disabled) return false;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      return true;
    } catch (err) {
      warnOnce("mkdir", err);
      disabled = true;
      return false;
    }
  }

  // ---- rollup mutation ----
  function applyToRollup(
    providerID: string,
    modelID: string,
    costDelta: number,
    tokensDelta: Tokens,
    isFinalization: boolean,
    messageID: string,
  ) {
    const prov = (rollup.byProvider[providerID] ??= {
      cost: 0,
      tokens: zeroTokens(),
      messages: 0,
      byModel: {},
    });
    const model = (prov.byModel[modelID] ??= {
      cost: 0,
      tokens: zeroTokens(),
      messages: 0,
    });

    prov.cost += costDelta;
    model.cost += costDelta;
    rollup.grandTotal.cost += costDelta;

    prov.tokens = addTokens(prov.tokens, tokensDelta);
    model.tokens = addTokens(model.tokens, tokensDelta);
    rollup.grandTotal.tokens = addTokens(rollup.grandTotal.tokens, tokensDelta);

    if (isFinalization) {
      const meta = messageMeta.get(messageID);
      if (meta && !meta.counted) {
        meta.counted = true;
        prov.messages += 1;
        model.messages += 1;
        rollup.grandTotal.messages += 1;
      }
    }

    rollup.updatedAt = new Date().toISOString();
  }

  // ---- rollup persistence (atomic rename, debounced) ----
  let lastRollupWriteAt = 0;
  let rollupWriteInFlight = false;

  async function writeRollup(force: boolean) {
    if (disabled) return;
    const now = Date.now();
    if (!force && now - lastRollupWriteAt < ROLLUP_DEBOUNCE_MS) return;
    if (rollupWriteInFlight) return;
    rollupWriteInFlight = true;
    try {
      if (!(await ensureDir())) return;
      const tmp = `${rollupPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
      try {
        await fs.writeFile(tmp, JSON.stringify(rollup, null, 2) + "\n", "utf8");
        await fs.rename(tmp, rollupPath);
        lastRollupWriteAt = now;
      } catch (err) {
        warnOnce("rollup-write", err);
        // Best-effort cleanup of the tmp file.
        try {
          await fs.unlink(tmp);
        } catch {
          /* ignore */
        }
      }
    } finally {
      rollupWriteInFlight = false;
    }
  }

  // ---- jsonl append ----
  async function appendJsonl(line: JsonlLine) {
    if (disabled) return;
    if (!(await ensureDir())) return;
    const text = JSON.stringify(line) + "\n";
    if (Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) {
      warnOnce(
        "line-too-long",
        `skipping event for ${line.messageID} — serialized size exceeds ${MAX_LINE_BYTES}B`,
      );
      return;
    }
    try {
      await fs.appendFile(jsonlPath, text, "utf8");
    } catch (err) {
      warnOnce("jsonl-append", err);
    }
  }

  // ---- startup warm-up ----
  // Replay the jsonl to rebuild (a) the rollup and (b) the lastSeen map for
  // messages that were mid-stream at last shutdown. We rebuild the rollup
  // from the LAST line of each messageID (using its `costTotal`/`tokensTotal`)
  // rather than summing deltas, which is robust to missed lines and only
  // counts finalized messages toward the `messages` counter.
  async function warmUp() {
    try {
      const raw = await fs.readFile(jsonlPath, "utf8");
      // Group lines by messageID, taking the last one we see.
      // We also need to know if it was ever finalized (for `messages` count).
      type MsgState = {
        providerID: string;
        modelID: string;
        costTotal: number;
        tokensTotal: Tokens;
        everFinalized: boolean;
        lastCostTotal: number;
        lastTokensTotal: Tokens;
      };
      const byMsg = new Map<string, MsgState>();
      for (const rawLine of raw.split("\n")) {
        if (!rawLine) continue;
        let parsed: JsonlLine;
        try {
          parsed = JSON.parse(rawLine) as JsonlLine;
        } catch {
          // Corrupt line (torn write, manual edit) — skip.
          continue;
        }
        if (!parsed.messageID) continue;
        const existing = byMsg.get(parsed.messageID);
        const tokensTotal = readTokens(parsed.tokensTotal);
        const next: MsgState = {
          providerID: parsed.providerID,
          modelID: parsed.modelID,
          costTotal: Number(parsed.costTotal) || 0,
          tokensTotal,
          everFinalized: (existing?.everFinalized ?? false) || !!parsed.finalized,
          lastCostTotal: Number(parsed.costTotal) || 0,
          lastTokensTotal: tokensTotal,
        };
        byMsg.set(parsed.messageID, next);
      }

      // Apply to rollup and restore lastSeen for in-flight messages.
      for (const [messageID, state] of byMsg) {
        const prov = (rollup.byProvider[state.providerID] ??= {
          cost: 0,
          tokens: zeroTokens(),
          messages: 0,
          byModel: {},
        });
        const model = (prov.byModel[state.modelID] ??= {
          cost: 0,
          tokens: zeroTokens(),
          messages: 0,
        });
        prov.cost += state.lastCostTotal;
        model.cost += state.lastCostTotal;
        rollup.grandTotal.cost += state.lastCostTotal;
        prov.tokens = addTokens(prov.tokens, state.lastTokensTotal);
        model.tokens = addTokens(model.tokens, state.lastTokensTotal);
        rollup.grandTotal.tokens = addTokens(
          rollup.grandTotal.tokens,
          state.lastTokensTotal,
        );
        if (state.everFinalized) {
          prov.messages += 1;
          model.messages += 1;
          rollup.grandTotal.messages += 1;
        } else {
          // Mid-stream at last shutdown — restore lastSeen so new deltas are
          // correct, and register meta so we don't double-count when this
          // eventually finalizes (counted=true because we already included
          // its cumulative totals in the rollup above; only the `messages`
          // count needs to increment on finalization, and we handle that
          // via the `counted` flag).
          lastSeen.set(messageID, {
            cost: state.lastCostTotal,
            tokens: state.lastTokensTotal,
          });
          messageMeta.set(messageID, {
            providerID: state.providerID,
            modelID: state.modelID,
            // We've already added its costs to the rollup. On finalization
            // we'll apply only any remaining delta, and `counted: false`
            // lets us bump the message counter exactly once.
            counted: false,
          });
        }
      }
      rollup.updatedAt = new Date().toISOString();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === "ENOENT") {
        // Fresh install — no prior log. Normal.
        return;
      }
      warnOnce("warmup", err);
    }
  }

  await warmUp();

  return {
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;
      const info = (event.properties as { info?: unknown }).info as
        | { role?: string; [k: string]: unknown }
        | undefined;
      if (!info || info.role !== "assistant") return;

      const assistantInfo = info as {
        id?: string;
        sessionID?: string;
        providerID?: string;
        modelID?: string;
        cost?: number;
        tokens?: unknown;
        time?: { created?: number; completed?: number | null };
      };

      const messageID = String(assistantInfo.id ?? "");
      const sessionID = String(assistantInfo.sessionID ?? "");
      const providerID = String(assistantInfo.providerID ?? "unknown");
      const modelID = String(assistantInfo.modelID ?? "unknown");
      if (!messageID) return;

      const costNow = Number(assistantInfo.cost) || 0;
      const tokensNow = readTokens(assistantInfo.tokens);
      const finalized =
        assistantInfo.time != null && assistantInfo.time.completed != null;

      // Register/update meta (but preserve `counted` across events).
      const existingMeta = messageMeta.get(messageID);
      messageMeta.set(messageID, {
        providerID,
        modelID,
        counted: existingMeta?.counted ?? false,
      });

      const prior = lastSeen.get(messageID) ?? { cost: 0, tokens: zeroTokens() };
      let costDelta = costNow - prior.cost;
      let tokensDelta = subTokens(tokensNow, prior.tokens);

      // Clamp negatives (model retry reset). Log once.
      if (
        costDelta < 0 ||
        tokensDelta.input < 0 ||
        tokensDelta.output < 0 ||
        tokensDelta.reasoning < 0 ||
        tokensDelta.cache.read < 0 ||
        tokensDelta.cache.write < 0
      ) {
        warnOnce(
          "negative-delta",
          `clamping negative delta on message ${messageID} (likely a retry/reset)`,
        );
        costDelta = Math.max(0, costDelta);
        tokensDelta = clampTokens(tokensDelta);
      }

      // Update lastSeen to current cumulative values regardless of clamping,
      // so the next delta is computed against what the provider just told us.
      lastSeen.set(messageID, { cost: costNow, tokens: tokensNow });

      const hasDelta = anyNonZero(costDelta, tokensDelta);
      if (!hasDelta && !finalized) {
        // No new content and not a final event — nothing to log.
        return;
      }

      // Apply delta to in-memory rollup.
      if (hasDelta || finalized) {
        applyToRollup(providerID, modelID, costDelta, tokensDelta, finalized, messageID);
      }

      // Append jsonl line.
      const line: JsonlLine = {
        ts: new Date().toISOString(),
        sessionID,
        messageID,
        providerID,
        modelID,
        costDelta,
        tokensDelta,
        costTotal: costNow,
        tokensTotal: tokensNow,
        finalized,
      };
      await appendJsonl(line);

      // Persist rollup — forced on finalization, debounced otherwise.
      await writeRollup(finalized);

      if (finalized) {
        lastSeen.delete(messageID);
        // Keep messageMeta around briefly in case a late duplicate event
        // fires; a subsequent unrelated message would overwrite its own key.
        // For bounded memory, clear after finalization.
        messageMeta.delete(messageID);
      }
    },
  };
};

export default plugin;
