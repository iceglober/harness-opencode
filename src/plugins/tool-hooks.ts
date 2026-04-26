/**
 * tool-hooks — cross-cutting tool output middleware.
 *
 * A single sub-plugin registering `tool.execute.after` (and optionally
 * `tool.execute.before` in future) to apply four context-saving
 * optimisations on every tool call:
 *
 *   1. **Output backpressure.** Successful tool output above a character
 *      threshold is truncated (head + tail) with the full text written
 *      to disk. Failures always preserve full output.
 *
 *   2. **Post-edit verification loop.** After an edit to a TS/JS file,
 *      `tsc --noEmit` runs automatically and any NEW errors in the
 *      edited file are appended to the tool result. The agent
 *      self-corrects in the same turn instead of discovering breakage
 *      turns later. Based on the LangChain pattern that lifted their
 *      Terminal Bench 2.0 score from 52.8% to 66.5%.
 *
 *   3. **Loop detection.** Tracks per-file edit counts within a session.
 *      After N edits to the same file (default 5) the agent sees a
 *      nudge suggesting it reconsider its approach.
 *
 *   4. **Read deduplication.** Tracks file content hashes within a
 *      session. When a file is re-read and hasn't changed, the output
 *      is replaced with a short pointer to the earlier read, saving
 *      potentially thousands of tokens.
 *
 * All four concerns share per-session state and are orchestrated from a
 * single `tool.execute.after` handler so only one hook registration is
 * needed.
 *
 * Configuration (via plugin options in opencode.json):
 *
 *   "plugin": [["@glrs-dev/harness-opencode", {
 *     "toolHooks": {
 *       backpressure: {
 *         enabled: true,        // default
 *         threshold: 2000,      // chars — outputs above this get truncated
 *         headChars: 300,       // chars preserved at the start
 *         tailChars: 200,       // chars preserved at the end
 *         tools: ["bash", "read", "glob", "grep"],
 *       },
 *       verifyLoop: {
 *         enabled: true,        // default
 *         timeoutMs: 15000,     // tsc timeout
 *       },
 *       loopDetection: {
 *         enabled: true,        // default
 *         threshold: 5,         // edits before first warning
 *       },
 *       readDedup: {
 *         enabled: true,        // default
 *       },
 *     }
 *   }
 */

import type { Plugin, Config, PluginOptions } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { parseTscOutput, dedupeAndCap, formatRow } from "../tools/tsc_check.js";

const exec = promisify(execFileCb);

// ---- Constants & defaults -------------------------------------------------

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const DEFAULT_BACKPRESSURE_THRESHOLD = 6000;
const DEFAULT_BACKPRESSURE_HEAD = 300;
const DEFAULT_BACKPRESSURE_TAIL = 200;
const DEFAULT_BACKPRESSURE_TOOLS = new Set(["bash", "read", "glob", "grep"]);

type BackpressureShape = "skip" | "head-tail" | "tail" | "head-with-count";

const DEFAULT_PER_TOOL_SHAPES: Record<string, BackpressureShape> = {
  read: "skip", // Read has its own limit/offset; double-truncation violates that contract.
  glob: "skip", // glob output is a path list; middle-truncation makes it unusable.
  bash: "tail", // Failures and exit codes are at the end of the stream.
  grep: "head-with-count", // First N matches verbatim + count tail; middle-truncation breaks match blocks.
};

// For head-with-count: keep the first N complete match blocks.
// Block separator is a blank line (\n\n) which matches ripgrep/grep default output.
const DEFAULT_GREP_HEAD_MATCHES = 20;

// For "tail" shape, bash is high-value per char — use a larger tail budget.
const DEFAULT_BASH_TAIL_CHARS = 4000;

const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;
const TSC_MAX_BUFFER = 2 * 1024 * 1024;
const VERIFY_MAX_ERRORS = 10;

const DEFAULT_LOOP_THRESHOLD = 5;

// ---- Per-session state ----------------------------------------------------

interface ReadCacheEntry {
  hash: string;
  callSeq: number;
}

interface SessionState {
  editCounts: Map<string, number>;
  readCache: Map<string, ReadCacheEntry>;
  callSeq: number;
  lastVerifyTs: number;
  directory: string | null;
}

const sessions = new Map<string, SessionState>();

function getSession(sessionID: string): SessionState {
  let s = sessions.get(sessionID);
  if (!s) {
    s = {
      editCounts: new Map(),
      readCache: new Map(),
      callSeq: 0,
      lastVerifyTs: 0,
      directory: null,
    };
    sessions.set(sessionID, s);
  }
  s.callSeq++;
  return s;
}

// ---- Configuration --------------------------------------------------------

interface ToolHooksConfig {
  backpressure: {
    enabled: boolean;
    threshold: number;
    headChars: number;
    tailChars: number;
    tools: Set<string>;
    perTool: Record<
      string,
      {
        threshold?: number;
        headChars?: number;
        tailChars?: number;
        shape: BackpressureShape;
        grepHeadMatches?: number;
      }
    >;
  };
  verifyLoop: {
    enabled: boolean;
    timeoutMs: number;
  };
  loopDetection: {
    enabled: boolean;
    threshold: number;
  };
  readDedup: {
    enabled: boolean;
  };
}

function isValidShape(s: unknown): s is BackpressureShape {
  return (
    s === "skip" || s === "head-tail" || s === "tail" || s === "head-with-count"
  );
}

function resolveConfig(config: Config, pluginOptions?: PluginOptions): ToolHooksConfig {
  // Prefer plugin options; fall back to legacy top-level harness key.
  const raw = (pluginOptions?.toolHooks ??
    (config as any).harness?.toolHooks ?? {}) as Record<string, any>;
  const bp = raw.backpressure ?? {};
  const vl = raw.verifyLoop ?? {};
  const ld = raw.loopDetection ?? {};
  const rd = raw.readDedup ?? {};

  // Build perTool: defaults merged with user per-tool overrides.
  const userPerTool =
    bp.perTool && typeof bp.perTool === "object" ? bp.perTool : {};
  const perTool: ToolHooksConfig["backpressure"]["perTool"] = {};
  for (const tool of ["bash", "read", "glob", "grep"]) {
    const u = (userPerTool as Record<string, any>)[tool] ?? {};
    perTool[tool] = {
      threshold: typeof u.threshold === "number" ? u.threshold : undefined,
      headChars: typeof u.headChars === "number" ? u.headChars : undefined,
      tailChars: typeof u.tailChars === "number" ? u.tailChars : undefined,
      shape: isValidShape(u.shape)
        ? u.shape
        : DEFAULT_PER_TOOL_SHAPES[tool] ?? "head-tail",
      grepHeadMatches:
        typeof u.grepHeadMatches === "number" ? u.grepHeadMatches : undefined,
    };
  }

  return {
    backpressure: {
      enabled: bp.enabled !== false,
      threshold: typeof bp.threshold === "number" ? bp.threshold : DEFAULT_BACKPRESSURE_THRESHOLD,
      headChars: typeof bp.headChars === "number" ? bp.headChars : DEFAULT_BACKPRESSURE_HEAD,
      tailChars: typeof bp.tailChars === "number" ? bp.tailChars : DEFAULT_BACKPRESSURE_TAIL,
      tools: Array.isArray(bp.tools)
        ? new Set(bp.tools)
        : DEFAULT_BACKPRESSURE_TOOLS,
      perTool,
    },
    verifyLoop: {
      enabled: vl.enabled !== false,
      timeoutMs:
        typeof vl.timeoutMs === "number" ? vl.timeoutMs : DEFAULT_VERIFY_TIMEOUT_MS,
    },
    loopDetection: {
      enabled: ld.enabled !== false,
      threshold:
        typeof ld.threshold === "number" ? ld.threshold : DEFAULT_LOOP_THRESHOLD,
    },
    readDedup: {
      enabled: rd.enabled !== false,
    },
  };
}

// ---- Helpers --------------------------------------------------------------

function getToolOutputDir(): string {
  const stateHome =
    process.env["XDG_STATE_HOME"] ||
    path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "harness-opencode", "tool-output");
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function extractFilePath(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const o = args as Record<string, unknown>;
  if (typeof o.filePath === "string") return o.filePath;
  if (typeof o.path === "string") return o.path;
  if (typeof o.file === "string") return o.file;
  return null;
}

/**
 * Heuristic: does the bash output look like a failure?
 * Conservative — uncertain cases are treated as failures so output
 * is preserved.
 */
function looksLikeBashFailure(output: string): boolean {
  // OpenCode's bash tool typically appends exit code info
  // Check for common failure indicators
  if (/Exit code:\s*[1-9]\d*/i.test(output)) return true;
  if (/\bexited with code [1-9]/i.test(output)) return true;
  if (/\bcommand failed\b/i.test(output)) return true;
  if (/\bERROR\b/.test(output) && output.length < 500) return true;
  // Short outputs are unlikely to need backpressure anyway
  return false;
}

/**
 * Resolve the session's working directory via the client API (cached).
 */
async function resolveSessionDir(
  client: OpencodeClient,
  sess: SessionState,
  sessionID: string,
): Promise<string> {
  if (sess.directory) return sess.directory;
  try {
    const r = await client.session.get({ path: { id: sessionID } });
    const data = r.data as { directory?: string } | undefined;
    sess.directory = data?.directory ?? process.cwd();
  } catch {
    sess.directory = process.cwd();
  }
  return sess.directory;
}

// ---- Backpressure ---------------------------------------------------------

/** Returns true if `filePath` is within the plugin's tool-output spill dir. */
function isUnderToolOutputDir(filePath: string): boolean {
  try {
    const abs = path.resolve(filePath);
    const spillDir = path.resolve(getToolOutputDir());
    // Simple prefix check — spillDir never ends in trailing slash from path.join.
    return abs === spillDir || abs.startsWith(spillDir + path.sep);
  } catch {
    return false;
  }
}

/**
 * Split a grep-style output into match blocks (blank-line separated),
 * keep the first `maxMatches`, and return the head + count of omitted.
 * Blocks are rejoined with the same \n\n separator they were split on.
 */
function takeGrepHead(
  text: string,
  maxMatches: number,
): { head: string; matchesKept: number; matchesOmitted: number } {
  const blocks = text.split(/\n\n+/);
  if (blocks.length <= maxMatches) {
    return { head: text, matchesKept: blocks.length, matchesOmitted: 0 };
  }
  const kept = blocks.slice(0, maxMatches);
  return {
    head: kept.join("\n\n"),
    matchesKept: kept.length,
    matchesOmitted: blocks.length - maxMatches,
  };
}

function applyBackpressure(
  cfg: ToolHooksConfig["backpressure"],
  toolName: string,
  callID: string,
  output: { output: string },
  args?: unknown,
): void {
  if (!cfg.enabled) return;
  if (!cfg.tools.has(toolName)) return;

  const perTool = cfg.perTool[toolName];
  const shape: BackpressureShape = perTool?.shape ?? "head-tail";

  // Shape "skip" — never truncate this tool's output.
  if (shape === "skip") return;

  // Recovery-read bypass: reading a spill file must never re-truncate.
  if (toolName === "read") {
    const fp = extractFilePath(args);
    if (fp && isUnderToolOutputDir(fp)) return;
  }

  const text = output.output;
  const threshold = perTool?.threshold ?? cfg.threshold;
  if (text.length <= threshold) return;

  // Bash-failure bypass stays FIRST among truncation paths.
  if (toolName === "bash" && looksLikeBashFailure(text)) return;

  // Write full output to disk
  let diskPath: string | null = null;
  try {
    const dir = getToolOutputDir();
    fs.mkdirSync(dir, { recursive: true });
    diskPath = path.join(dir, `${callID}.txt`);
    fs.writeFileSync(diskPath, text);
  } catch {
    // Disk write failed — fall back to in-memory truncation only.
  }

  const pathNote = diskPath ? ` Full output saved to: ${diskPath}` : "";

  if (shape === "tail") {
    const tailChars =
      perTool?.tailChars ??
      (toolName === "bash" ? DEFAULT_BASH_TAIL_CHARS : cfg.tailChars);
    const tail = text.slice(-tailChars);
    const omitted = text.length - tail.length;
    output.output = `... [${omitted} chars truncated — ${text.length} total.${pathNote}]\n\n${tail}`;
    return;
  }

  if (shape === "head-with-count") {
    const maxMatches = perTool?.grepHeadMatches ?? DEFAULT_GREP_HEAD_MATCHES;
    const { head, matchesOmitted } = takeGrepHead(text, maxMatches);
    if (matchesOmitted === 0) {
      // Fewer blocks than limit — fall back to plain head/tail.
      const fallbackHead = text.slice(0, perTool?.headChars ?? cfg.headChars);
      const fallbackTail = text.slice(-(perTool?.tailChars ?? cfg.tailChars));
      const omitted =
        text.length - fallbackHead.length - fallbackTail.length;
      output.output = `${fallbackHead}\n\n... [${omitted} chars truncated — ${text.length} total.${pathNote}]\n\n${fallbackTail}`;
      return;
    }
    const spillNote = diskPath ? ` — full output at ${diskPath}` : "";
    output.output = `${head}\n\n... [${matchesOmitted} more matches${spillNote}]`;
    return;
  }

  // Default shape "head-tail" (current behavior).
  const headChars = perTool?.headChars ?? cfg.headChars;
  const tailChars = perTool?.tailChars ?? cfg.tailChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - headChars - tailChars;
  output.output = `${head}\n\n... [${omitted} chars truncated — ${text.length} total.${pathNote}]\n\n${tail}`;
}

// ---- Verification loop ----------------------------------------------------

async function runPostEditVerify(
  cfg: ToolHooksConfig["verifyLoop"],
  client: OpencodeClient,
  sess: SessionState,
  sessionID: string,
  filePath: string,
  output: { output: string },
): Promise<void> {
  if (!cfg.enabled) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!TS_EXTENSIONS.has(ext)) return;

  // Debounce: skip if we verified < 2s ago
  const now = Date.now();
  if (now - sess.lastVerifyTs < 2000) return;
  sess.lastVerifyTs = now;

  const cwd = await resolveSessionDir(client, sess, sessionID);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    let raw: string;
    try {
      const { stdout, stderr } = await exec(
        "npx",
        ["tsc", "--noEmit", "--pretty", "false"],
        {
          maxBuffer: TSC_MAX_BUFFER,
          cwd,
          encoding: "utf8",
          signal: controller.signal,
        },
      );
      raw = String(stdout || "");
      if (stderr) raw += `\n${String(stderr)}`;
    } catch (err) {
      const e = err as { stdout?: string; killed?: boolean; code?: string };
      if (e.killed || e.code === "ABORT_ERR") return; // timeout — skip silently
      raw = String(e.stdout || "");
    } finally {
      clearTimeout(timer);
    }

    if (!raw.trim()) return; // clean

    const errors = parseTscOutput(raw);
    // Filter to only errors in the edited file
    const normPath = path.resolve(cwd, filePath);
    const fileErrors = errors.filter((e) => {
      const errPath = path.isAbsolute(e.file)
        ? e.file
        : path.resolve(cwd, e.file);
      return path.normalize(errPath) === path.normalize(normPath);
    });

    if (fileErrors.length === 0) return; // clean for this file

    const { rows } = dedupeAndCap(fileErrors, VERIFY_MAX_ERRORS);
    const lines = rows.map(formatRow);

    output.output +=
      `\n\n--- POST-EDIT DIAGNOSTICS (${fileErrors.length} error${fileErrors.length !== 1 ? "s" : ""} in ${path.basename(filePath)}) ---\n` +
      lines.join("\n") +
      `\n--- Fix these before proceeding ---`;
  } catch {
    // Any unexpected error — skip verification silently.
    // Never let verification break the edit operation.
  }
}

// ---- Loop detection -------------------------------------------------------

function checkEditLoop(
  cfg: ToolHooksConfig["loopDetection"],
  sess: SessionState,
  filePath: string,
  output: { output: string },
): void {
  if (!cfg.enabled) return;

  const count = (sess.editCounts.get(filePath) ?? 0) + 1;
  sess.editCounts.set(filePath, count);

  // Warn at threshold, then at every multiple of threshold
  if (count >= cfg.threshold && count % cfg.threshold === 0) {
    output.output +=
      `\n\n--- LOOP WARNING ---\n` +
      `You've edited ${path.basename(filePath)} ${count} times this session. ` +
      `Consider reconsidering your approach — are you stuck in a loop? ` +
      `Step back and think about whether a different strategy would be more effective.\n` +
      `---`;
  }
}

// ---- Read dedup -----------------------------------------------------------

function checkReadDedup(
  cfg: ToolHooksConfig["readDedup"],
  sess: SessionState,
  filePath: string | null,
  output: { output: string },
): boolean {
  if (!cfg.enabled) return false;
  if (!filePath) return false;

  const hash = hashContent(output.output);
  const cached = sess.readCache.get(filePath);

  if (cached && cached.hash === hash) {
    // Content unchanged — replace with pointer
    output.output =
      `[File unchanged since tool call #${cached.callSeq}. ` +
      `Content identical (hash: ${hash}). See earlier read for full text.]`;
    return true;
  }

  // First read or content changed — cache and pass through
  sess.readCache.set(filePath, { hash, callSeq: sess.callSeq });
  return false;
}

// ---- Plugin entry ---------------------------------------------------------

let pluginConfig: ToolHooksConfig | null = null;
let storedPluginOptions: PluginOptions | undefined;

const plugin: Plugin = async ({ client }, options) => {
  storedPluginOptions = options;
  return {
    config: async (config: Config) => {
      pluginConfig = resolveConfig(config, storedPluginOptions);
    },

    "tool.execute.after": async (input, output) => {
      // Config may not yet be resolved on the very first tool call
      // (race between config hook and first tool execution). Use
      // defaults if so.
      const cfg = pluginConfig ?? resolveConfig({} as Config, storedPluginOptions);
      const sess = getSession(input.sessionID);

      const toolName = input.tool;

      // 1. Read dedup (runs before backpressure — dedup replaces the
      //    entire output, so backpressure on the replacement is moot)
      if (toolName === "read") {
        const fp = extractFilePath(input.args);
        const deduped = checkReadDedup(cfg.readDedup, sess, fp, output);
        if (deduped) return; // output already replaced
      }

      // 2. Edit-related hooks (verify loop + loop detection)
      if (EDIT_TOOLS.has(toolName)) {
        const fp = extractFilePath(input.args);
        if (fp) {
          // Loop detection (sync, cheap)
          checkEditLoop(cfg.loopDetection, sess, fp, output);
          // Verification loop (async, may append diagnostics)
          await runPostEditVerify(
            cfg.verifyLoop,
            client as OpencodeClient,
            sess,
            input.sessionID,
            fp,
            output,
          );
        }
      }

      // 3. Backpressure (runs last — truncates after verify loop has
      //    had a chance to append diagnostics to edit output)
      applyBackpressure(cfg.backpressure, toolName, input.callID, output, input.args);
    },
  };
};

export default plugin;

// ---- Test exports ---------------------------------------------------------

export const __test__ = {
  getSession,
  sessions,
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
  EDIT_TOOLS,
  TS_EXTENSIONS,
  DEFAULT_BACKPRESSURE_THRESHOLD,
  DEFAULT_LOOP_THRESHOLD,
  DEFAULT_PER_TOOL_SHAPES,
  DEFAULT_GREP_HEAD_MATCHES,
  DEFAULT_BASH_TAIL_CHARS,
};
