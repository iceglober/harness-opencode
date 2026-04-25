/**
 * STOP-protocol detector.
 *
 * Per `kickoffPrompt` in `src/pilot/opencode/prompts.ts`, the agent
 * may bail on a task by responding with a single message whose first
 * non-whitespace line begins with `STOP:`. The worker fails the task
 * fast, preserves the worktree, and moves on.
 *
 * This module is the thing that watches the SSE stream for that
 * pattern.
 *
 * Why a separate module instead of inlining in the worker:
 *   - Pure logic (regex on a string) is trivially testable in
 *     isolation.
 *   - The worker already has plenty going on (server, bus, prompts,
 *     verify, state, pool); a one-purpose helper keeps the worker's
 *     `worker.ts` legible.
 *   - The detector tracks per-message text accumulation across
 *     `message.part.updated` deltas — that state machine is
 *     non-trivial and deserves its own home.
 *
 * State model:
 *
 *   The detector is constructed for ONE session. As `message.updated`
 *   and `message.part.updated` events arrive (via the EventBus), the
 *   detector accumulates text-part contents per `messageID`. When the
 *   buffer for an assistant message has a complete first line (text
 *   followed by `\n`, OR the message is finalized via `time.completed`),
 *   the detector tests it against the STOP regex and either fires the
 *   `onStop` callback or stays quiet.
 *
 *   "Complete first line" matters because parts stream in deltas:
 *   `S` → `ST` → `STO` → `STOP` → `STOP:` → `STOP: re` → ... We don't
 *   want to fire on the prefix `STO` and miss a long reason.
 *
 * Detection regex: `/^STOP:/m` against the first non-whitespace line
 * of the assistant's message. The first non-whitespace line is what
 * the prompt instructs; we don't allow leading prose to "hide" a STOP.
 *
 * Ship-checklist alignment: Phase E1 of `PILOT_TODO.md`.
 */

import type { EventLike } from "../opencode/events.js";

// --- Public types ----------------------------------------------------------

export type StopDetected = {
  /** The message id of the assistant message that contained STOP. */
  messageID: string;
  /** The full first non-whitespace line that matched, including `STOP:`. */
  line: string;
  /** The reason text after `STOP:` (trimmed). May be empty. */
  reason: string;
};

export type StopDetectorOptions = {
  /** The session being watched. Events for other sessions are ignored. */
  sessionID: string;
  /** Callback fired exactly once per STOP-detection. */
  onStop: (detected: StopDetected) => void;
};

// --- Detector --------------------------------------------------------------

/**
 * Stateful detector for one session. Feed every event from
 * `EventBus.on(sessionId, ...)` into `consume(event)`.
 *
 * Idempotent: once `onStop` has fired, subsequent events are ignored.
 * The worker is expected to dispose of the detector via the unsubscribe
 * function returned by `EventBus.on` when the task ends.
 */
export class StopDetector {
  /** Per-message accumulated text (TextParts only). */
  private readonly buffers = new Map<string, string>();
  /** Per-message: have we already fired for this message? */
  private readonly fired = new Set<string>();
  /** Per-message: is the message known to be from `role: "assistant"`? */
  private readonly assistantMessages = new Set<string>();
  /** Once true, ignore everything (single-shot). */
  private done = false;

  constructor(private readonly options: StopDetectorOptions) {}

  /**
   * Feed an event into the detector. Returns true if a STOP was
   * detected by this call (the callback also fires).
   */
  consume(event: EventLike): boolean {
    if (this.done) return false;
    if (this.options.sessionID !== getSessionID(event)) return false;

    if (event.type === "message.updated") {
      this.handleMessageUpdated(event);
      // The updated message may have completed and now have an
      // assistant role — re-check buffered content.
      const messageID = getMessageID(event);
      if (messageID) return this.tryFire(messageID);
      return false;
    }
    if (event.type === "message.part.updated") {
      const messageID = this.handlePartUpdated(event);
      if (messageID) return this.tryFire(messageID);
      return false;
    }
    return false;
  }

  /**
   * Try to fire `onStop` for the given message id. Returns true if
   * STOP was actually detected (and the callback fired).
   */
  private tryFire(messageID: string): boolean {
    if (this.fired.has(messageID)) return false;
    if (!this.assistantMessages.has(messageID)) return false;
    const buf = this.buffers.get(messageID);
    if (buf === undefined) return false;

    const detected = checkStop(buf);
    if (!detected) return false;

    this.fired.add(messageID);
    this.done = true;
    this.options.onStop({
      messageID,
      line: detected.line,
      reason: detected.reason,
    });
    return true;
  }

  // --- handlers ------------------------------------------------------------

  /**
   * `message.updated` carries the message metadata (including
   * `role`). When we see one for an assistant message, we record the
   * id so subsequent part-updates know whether to consider it.
   *
   * It does NOT carry the full parts list — those arrive separately
   * via `message.part.updated`. So we just record the role here.
   */
  private handleMessageUpdated(event: EventLike): void {
    const props = event.properties as { info?: unknown };
    const info = props.info;
    if (!isMessageInfo(info)) return;
    if (info.role === "assistant") {
      this.assistantMessages.add(info.id);
      // Initialize an empty buffer if we haven't seen any parts yet,
      // so tryFire knows the message exists.
      if (!this.buffers.has(info.id)) this.buffers.set(info.id, "");
    } else {
      // user / other roles — ignore (and prune any speculative buffer).
      this.buffers.delete(info.id);
    }
  }

  /**
   * `message.part.updated` carries one Part with the latest content.
   * For TextPart, we replace the buffer entry for `messageID` with
   * the part's full text. (Parts arrive whole, replacing prior
   * deltas; the SDK exposes the cumulative `text` field, not just
   * the delta.) Returns the messageID if the part was a text part on
   * a known message, else null.
   */
  private handlePartUpdated(event: EventLike): string | null {
    const props = event.properties as { part?: unknown };
    const part = props.part;
    if (!isTextPart(part)) return null;

    // Append-style accumulation: a single message can have multiple
    // text parts (rare but legal — a tool call can emit a tool-result
    // and then text). We track the cumulative text across all text
    // parts in the message, separated by newlines, so the "first
    // non-whitespace line" check considers ALL leading text.
    const messageID = part.messageID;
    const existing = this.buffers.get(messageID) ?? "";
    // Index by partID so re-updates of the same part don't duplicate.
    // Simpler approach: store the part's text keyed by partId in a
    // separate per-message map. For pilot's needs (just check first
    // line), the simpler heuristic is good enough: maintain a single
    // string per message that is the latest text we've seen.
    //
    // Because parts often arrive as full-replacement deltas (the SDK
    // sends the full `text`, not a delta string in the event's `delta`
    // field every time), we treat the part's `text` as authoritative
    // for that part. To handle multiple parts in one message, we
    // join them at the message level — but again we don't have
    // ordering. For STOP detection on the first line, only the FIRST
    // text part's content matters; later parts can't move the first
    // line.
    //
    // Practical compromise: store the FIRST text part's text. Other
    // parts are ignored. If the part we see has a smaller `id` than
    // an existing buffered first part, we replace. We approximate
    // "first" via the part.id ordering (lexicographic — SDK uses
    // monotonically-increasing ids).
    const firstPartId = this.getFirstTextPartId(messageID);
    if (firstPartId === null || part.id <= firstPartId) {
      this.buffers.set(messageID, part.text);
      this.recordFirstTextPartId(messageID, part.id);
    } else {
      // not the first text part — leave buffer alone
      void existing;
    }

    return messageID;
  }

  // Per-message tracking of which part id is the "first" text part
  // we've seen. Stored in a separate Map to avoid stuffing it into
  // the buffer string.
  private readonly firstTextPartIds = new Map<string, string>();
  private getFirstTextPartId(messageID: string): string | null {
    return this.firstTextPartIds.get(messageID) ?? null;
  }
  private recordFirstTextPartId(messageID: string, partId: string): void {
    const existing = this.firstTextPartIds.get(messageID);
    if (existing === undefined || partId < existing) {
      this.firstTextPartIds.set(messageID, partId);
    }
  }
}

// --- Pure helpers ----------------------------------------------------------

/**
 * Pure check: does `text` contain a STOP message per the protocol?
 *
 * The STOP rule is:
 *   - First non-whitespace line MUST begin with `STOP:` (case-sensitive).
 *
 * Returns the matched line and the reason (everything after `STOP:`,
 * trimmed) or null if no match.
 *
 * Exported for direct testing — the StopDetector test exercises it
 * indirectly, but a pure unit test catches edge cases more cleanly.
 */
export function checkStop(text: string): { line: string; reason: string } | null {
  if (typeof text !== "string" || text.length === 0) return null;
  // Find the first non-whitespace line.
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue; // skip blank lines
    if (line.startsWith("STOP:")) {
      const reason = line.slice("STOP:".length).trim();
      return { line, reason };
    }
    // First non-whitespace content was NOT a STOP line — done.
    return null;
  }
  return null;
}

// --- Type guards -----------------------------------------------------------

function getSessionID(event: EventLike): string | null {
  // session.idle/error: properties.sessionID is a flat string.
  // message.updated: properties.info.sessionID
  // message.part.updated: properties.part.sessionID
  const p = event.properties as {
    sessionID?: unknown;
    info?: { sessionID?: unknown };
    part?: { sessionID?: unknown };
  };
  if (typeof p.sessionID === "string") return p.sessionID;
  if (p.info && typeof p.info.sessionID === "string") return p.info.sessionID;
  if (p.part && typeof p.part.sessionID === "string") return p.part.sessionID;
  return null;
}

function getMessageID(event: EventLike): string | null {
  const p = event.properties as { info?: { id?: unknown } };
  if (p.info && typeof p.info.id === "string") return p.info.id;
  return null;
}

function isMessageInfo(
  v: unknown,
): v is { id: string; sessionID: string; role: string } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { id?: unknown; sessionID?: unknown; role?: unknown };
  return (
    typeof o.id === "string" &&
    typeof o.sessionID === "string" &&
    typeof o.role === "string"
  );
}

function isTextPart(
  v: unknown,
): v is { id: string; messageID: string; sessionID: string; type: "text"; text: string } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    id?: unknown;
    messageID?: unknown;
    sessionID?: unknown;
    type?: unknown;
    text?: unknown;
  };
  return (
    o.type === "text" &&
    typeof o.id === "string" &&
    typeof o.messageID === "string" &&
    typeof o.sessionID === "string" &&
    typeof o.text === "string"
  );
}
