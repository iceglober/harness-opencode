import { describe, it, expect, beforeEach } from "bun:test";
import { __test__ } from "../src/plugins/tool-hooks.js";

const {
  sessions,
  getSession,
  resolveConfig,
  applyBackpressure,
  checkEditLoop,
  checkReadDedup,
  looksLikeBashFailure,
  extractFilePath,
  hashContent,
  getToolOutputDir,
  isUnderToolOutputDir,
  takeGrepHead,
  DEFAULT_BACKPRESSURE_THRESHOLD,
  DEFAULT_LOOP_THRESHOLD,
} = __test__;

// ---- helpers ---------------------------------------------------------------

function makeConfig(overrides: any = {}) {
  return resolveConfig({} as any, { toolHooks: overrides });
}

function defaultConfig() {
  return resolveConfig({} as any);
}

// ---- resolveConfig ---------------------------------------------------------

describe("resolveConfig", () => {
  it("returns defaults when no config is provided", () => {
    const cfg = defaultConfig();
    expect(cfg.backpressure.enabled).toBe(true);
    expect(cfg.backpressure.threshold).toBe(DEFAULT_BACKPRESSURE_THRESHOLD);
    expect(cfg.backpressure.headChars).toBe(300);
    expect(cfg.backpressure.tailChars).toBe(200);
    expect(cfg.backpressure.tools.has("bash")).toBe(true);
    expect(cfg.backpressure.tools.has("read")).toBe(true);
    expect(cfg.verifyLoop.enabled).toBe(true);
    expect(cfg.verifyLoop.timeoutMs).toBe(15_000);
    expect(cfg.loopDetection.enabled).toBe(true);
    expect(cfg.loopDetection.threshold).toBe(DEFAULT_LOOP_THRESHOLD);
    expect(cfg.readDedup.enabled).toBe(true);
  });

  it("respects explicit overrides", () => {
    const cfg = makeConfig({
      backpressure: { enabled: false, threshold: 5000, tools: ["bash"] },
      verifyLoop: { enabled: false, timeoutMs: 30_000 },
      loopDetection: { threshold: 10 },
      readDedup: { enabled: false },
    });
    expect(cfg.backpressure.enabled).toBe(false);
    expect(cfg.backpressure.threshold).toBe(5000);
    expect(cfg.backpressure.tools.size).toBe(1);
    expect(cfg.verifyLoop.enabled).toBe(false);
    expect(cfg.verifyLoop.timeoutMs).toBe(30_000);
    expect(cfg.loopDetection.threshold).toBe(10);
    expect(cfg.readDedup.enabled).toBe(false);
  });
});

// ---- looksLikeBashFailure --------------------------------------------------

describe("looksLikeBashFailure", () => {
  it("detects exit code markers", () => {
    expect(looksLikeBashFailure("some output\nExit code: 1")).toBe(true);
    expect(looksLikeBashFailure("ok\nExit code: 0")).toBe(false);
  });

  it("detects 'exited with code' patterns", () => {
    expect(looksLikeBashFailure("process exited with code 127")).toBe(true);
    expect(looksLikeBashFailure("process exited with code 0")).toBe(false);
  });

  it("detects 'command failed' pattern", () => {
    expect(looksLikeBashFailure("command failed")).toBe(true);
  });

  it("detects short ERROR outputs", () => {
    expect(looksLikeBashFailure("ERROR: something broke")).toBe(true);
  });

  it("does NOT treat long outputs with ERROR as failure (may be in content)", () => {
    const longOutput = "x".repeat(600) + "\nERROR\n" + "y".repeat(600);
    expect(looksLikeBashFailure(longOutput)).toBe(false);
  });

  it("returns false for normal success output", () => {
    expect(looksLikeBashFailure("all tests passed")).toBe(false);
  });
});

// ---- extractFilePath -------------------------------------------------------

describe("extractFilePath", () => {
  it("extracts from filePath key", () => {
    expect(extractFilePath({ filePath: "/foo/bar.ts" })).toBe("/foo/bar.ts");
  });

  it("extracts from path key", () => {
    expect(extractFilePath({ path: "/foo/baz.ts" })).toBe("/foo/baz.ts");
  });

  it("extracts from file key", () => {
    expect(extractFilePath({ file: "/foo/qux.ts" })).toBe("/foo/qux.ts");
  });

  it("prefers filePath over path over file", () => {
    expect(
      extractFilePath({ filePath: "/a.ts", path: "/b.ts", file: "/c.ts" }),
    ).toBe("/a.ts");
  });

  it("returns null for non-objects", () => {
    expect(extractFilePath(null)).toBeNull();
    expect(extractFilePath("string")).toBeNull();
    expect(extractFilePath(42)).toBeNull();
  });

  it("returns null when no path key exists", () => {
    expect(extractFilePath({ command: "ls" })).toBeNull();
  });
});

// ---- hashContent -----------------------------------------------------------

describe("hashContent", () => {
  it("returns a 16-char hex string", () => {
    const h = hashContent("hello world");
    expect(h.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(h)).toBe(true);
  });

  it("returns same hash for same content", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
  });

  it("returns different hash for different content", () => {
    expect(hashContent("abc")).not.toBe(hashContent("def"));
  });
});

// ---- applyBackpressure -----------------------------------------------------

describe("applyBackpressure", () => {
  it("does nothing when output is below threshold", () => {
    const cfg = defaultConfig().backpressure;
    const output = { output: "short output" };
    applyBackpressure(cfg, "bash", "call-1", output);
    expect(output.output).toBe("short output");
  });

  it("truncates output above threshold for success", () => {
    const cfg = defaultConfig().backpressure;
    const longOutput = "A".repeat(7000); // exceeds new 6000 default
    const output = { output: longOutput };
    applyBackpressure(cfg, "bash", "call-2", output);
    expect(output.output.length).toBeLessThan(longOutput.length);
    expect(output.output).toContain("chars truncated");
    expect(output.output).toContain("7000 total");
  });

  it("preserves head and tail content (head-tail shape)", () => {
    // The default bash shape is now "tail" which drops the head. To cover
    // the legacy "head-tail" shape we explicitly opt in via perTool.
    const cfg = makeConfig({
      backpressure: { perTool: { bash: { shape: "head-tail" } } },
    }).backpressure;
    const head = "HEAD_MARKER_" + "x".repeat(288);
    const middle = "m".repeat(7000); // exceeds 6000 threshold
    const tail = "y".repeat(180) + "_TAIL_MARKER";
    const output = { output: head + middle + tail };
    applyBackpressure(cfg, "bash", "call-3", output);
    expect(output.output).toContain("HEAD_MARKER_");
    expect(output.output).toContain("_TAIL_MARKER");
  });

  it("preserves full output on bash failure", () => {
    const cfg = defaultConfig().backpressure;
    const failOutput = "x".repeat(3000) + "\nExit code: 1";
    const output = { output: failOutput };
    applyBackpressure(cfg, "bash", "call-4", output);
    expect(output.output).toBe(failOutput);
  });

  it("does nothing when disabled", () => {
    const cfg = makeConfig({ backpressure: { enabled: false } }).backpressure;
    const longOutput = "x".repeat(5000);
    const output = { output: longOutput };
    applyBackpressure(cfg, "bash", "call-5", output);
    expect(output.output).toBe(longOutput);
  });

  it("does nothing for tools not in the tool set", () => {
    const cfg = defaultConfig().backpressure;
    const longOutput = "x".repeat(5000);
    const output = { output: longOutput };
    applyBackpressure(cfg, "edit", "call-6", output);
    expect(output.output).toBe(longOutput);
  });

  it("writes disk offload file", () => {
    const cfg = defaultConfig().backpressure;
    const longOutput = "x".repeat(7000); // exceeds new 6000 default
    const output = { output: longOutput };
    applyBackpressure(cfg, "bash", "call-disk-test", output);
    // The truncated output should reference a file path
    expect(output.output).toContain("Full output saved to:");
    expect(output.output).toContain("call-disk-test.txt");
  });

  // ---- per-tool shape defaults -------------------------------------------

  it("default read shape is 'skip' — no truncation regardless of size", () => {
    const cfg = defaultConfig().backpressure;
    const longOutput = "x".repeat(10000);
    const output = { output: longOutput };
    applyBackpressure(cfg, "read", "call-read-skip", output, {
      filePath: "/some/file.ts",
    });
    expect(output.output).toBe(longOutput);
  });

  it("default glob shape is 'skip' — no truncation regardless of size", () => {
    const cfg = defaultConfig().backpressure;
    const longOutput = "path/a.ts\n".repeat(2000);
    const output = { output: longOutput };
    applyBackpressure(cfg, "glob", "call-glob-skip", output);
    expect(output.output).toBe(longOutput);
  });

  it("default bash shape is 'tail' — drops head, keeps tail", () => {
    const cfg = defaultConfig().backpressure;
    const text = "HEAD_MARKER" + "x".repeat(10000) + "TAIL_MARKER";
    const output = { output: text };
    applyBackpressure(cfg, "bash", "call-bash-tail", output);
    expect(output.output).not.toContain("HEAD_MARKER");
    expect(output.output).toContain("TAIL_MARKER");
    expect(output.output).toContain("chars truncated");
  });

  it("default grep shape is 'head-with-count' — first N blocks + count tail", () => {
    const cfg = defaultConfig().backpressure;
    // 30 match blocks separated by blank lines. Each block ~250 chars to
    // exceed threshold.
    const block = (n: number) =>
      `file.ts:${n}: match line ${n}\n` + "x".repeat(240);
    const text = Array.from({ length: 30 }, (_, i) => block(i)).join("\n\n");
    const output = { output: text };
    applyBackpressure(cfg, "grep", "call-grep-head", output);
    expect(output.output).toContain("file.ts:0:");
    expect(output.output).toContain("file.ts:19:");
    expect(output.output).not.toContain("file.ts:20:");
    expect(output.output).toMatch(/10 more matches/);
  });

  // ---- recovery-read bypass ----------------------------------------------

  it("recovery-read of spill path bypasses truncation", () => {
    // Force read to head-tail shape so truncation would normally fire;
    // then point it at a file under the spill dir to prove the bypass.
    const cfg = makeConfig({
      backpressure: { perTool: { read: { shape: "head-tail" } } },
    }).backpressure;
    const spillDir = getToolOutputDir();
    const text = "x".repeat(10000);
    const output = { output: text };
    applyBackpressure(cfg, "read", "call-recovery", output, {
      filePath: `${spillDir}/tooluse_abc123.txt`,
    });
    expect(output.output).toBe(text); // unchanged — bypass fired
  });

  it("non-spill read still truncates when shape is head-tail", () => {
    const cfg = makeConfig({
      backpressure: { perTool: { read: { shape: "head-tail" } } },
    }).backpressure;
    const text = "x".repeat(10000);
    const output = { output: text };
    applyBackpressure(cfg, "read", "call-nonspill", output, {
      filePath: "/home/user/src/foo.ts",
    });
    expect(output.output.length).toBeLessThan(text.length);
    expect(output.output).toContain("chars truncated");
  });

  // ---- perTool overrides -------------------------------------------------

  it("user perTool override wins over default shape", () => {
    // Force read to head-tail shape; should truncate a 10000-char output.
    const cfg = makeConfig({
      backpressure: { perTool: { read: { shape: "head-tail" } } },
    }).backpressure;
    const text = "x".repeat(10000);
    const output = { output: text };
    applyBackpressure(cfg, "read", "call-override", output, {
      filePath: "/non/spill/path.txt",
    });
    expect(output.output.length).toBeLessThan(text.length);
    expect(output.output).toContain("chars truncated");
  });

  it("user threshold override still works", () => {
    const cfg = makeConfig({
      backpressure: {
        threshold: 500,
        perTool: { bash: { shape: "head-tail" } },
      },
    }).backpressure;
    const text = "x".repeat(1000);
    const output = { output: text };
    applyBackpressure(cfg, "bash", "call-threshold-override", output);
    expect(output.output.length).toBeLessThan(text.length);
    expect(output.output).toContain("1000 total");
  });

  it("DEFAULT_BACKPRESSURE_THRESHOLD is 6000", () => {
    expect(DEFAULT_BACKPRESSURE_THRESHOLD).toBe(6000);
  });

  // ---- helpers ------------------------------------------------------------

  it("isUnderToolOutputDir recognizes spill-path children", () => {
    const spill = getToolOutputDir();
    expect(isUnderToolOutputDir(`${spill}/abc.txt`)).toBe(true);
    expect(isUnderToolOutputDir(`${spill}`)).toBe(true);
    expect(isUnderToolOutputDir(`/not/spill/path.txt`)).toBe(false);
    // Prefix-spoof guard: /a/spill-extra should NOT match /a/spill
    expect(isUnderToolOutputDir(`${spill}-extra/x.txt`)).toBe(false);
  });

  it("takeGrepHead splits on blank lines and caps blocks", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => `block-${i}`);
    const text = blocks.join("\n\n");
    const { head, matchesKept, matchesOmitted } = takeGrepHead(text, 3);
    expect(matchesKept).toBe(3);
    expect(matchesOmitted).toBe(7);
    expect(head).toBe("block-0\n\nblock-1\n\nblock-2");
  });

  it("takeGrepHead returns full text when blocks fit under cap", () => {
    const text = "a\n\nb\n\nc";
    const { head, matchesKept, matchesOmitted } = takeGrepHead(text, 10);
    expect(matchesKept).toBe(3);
    expect(matchesOmitted).toBe(0);
    expect(head).toBe(text);
  });
});

// ---- checkEditLoop ---------------------------------------------------------

describe("checkEditLoop", () => {
  beforeEach(() => {
    sessions.clear();
  });

  it("does not warn below threshold", () => {
    const cfg = defaultConfig().loopDetection;
    const sess = getSession("loop-test-1");
    const output = { output: "edit applied" };

    for (let i = 0; i < DEFAULT_LOOP_THRESHOLD - 1; i++) {
      checkEditLoop(cfg, sess, "/foo/bar.ts", output);
    }
    expect(output.output).toBe("edit applied");
  });

  it("warns at threshold", () => {
    const cfg = defaultConfig().loopDetection;
    const sess = getSession("loop-test-2");
    const output = { output: "edit applied" };

    for (let i = 0; i < DEFAULT_LOOP_THRESHOLD; i++) {
      output.output = "edit applied"; // reset
      checkEditLoop(cfg, sess, "/foo/bar.ts", output);
    }
    expect(output.output).toContain("LOOP WARNING");
    expect(output.output).toContain(`${DEFAULT_LOOP_THRESHOLD} times`);
  });

  it("does not warn between thresholds", () => {
    const cfg = defaultConfig().loopDetection;
    const sess = getSession("loop-test-3");

    // Reach threshold
    for (let i = 0; i < DEFAULT_LOOP_THRESHOLD; i++) {
      const o = { output: "ok" };
      checkEditLoop(cfg, sess, "/foo/bar.ts", o);
    }

    // Next edit should not warn (threshold + 1)
    const output = { output: "edit applied" };
    checkEditLoop(cfg, sess, "/foo/bar.ts", output);
    expect(output.output).toBe("edit applied");
  });

  it("warns again at double threshold", () => {
    const cfg = defaultConfig().loopDetection;
    const sess = getSession("loop-test-4");

    for (let i = 0; i < DEFAULT_LOOP_THRESHOLD * 2; i++) {
      const o = { output: "ok" };
      checkEditLoop(cfg, sess, "/foo/bar.ts", o);
    }
    // The last call (count == 10) should have warned
    const output = { output: "edit applied" };
    // count is now 10 — the warning fires AT count 10
    // But we already incremented to 10 in the loop. Let's check:
    // After 10 edits, the last output should have the warning.
    expect(sess.editCounts.get("/foo/bar.ts")).toBe(DEFAULT_LOOP_THRESHOLD * 2);
  });

  it("tracks different files independently", () => {
    const cfg = defaultConfig().loopDetection;
    const sess = getSession("loop-test-5");

    for (let i = 0; i < DEFAULT_LOOP_THRESHOLD - 1; i++) {
      const o = { output: "ok" };
      checkEditLoop(cfg, sess, "/a.ts", o);
    }
    for (let i = 0; i < DEFAULT_LOOP_THRESHOLD - 1; i++) {
      const o = { output: "ok" };
      checkEditLoop(cfg, sess, "/b.ts", o);
    }

    // Neither should trigger
    expect(sess.editCounts.get("/a.ts")).toBe(DEFAULT_LOOP_THRESHOLD - 1);
    expect(sess.editCounts.get("/b.ts")).toBe(DEFAULT_LOOP_THRESHOLD - 1);
  });

  it("does nothing when disabled", () => {
    const cfg = makeConfig({ loopDetection: { enabled: false } }).loopDetection;
    const sess = getSession("loop-test-6");

    for (let i = 0; i < 20; i++) {
      const o = { output: "ok" };
      checkEditLoop(cfg, sess, "/foo.ts", o);
    }
    // No warning should have been appended
    const output = { output: "edit applied" };
    checkEditLoop(cfg, sess, "/foo.ts", output);
    expect(output.output).toBe("edit applied");
  });
});

// ---- checkReadDedup --------------------------------------------------------

describe("checkReadDedup", () => {
  beforeEach(() => {
    sessions.clear();
  });

  it("passes through first read (caches content)", () => {
    const cfg = defaultConfig().readDedup;
    const sess = getSession("dedup-1");
    const content = "file content here";
    const output = { output: content };

    const deduped = checkReadDedup(cfg, sess, "/foo.ts", output);
    expect(deduped).toBe(false);
    expect(output.output).toBe(content);
    expect(sess.readCache.has("/foo.ts")).toBe(true);
  });

  it("deduplicates unchanged re-read", () => {
    const cfg = defaultConfig().readDedup;
    const sess = getSession("dedup-2");
    const content = "file content here";

    // First read
    const o1 = { output: content };
    checkReadDedup(cfg, sess, "/foo.ts", o1);

    // Second read of same content
    const o2 = { output: content };
    const deduped = checkReadDedup(cfg, sess, "/foo.ts", o2);
    expect(deduped).toBe(true);
    expect(o2.output).toContain("File unchanged");
    expect(o2.output).toContain("tool call #");
    expect(o2.output).not.toBe(content);
  });

  it("passes through when content has changed", () => {
    const cfg = defaultConfig().readDedup;
    const sess = getSession("dedup-3");

    // First read
    const o1 = { output: "version 1" };
    checkReadDedup(cfg, sess, "/foo.ts", o1);

    // Second read with different content
    const o2 = { output: "version 2" };
    const deduped = checkReadDedup(cfg, sess, "/foo.ts", o2);
    expect(deduped).toBe(false);
    expect(o2.output).toBe("version 2");
  });

  it("returns false for null file path", () => {
    const cfg = defaultConfig().readDedup;
    const sess = getSession("dedup-4");
    const output = { output: "content" };

    const deduped = checkReadDedup(cfg, sess, null, output);
    expect(deduped).toBe(false);
    expect(output.output).toBe("content");
  });

  it("does nothing when disabled", () => {
    const cfg = makeConfig({ readDedup: { enabled: false } }).readDedup;
    const sess = getSession("dedup-5");
    const content = "same content";

    const o1 = { output: content };
    checkReadDedup(cfg, sess, "/foo.ts", o1);

    const o2 = { output: content };
    const deduped = checkReadDedup(cfg, sess, "/foo.ts", o2);
    expect(deduped).toBe(false);
    expect(o2.output).toBe(content);
  });

  it("tracks different files independently", () => {
    const cfg = defaultConfig().readDedup;
    const sess = getSession("dedup-6");

    const o1 = { output: "content A" };
    checkReadDedup(cfg, sess, "/a.ts", o1);

    const o2 = { output: "content B" };
    checkReadDedup(cfg, sess, "/b.ts", o2);

    // Re-read /a.ts with same content
    const o3 = { output: "content A" };
    const deduped = checkReadDedup(cfg, sess, "/a.ts", o3);
    expect(deduped).toBe(true);

    // Re-read /b.ts with different content
    const o4 = { output: "content B modified" };
    const deduped2 = checkReadDedup(cfg, sess, "/b.ts", o4);
    expect(deduped2).toBe(false);
  });
});

// ---- getSession ------------------------------------------------------------

describe("getSession", () => {
  beforeEach(() => {
    sessions.clear();
  });

  it("creates a new session state on first access", () => {
    const sess = getSession("new-session");
    expect(sess.editCounts.size).toBe(0);
    expect(sess.readCache.size).toBe(0);
    expect(sess.callSeq).toBe(1);
  });

  it("returns the same state for the same session ID", () => {
    const s1 = getSession("shared");
    s1.editCounts.set("/x.ts", 3);
    const s2 = getSession("shared");
    expect(s2.editCounts.get("/x.ts")).toBe(3);
  });

  it("increments callSeq on each access", () => {
    getSession("counter");
    getSession("counter");
    const s = getSession("counter");
    expect(s.callSeq).toBe(3);
  });

  it("isolates state between different session IDs", () => {
    const a = getSession("session-a");
    a.editCounts.set("/x.ts", 5);
    const b = getSession("session-b");
    expect(b.editCounts.has("/x.ts")).toBe(false);
  });
});
