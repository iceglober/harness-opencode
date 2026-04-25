# S3 — opencode SSE event shapes

**Question:** Identify the exact event names emitted on assistant message and session-idle. Capture an example payload.

**Verdict:** Confirmed. Three relevant event names, all stable in the SDK type generation.

## Evidence (from `@opencode-ai/sdk@1.14.19` types.gen.d.ts)

```ts
// Line 129 — fires when an assistant message is created or updated
export type EventMessageUpdated = {
  type: "message.updated";
  properties: { info: Message };
};

// Line 354 — fires for streaming text deltas and tool-call updates within a message
export type EventMessagePartUpdated = {
  type: "message.part.updated";
  properties: { part: Part; delta?: string };
};

// Line 413 — THE canonical "session is done thinking" signal
export type EventSessionIdle = {
  type: "session.idle";
  properties: { sessionID: string };
};

// Line 406 — broader status changes
export type EventSessionStatus = {
  type: "session.status";
  properties: { sessionID: string; status: SessionStatus };
};

// Line 518 — session error (worker should treat as failure)
export type EventSessionError = {
  type: "session.error";
  properties: { sessionID: string; error?: string /* shape TBD */ };
};
```

## Subscription mechanics

```ts
const events = await client.event.subscribe();
// returns ServerSentEventsResult — async iterable of typed events
for await (const event of events.stream) {
  if (event.type === "session.idle" && event.properties.sessionID === mySessionId) {
    // session is done — proceed to verify
  }
}
```

Single SSE stream multiplexes ALL sessions, so `EventBus` (Phase D2) MUST filter
by `sessionID` per subscriber. Plan's design already accounts for this.

## STOP-protocol detection (E1)

The worker watches `message.updated` events whose `info.role === "assistant"`,
extracts the text part(s), and checks if the first non-whitespace line matches
`^STOP:`. The plan's stop-detect.ts module does this.

Note: text may stream in via `message.part.updated` deltas, so the worker
should re-check on every `message.updated` for the same message until
`session.idle` fires (assistant text is finalized at idle time).

## Stall detection

`session.idle` is the green-light signal. Stall = N seconds elapsed with no
events of any kind for our session. Plan's `waitForIdle({ stallMs })` is
correct: race idle event vs stall timer, abort on stall.

## Implementation note

The SSE stream may include events for sessions we don't care about (other
pilot tasks running concurrently in v0.3, or other opencode instances sharing
the server). The bus must filter by `sessionID` rigorously — never assume
the next event on the wire belongs to our session.
