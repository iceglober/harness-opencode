// pilot-opencode-events.test.ts — tests for src/pilot/opencode/events.ts.
//
// Mocks `client.event.subscribe()` with a hand-rolled async iterator that
// the test pushes events into. This exercises the bus's fan-out, session
// filtering, waitForIdle's idle/stall/abort/error branches, and shutdown
// cleanup — all without spinning up a real opencode server.

import { describe, test, expect } from "bun:test";

import {
  EventBus,
  type EventLike,
  type WaitForIdleResult,
} from "../src/pilot/opencode/events.js";

// --- Mock SSE stream -------------------------------------------------------

/**
 * A pushable async iterator. Tests push events with `push(event)` and
 * close with `close()`. The bus consumes via the iterator returned
 * from `subscribe()`.
 *
 * Why hand-rolled (vs a queue lib): keeps the test deps zero and the
 * timing deterministic — every `push` immediately resolves the
 * waiting `next()` if any.
 */
function makeMockStream() {
  const queue: EventLike[] = [];
  const waiters: Array<(v: IteratorResult<EventLike>) => void> = [];
  let closed = false;

  const push = (event: EventLike): void => {
    if (closed) return;
    if (waiters.length > 0) {
      const w = waiters.shift()!;
      w({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  const close = (): void => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()!({ value: undefined as unknown as EventLike, done: true });
    }
  };

  const stream: AsyncGenerator<EventLike, void, unknown> = (async function* () {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (closed) return;
      const next = await new Promise<IteratorResult<EventLike>>((resolve) => {
        waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  })();

  return { push, close, stream };
}

/**
 * Build a fake `OpencodeClient` whose only used method is
 * `event.subscribe`. The bus doesn't touch any other field.
 *
 * The mock wires the AbortSignal to close the underlying stream so
 * `bus.close()` (which aborts the signal) actually unblocks the
 * `for await` consuming the stream — production opencode does the
 * same thing via the SSE client's signal handling.
 */
function makeFakeClient() {
  const stream = makeMockStream();
  let signalSeen: AbortSignal | undefined;
  const client = {
    event: {
      subscribe: async (
        opts?: { signal?: AbortSignal },
      ): Promise<{ stream: typeof stream.stream }> => {
        signalSeen = opts?.signal;
        if (signalSeen) {
          if (signalSeen.aborted) {
            stream.close();
          } else {
            signalSeen.addEventListener("abort", () => stream.close(), {
              once: true,
            });
          }
        }
        return { stream: stream.stream };
      },
    },
  } as unknown as Parameters<typeof EventBus>[0] extends infer T ? T : never;
  return { client, stream, getSignal: () => signalSeen };
}

/**
 * Yield to the event loop generously enough for the bus's stream loop
 * to drain a handful of pushed events. The bus's `for await` requires
 * one microtask + one `await` per event, plus another for handler
 * dispatch; 32 cycles is comfortably more than needed for our test
 * sizes (3-5 events) without being so large it gates real-world
 * timeouts.
 */
async function flush(cycles = 32): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
}

// --- Fan-out + session filtering ------------------------------------------

describe("EventBus — fan-out and session filtering", () => {
  test("dispatches events to handlers whose sessionId matches", async () => {
    const { client, stream } = makeFakeClient();
    // The fake client's type alias collapses to `unknown` due to
    // ts-magic; cast for the constructor.
    const bus = new EventBus(client as never);
    try {
      const aSeen: EventLike[] = [];
      const bSeen: EventLike[] = [];
      bus.on("ses_a", (e) => { aSeen.push(e); });
      bus.on("ses_b", (e) => { bSeen.push(e); });

      stream.push({ type: "message.updated", properties: { sessionID: "ses_a", n: 1 } });
      stream.push({ type: "message.updated", properties: { sessionID: "ses_b", n: 2 } });
      stream.push({ type: "message.updated", properties: { sessionID: "ses_a", n: 3 } });

      await flush();

      expect(aSeen.map((e) => (e.properties as { n: number }).n)).toEqual([1, 3]);
      expect(bSeen.map((e) => (e.properties as { n: number }).n)).toEqual([2]);
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("ignores events without a sessionID", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const seen: EventLike[] = [];
      bus.on("ses_a", (e) => seen.push(e));
      stream.push({ type: "global.something", properties: {} });
      stream.push({ type: "session.idle", properties: { sessionID: "ses_a" } });
      await flush();
      expect(seen.map((e) => e.type)).toEqual(["session.idle"]);
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("multiple handlers on same session both fire (in registration order)", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const order: string[] = [];
      bus.on("s1", () => order.push("first"));
      bus.on("s1", () => order.push("second"));
      stream.push({ type: "x", properties: { sessionID: "s1" } });
      await flush();
      expect(order).toEqual(["first", "second"]);
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("unsubscribe removes the handler", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const seen: number[] = [];
      const off = bus.on("s1", () => seen.push(1));
      stream.push({ type: "x", properties: { sessionID: "s1" } });
      await flush();
      off();
      stream.push({ type: "x", properties: { sessionID: "s1" } });
      await flush();
      expect(seen.length).toBe(1);
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("a throwing handler does not crash the bus or break fan-out to other handlers", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const peace: number[] = [];
      bus.on("s1", () => { throw new Error("ow"); });
      bus.on("s1", () => peace.push(1));
      stream.push({ type: "x", properties: { sessionID: "s1" } });
      await flush();
      expect(peace).toEqual([1]);
      // Bus should still be alive.
      stream.push({ type: "x", properties: { sessionID: "s1" } });
      await flush();
      expect(peace).toEqual([1, 1]);
    } finally {
      stream.close();
      await bus.close();
    }
  });
});

// --- waitForIdle -----------------------------------------------------------

describe("EventBus.waitForIdle", () => {
  test("resolves with idle when session.idle arrives for the target session", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const p = bus.waitForIdle("s1", { stallMs: 5_000 });
      stream.push({ type: "message.updated", properties: { sessionID: "s1" } });
      stream.push({ type: "session.idle", properties: { sessionID: "s1" } });
      const r: WaitForIdleResult = await p;
      expect(r).toEqual({ kind: "idle" });
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("ignores session.idle for OTHER sessions", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const p = bus.waitForIdle("s1", { stallMs: 200 });
      // Idle for a different session should NOT resolve our wait.
      stream.push({ type: "session.idle", properties: { sessionID: "s2" } });
      const r = await p; // should resolve via stall
      expect(r.kind).toBe("stall");
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("resolves with stall when no events arrive within stallMs", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const r = await bus.waitForIdle("s1", { stallMs: 50 });
      expect(r).toEqual({ kind: "stall", stallMs: 50 });
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("non-idle activity resets the stall timer", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const p = bus.waitForIdle("s1", { stallMs: 100 });
      // Push activity at 30ms, 60ms, 90ms — none of which is idle —
      // then push idle. Stall is 100ms but each activity event resets
      // it, so we should get idle, not stall.
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      await sleep(30);
      stream.push({ type: "message.updated", properties: { sessionID: "s1" } });
      await sleep(30);
      stream.push({ type: "message.updated", properties: { sessionID: "s1" } });
      await sleep(30);
      stream.push({ type: "message.updated", properties: { sessionID: "s1" } });
      await sleep(30);
      stream.push({ type: "session.idle", properties: { sessionID: "s1" } });
      const r = await p;
      expect(r.kind).toBe("idle");
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("resolves with abort when abortSignal aborts mid-wait", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const ctrl = new AbortController();
      const p = bus.waitForIdle("s1", { stallMs: 60_000, abortSignal: ctrl.signal });
      setTimeout(() => ctrl.abort("test cancel"), 30);
      const r = await p;
      expect(r.kind).toBe("abort");
      if (r.kind === "abort") {
        expect(r.reason).toBe("test cancel");
      }
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("resolves immediately if abortSignal already aborted", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const ctrl = new AbortController();
      ctrl.abort("pre-aborted");
      const r = await bus.waitForIdle("s1", { stallMs: 60_000, abortSignal: ctrl.signal });
      expect(r.kind).toBe("abort");
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("resolves with session-error on session.error for the target", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const p = bus.waitForIdle("s1", { stallMs: 5_000 });
      stream.push({
        type: "session.error",
        properties: { sessionID: "s1", error: "boom" },
      });
      const r = await p;
      expect(r.kind).toBe("session-error");
      if (r.kind === "session-error") {
        expect(r.properties.error).toBe("boom");
      }
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("session.error for OTHER session does NOT resolve our wait", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const p = bus.waitForIdle("s1", { stallMs: 100 });
      stream.push({
        type: "session.error",
        properties: { sessionID: "s2", error: "not ours" },
      });
      const r = await p;
      expect(r.kind).toBe("stall"); // ours never got an event
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("errorIsFatal=false swallows session.error and keeps waiting for idle", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const p = bus.waitForIdle("s1", { stallMs: 5_000, errorIsFatal: false });
      stream.push({
        type: "session.error",
        properties: { sessionID: "s1", error: "transient" },
      });
      stream.push({
        type: "session.idle",
        properties: { sessionID: "s1" },
      });
      const r = await p;
      expect(r.kind).toBe("idle");
    } finally {
      stream.close();
      await bus.close();
    }
  });

  test("settling once is final — late events do not double-resolve", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    try {
      const r1 = bus.waitForIdle("s1", { stallMs: 50 });
      const settled = await r1;
      expect(settled.kind).toBe("stall");
      // Late idle should not throw or crash.
      stream.push({ type: "session.idle", properties: { sessionID: "s1" } });
      // No exception, no test hang.
    } finally {
      stream.close();
      await bus.close();
    }
  });
});

// --- close + lifecycle -----------------------------------------------------

describe("EventBus.close", () => {
  test("close is idempotent", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    await bus.close();
    await bus.close();
    expect(true).toBe(true); // no throw
    stream.close();
  });

  test("on() after close throws", async () => {
    const { client, stream } = makeFakeClient();
    const bus = new EventBus(client as never);
    await bus.close();
    expect(() => bus.on("s1", () => {})).toThrow(/closed/);
    stream.close();
  });

  test("close aborts the underlying SSE subscribe via signal", async () => {
    const { client, stream, getSignal } = makeFakeClient();
    const bus = new EventBus(client as never);
    // Let the constructor's await client.event.subscribe(...) resolve.
    await flush();
    const sig = getSignal();
    expect(sig).toBeDefined();
    expect(sig!.aborted).toBe(false);
    await bus.close();
    expect(sig!.aborted).toBe(true);
    stream.close();
  });
});

// --- subscription failure --------------------------------------------------

describe("EventBus — stream errors", () => {
  test("getStreamError surfaces a failed subscribe", async () => {
    // Build a custom client whose subscribe throws.
    const failingClient = {
      event: {
        subscribe: async () => {
          throw new Error("connection refused");
        },
      },
    };
    const bus = new EventBus(failingClient as never);
    // Give the runStream microtask a chance.
    await flush(8);
    const err = bus.getStreamError();
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/connection refused/);
    await bus.close();
  });
});
