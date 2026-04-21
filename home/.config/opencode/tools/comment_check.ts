import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEFAULT_TYPES = ["TODO", "FIXME", "HACK", "XXX", "DEPRECATED"] as const;

export default tool({
  description:
    "Find attributed code annotations like @TODO(alice), @FIXME, @HACK, @XXX, " +
    "@DEPRECATED. Returns structured matches with author if captured, plus " +
    "optional age-in-days via git blame. Use this before planning or editing " +
    "an area to inventory known tech debt.",
  args: {
    paths: tool.schema
      .array(tool.schema.string())
      .default(["."])
      .describe("Files or directories to scan"),
    types: tool.schema
      .array(tool.schema.string())
      .default([...DEFAULT_TYPES])
      .describe("Annotation types to surface (e.g. TODO, FIXME, HACK, DEPRECATED)"),
    includeAge: tool.schema
      .boolean()
      .default(false)
      .describe(
        "If true, run git blame per match to determine age in days (slow on large result sets)",
      ),
    maxResults: tool.schema
      .number()
      .default(30)
      .describe("Cap on matches returned (default reduced from 100 to 30 to limit context flooding)"),
  },
  async execute(args, context) {
    const typesAlt = args.types.join("|");
    const pattern = `@(${typesAlt})(\\(([^)]+)\\))?`;
    const rgArgs = [
      "--line-number",
      "--no-heading",
      "--color=never",
      "-e",
      pattern,
      ...args.paths,
    ];

    let raw: string;
    try {
      const { stdout } = await exec("rg", rgArgs, {
        cwd: context.directory,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      raw = String(stdout);
    } catch (err) {
      const e = err as { code?: number; message: string };
      if (e.code === 1) return "(no annotations found)";
      return `rg error: ${e.message}`;
    }

    const annotRe = new RegExp(`@(${typesAlt})(?:\\(([^)]+)\\))?`);
    const lineRe = /^(.+?):(\d+):(.*)$/;

    // Collect ALL matches first (not capped mid-loop), then sort + cap.
    // This allows age-based sort when includeAge:true so the oldest
    // debt surfaces first — you care most about stale TODOs, not fresh
    // ones from this session.
    interface Row {
      text: string;
      ageDays: number; // -1 when age not computed
    }
    const rows: Row[] = [];
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.match(lineRe);
      if (!parts) continue;
      const [, file, lineStr, text] = parts;
      const am = text.match(annotRe);
      if (!am) continue;
      const type = am[1];
      const author = am[2] ?? "";
      let age = "";
      let ageDays = -1;
      if (args.includeAge) {
        try {
          const { stdout: blame } = await exec(
            "git",
            ["log", "-1", "--format=%ct", "-L", `${lineStr},${lineStr}:${file}`],
            { cwd: context.directory, encoding: "utf8", maxBuffer: 1024 * 1024 },
          );
          const ts = parseInt(String(blame).trim().split("\n")[0] ?? "", 10);
          if (!Number.isNaN(ts)) {
            ageDays = Math.floor((Date.now() / 1000 - ts) / 86400);
            age = ` (${ageDays}d old)`;
          }
        } catch {
          // blame can fail for newly added lines; non-fatal
        }
      }
      const authorPart = author ? ` [${author}]` : "";
      rows.push({
        text: `${file}:${lineStr} @${type}${authorPart}${age} — ${text.trim().slice(0, 200)}`,
        ageDays,
      });
    }

    if (rows.length === 0) return "(no annotations found)";

    // Age-sort desc when age data is present (i.e., includeAge was true).
    // Rows whose blame failed (ageDays=-1) sort to the end.
    if (args.includeAge) {
      rows.sort((a, b) => {
        if (a.ageDays === -1 && b.ageDays === -1) return 0;
        if (a.ageDays === -1) return 1;
        if (b.ageDays === -1) return -1;
        return b.ageDays - a.ageDays;
      });
    }

    const capped = rows.slice(0, args.maxResults);
    const truncated =
      rows.length > args.maxResults
        ? `\n\n[truncated: ${rows.length - args.maxResults} more]`
        : "";
    return capped.map((r) => r.text).join("\n") + truncated;
  },
});
