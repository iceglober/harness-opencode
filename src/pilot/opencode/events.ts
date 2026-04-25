/**
 * Event multiplexer over opencode's SSE stream.
 *
 * `client.event.subscribe()` returns one async iterator carrying
 * EVERY event from EVERY session on the server. The pilot worker
 * needs per-session filtering (it cares about its own
 * `session.idle` / `message.updated`, not other workers' events) and
 * cancellation (timeout-on-stall).
 *
 * `EventBus` is the indirection that:
 *
 *   - Subscribes once to the SSE stream and fans events out to per-session
 *     handlers (`on(sessionId, handler)`).
 *   - Provides a `waitForIdle(sessionId, { stallMs, abortSignal })`
 *     primitive that races a `session.idle` event against a stall
 *     timeout / abort signal.
 *
 * Why one bus instead of one subscription per session: opencode emits
 * a single SSE stream per server, so multiple `event.subscribe` calls
 * would multiply server-side work for no benefit. A single iterator
 * with in-process fan-out is cheaper and stays correct across
 * concurrent sessions.
 *
 * Why we don't filter at SSE-subscription time: the SDK's `subscribe`
 * has no per-session filter parameter — it returns everything. Filter
 * client-side.
 *
 * Per spike S3, the relevant event types are:
 *   - `session.idle`: the canonical "the assistant has stopped" signal.
 *   - `message.updated` / `message.part.updated`: incremental message
 *     content (used by `stop-detect` in Phase E1).
 *   - `session.error`: failure that should fail the task (worker bails
 *     before retry).
 *
 * Ship-checklist alignment: Phase D2 of `PILOT_TODO.md`.
 */

import type { OpencodeClient } from "@opencode-ai/sdk";

// --- Public types ----------------------------------------------------------

/**
 * Minimal event shape the bus consumes. We deliberately don't import
 * the SDK's giant union of event types — every event carries a
 * `type: "<dotted.string>"` and a `properties` object whose shape is
 * type-specific. Handlers narrow at the call site.
 */
export type EventLike = {
  type: string;
  properties: Record<string, unknown>;
};

/**
 * Function callers register with `on(sessionId, handler)`. Receives
 * each event whose `properties.sessionID` matches the registered
 * session id.
 *
 * Returning a Promise is allowed; the bus does NOT await it (handlers
 * shouldn't block fan-out). Callers that need ordered async work
 * inside a handler should serialize via their own queue.
 */
export type EventHandler = (event: EventLike) => void | Promise<void>;

/**
 * Result of `waitForIdle`. Discriminated union so callers can branch
 * on the reason without inspecting an error type.
 */
export type WaitForIdleResult =
  | { kind: "idle" }
  | { kind: "stall"; stallMs: number }
  | { kind: "abort"; reason?: unknown }
  | { kind: "session-error"; properties: Record<string, unknown> };

export type WaitForIdleOptions = {
  /**
   * Stall timeout: if no events for this session arrive within
   * `stallMs`, give up. Default 5 minutes.
   */
  stallMs?: number;

  /**
   * AbortSignal to cancel the wait (e.g. the worker's overall
   * deadline). When aborted, the result is `{ kind: "abort" }`.
   */
  abortSignal?: AbortSignal;

  /**
   * If true (default), `session.error` events for the target session
   * resolve the wait with `{ kind: "session-error" }` instead of
   * waiting for a follow-up `session.idle`. The worker treats this
   * as a task failure.
   */
  errorIsFatal?: boolean;
};

// --- Bus implementation ----------------------------------------------------

type Subscriber = {
  sessionId: string;
  handler: EventHandler;
};

export class EventBus {
  private readonly subscribers: Subscriber[] = [];
  private readonly streamPromise: Promise<void>;
  private readonly aborter: AbortController;
  private closed = false;
  private fatalError: Error | null = null;

  /**
   * Construct a bus over the given client's `event.subscribe()` stream.
   * Begins consuming the stream immediately; throws asynchronously
   * (via `streamPromise`) if the subscription dies — call
   * `waitForStreamEnd` to surface that.
   */
  constructor(client: OpencodeClient) {
    this.aborter = new AbortController();
    this.streamPromise = this.runStream(client, this.aborter.signal);
  }

  /**
   * Subscribe to events for a single session. Returns an unsubscribe
   * function — the caller MUST call it to avoid leaking handlers
   * across tasks.
   *
   * Multiple handlers can subscribe to the same session (e.g.
   * `waitForIdle` registers a handler internally while the worker's
   * stop-detect registers another). Order of invocation across
   * handlers is registration order.
   */
  on(sessionId: string, handler: EventHandler): () => void {
    if (this.closed) {
      throw new Error("EventBus.on: bus is closed");
    }
    const sub = { sessionId, handler };
    this.subscribers.push(sub);
    return () => {
      const i = this.subscribers.indexOf(sub);
      if (i !== -1) this.subscribers.splice(i, 1);
    };
  }

  /**
   * Wait for `session.idle` on a specific session. Resolves with one
   * of `{ idle | stall | abort | session-error }` per the discriminator.
   *
   * Internally registers a temporary subscriber, races it against the
   * stall timer and abort signal, then unsubscribes.
   *
   * Stall timer is RESET every time an event arrives for the session
   * (any event, not just `idle`) — the test for "stalled" is "no
   * activity at all", not "no idle yet".
   */
  waitForIdle(
    sessionId: string,
    options: WaitForIdleOptions = {},
  ): Promise<WaitForIdleResult> {
    const stallMs = options.stallMs ?? 5 * 60 * 1000;
    const errorIsFatal = options.errorIsFatal ?? true;

    return new Promise<WaitForIdleResult>((resolve) => {
      let settled = false;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe = () => {};
      let removeAbortListener = () => {};

      const settle = (result: WaitForIdleResult): void => {
        if (settled) return;
        settled = true;
        if (stallTimer) clearTimeout(stallTimer);
        unsubscribe();
        removeAbortListener();
        resolve(result);
      };

      const armStallTimer = (): void => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          settle({ kind: "stall", stallMs });
        }, stallMs);
      };

      // Initial stall arm — covers the "session never sent any events"
      // case where the first event is the timeout.
      armStallTimer();

      // Subscribe.
      unsubscribe = this.on(sessionId, (event) => {
        // Re-arm stall on every event — activity counts.
        armStallTimer();
        if (event.type === "session.idle") {
          settle({ kind: "idle" });
          return;
        }
        if (errorIsFatal && event.type === "session.error") {
          settle({ kind: "session-error", properties: event.properties });
          return;
        }
        // Everything else (message.updated, message.part.updated,
        // session.status etc.): the consumer's stop-detect handler
        // (if any) will handle them; the bus just keeps the timer
        // alive.
      });

      // Wire abort signal.
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          settle({ kind: "abort", reason: options.abortSignal.reason });
          return;
        }
        const onAbort = () =>
          settle({ kind: "abort", reason: options.abortSignal!.reason });
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          options.abortSignal?.removeEventListener("abort", onAbort);
      }
    });
  }

  /**
   * Tear down the bus: stop consuming the SSE stream, drop all
   * subscribers. Idempotent. Subsequent `on` / `waitForIdle` calls
   * throw.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.aborter.abort();
    this.subscribers.length = 0;
    // Wait for the stream task to finish. Errors during the run are
    // swallowed because closing is supposed to be safe; they're
    // available via `getStreamError` for callers who want to surface
    // them.
    try {
      await this.streamPromise;
    } catch {
      // already captured in fatalError
    }
  }

  /**
   * Surface a fatal error from the SSE stream loop (e.g. server died).
   * Returns null if the loop ended normally or hasn't ended yet.
   */
  getStreamError(): Error | null {
    return this.fatalError;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Background task: consume the SSE stream, fan out to subscribers.
   * Filtering by `sessionID` happens here. We READ `properties.sessionID`
   * (the canonical name across event types per S3) and fall through
   * to all-session subscribers if the field is absent (e.g. some
   * server-wide events lack a sessionID).
   */
  private async runStream(
    client: OpencodeClient,
    signal: AbortSignal,
  ): Promise<void> {
    let result;
    try {
      result = await client.event.subscribe({ signal });
    } catch (err) {
      this.fatalError = err instanceof Error ? err : new Error(String(err));
      return;
    }

    try {
      for await (const rawEvent of result.stream) {
        if (signal.aborted) break;
        // Some events may arrive without a `properties` map. Coerce.
        const event: EventLike = isEventLike(rawEvent)
          ? rawEvent
          : { type: String((rawEvent as { type?: unknown })?.type ?? "unknown"), properties: {} };

        const sessionID =
          typeof (event.properties as { sessionID?: unknown }).sessionID === "string"
            ? ((event.properties as { sessionID: string }).sessionID)
            : null;

        // Fan out only to subscribers whose registered sessionId matches.
        // If the event has no sessionID, no subscribers match (we
        // could fan out to a "*" channel later if needed).
        if (sessionID === null) continue;

        // Snapshot the subscriber list — handlers may unsubscribe
        // during iteration.
        const matching = this.subscribers.filter(
          (s) => s.sessionId === sessionID,
        );
        for (const sub of matching) {
          try {
            // Don't await — handler ordering inside the bus is
            // synchronous-only. Async handlers handle their own queueing.
            void sub.handler(event);
          } catch {
            // Per-handler errors must NOT crash the bus.
          }
        }
      }
    } catch (err) {
      // Any non-abort error in the stream is fatal for the bus.
      if (signal.aborted) return;
      this.fatalError = err instanceof Error ? err : new Error(String(err));
    }
  }
}

// --- Helpers ---------------------------------------------------------------

function isEventLike(v: unknown): v is EventLike {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { type?: unknown; properties?: unknown };
  return typeof o.type === "string" && typeof o.properties === "object" && o.properties !== null;
}
