// pilot-stop-detect.test.ts — coverage for src/pilot/worker/stop-detect.ts.
//
// Two surfaces:
//   - checkStop (pure regex on a string) — exhaustive cases.
//   - StopDetector (event-driven state machine) — feed mock events,
//     observe onStop callback firing semantics.

import { describe, test, expect } from "bun:test";
import {
  StopDetector,
  checkStop,
  type StopDetected,
} from "../src/pilot/worker/stop-detect.js";
import type { EventLike } from "../src/pilot/opencode/events.js";

// --- checkStop pure --------------------------------------------------------

describe("checkStop — pure", () => {
  test("matches when first non-whitespace line is STOP:", () => {
    const r = checkStop("STOP: missing dependency");
    expect(r).not.toBeNull();
    expect(r!.line).toBe("STOP: missing dependency");
    expect(r!.reason).toBe("missing dependency");
  });

  test("skips leading blank lines", () => {
    const r = checkStop("\n\n   \nSTOP: blocked");
    expect(r).not.toBeNull();
    expect(r!.reason).toBe("blocked");
  });

  test("rejects when leading non-whitespace line is NOT STOP:", () => {
    expect(checkStop("Sure, I'll start by\nSTOP: not a real stop")).toBeNull();
  });

  test("rejects lowercase 'stop:'", () => {
    expect(checkStop("stop: lowercase")).toBeNull();
  });

  test("rejects 'STOP' without colon", () => {
    expect(checkStop("STOP missing colon")).toBeNull();
  });

  test("accepts STOP: with empty reason", () => {
    const r = checkStop("STOP:");
    expect(r).not.toBeNull();
    expect(r!.reason).toBe("");
  });

  test("trims surrounding whitespace from the line and reason", () => {
    const r = checkStop("   STOP:   tool not installed   \n");
    expect(r).not.toBeNull();
    expect(r!.line).toBe("STOP:   tool not installed");
    expect(r!.reason).toBe("tool not installed");
  });

  test("only inspects the first non-whitespace line", () => {
    expect(
      checkStop("Working on it...\n\nSTOP: not really, just kidding"),
    ).toBeNull();
  });

  test("returns null on empty / whitespace-only input", () => {
    expect(checkStop("")).toBeNull();
    expect(checkStop("   \n\n  ")).toBeNull();
  });

  test("CRLF line endings work", () => {
    const r = checkStop("STOP: windows\r\n");
    expect(r).not.toBeNull();
    expect(r!.reason).toBe("windows");
  });

  test("non-string input returns null", () => {
    // @ts-expect-error testing bad input
    expect(checkStop(null)).toBeNull();
    // @ts-expect-error testing bad input
    expect(checkStop(undefined)).toBeNull();
  });
});

// --- StopDetector event-driven --------------------------------------------

/**
 * Build a `message.updated` event for an assistant or user message.
 */
function messageUpdated(args: {
  sessionID: string;
  messageID: string;
  role: "assistant" | "user";
}): EventLike {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: args.messageID,
        sessionID: args.sessionID,
        role: args.role,
        time: { created: 1 },
        modelID: "m",
        providerID: "p",
        mode: "x",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        parentID: "",
      },
    },
  };
}

/**
 * Build a `message.part.updated` event for a TextPart.
 */
function partUpdated(args: {
  sessionID: string;
  messageID: string;
  partID: string;
  text: string;
}): EventLike {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: args.partID,
        messageID: args.messageID,
        sessionID: args.sessionID,
        type: "text",
        text: args.text,
      },
    },
  };
}

describe("StopDetector — basic firing", () => {
  test("fires onStop when an assistant message's first part contains STOP:", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p1",
        text: "STOP: dep missing",
      }),
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]!.messageID).toBe("m1");
    expect(fired[0]!.reason).toBe("dep missing");
  });

  test("does NOT fire on user messages even with STOP: text", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "user" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p1",
        text: "STOP: from the user, not the agent",
      }),
    );
    expect(fired).toHaveLength(0);
  });

  test("ignores events for OTHER sessions", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s2", messageID: "m1", role: "assistant" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s2",
        messageID: "m1",
        partID: "p1",
        text: "STOP: wrong session",
      }),
    );
    expect(fired).toHaveLength(0);
  });

  test("only fires once across multiple updates of the same message", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p1",
        text: "STOP: first",
      }),
    );
    // Subsequent updates (e.g. trailing text added by the agent) MUST
    // NOT re-fire.
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p1",
        text: "STOP: first\nThe rest of the message follows",
      }),
    );
    expect(fired).toHaveLength(1);
  });

  test("ignores assistant messages whose first part doesn't START with STOP", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p1",
        text: "I'll start by reading AGENTS.md.\nSTOP: not on first line",
      }),
    );
    expect(fired).toHaveLength(0);
  });
});

describe("StopDetector — streaming deltas", () => {
  test("fires once the streamed text reaches STOP: but not before", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    // Streaming progression
    det.consume(
      partUpdated({ sessionID: "s1", messageID: "m1", partID: "p1", text: "S" }),
    );
    det.consume(
      partUpdated({ sessionID: "s1", messageID: "m1", partID: "p1", text: "STO" }),
    );
    det.consume(
      partUpdated({ sessionID: "s1", messageID: "m1", partID: "p1", text: "STOP" }),
    );
    expect(fired).toHaveLength(0);
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p1",
        text: "STOP: reason here",
      }),
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]!.reason).toBe("reason here");
  });

  test("part.updated arriving BEFORE message.updated still gets recognized after the role is known", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    // Out-of-order arrival
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p1",
        text: "STOP: fast streaming",
      }),
    );
    expect(fired).toHaveLength(0); // role unknown yet
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    expect(fired).toHaveLength(1);
  });
});

describe("StopDetector — single-shot semantics", () => {
  test("after firing, subsequent events for ANY message are ignored", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p1",
        text: "STOP: first",
      }),
    );
    // Another assistant message after the first STOP — ignored.
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m2", role: "assistant" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m2",
        partID: "p1",
        text: "STOP: second",
      }),
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]!.messageID).toBe("m1");
  });
});

describe("StopDetector — multiple text parts in one message", () => {
  test("only the FIRST part's text matters; later parts can't trigger STOP", () => {
    // The agent emits a tool-call, then a text part with normal prose,
    // then a second text part with STOP: — that doesn't count because
    // the FIRST text part wasn't a STOP.
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p001",
        text: "Working on it.",
      }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p002",
        text: "STOP: not really",
      }),
    );
    expect(fired).toHaveLength(0);
  });

  test("first part appearing late (but with smaller id) replaces and triggers", () => {
    // Arrival order p002, then p001 — id-based "first" detection.
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p002",
        text: "Some prose",
      }),
    );
    expect(fired).toHaveLength(0);
    det.consume(
      partUpdated({
        sessionID: "s1",
        messageID: "m1",
        partID: "p001",
        text: "STOP: came late",
      }),
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]!.reason).toBe("came late");
  });
});

describe("StopDetector — irrelevant events", () => {
  test("session.idle and other events are ignored without error", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume({
      type: "session.idle",
      properties: { sessionID: "s1" },
    });
    det.consume({
      type: "session.status",
      properties: { sessionID: "s1", status: "idle" },
    });
    expect(fired).toHaveLength(0);
  });

  test("non-text parts (tool-call, reasoning) are ignored", () => {
    const fired: StopDetected[] = [];
    const det = new StopDetector({
      sessionID: "s1",
      onStop: (d) => fired.push(d),
    });
    det.consume(
      messageUpdated({ sessionID: "s1", messageID: "m1", role: "assistant" }),
    );
    det.consume({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          messageID: "m1",
          sessionID: "s1",
          type: "tool",
          tool: "read",
        },
      },
    });
    expect(fired).toHaveLength(0);
  });
});
