import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export default tool({
  description:
    "Scan files for TODO / FIXME / HACK / XXX comments. Returns a structured list " +
    "of matches (file:line:type:text). Use `onlyChanged: true` to restrict to files " +
    "changed vs HEAD — useful for QA review to catch tech debt introduced in the " +
    "current change. Returns plain-text output, one match per line.",
  args: {
    paths: tool.schema
      .array(tool.schema.string())
      .default(["."])
      .describe("Files or directories to scan (ignored if onlyChanged is true)"),
    onlyChanged: tool.schema
      .boolean()
      .default(false)
      .describe("If true, scan only files modified vs HEAD (git diff --name-only)"),
    types: tool.schema
      .array(tool.schema.enum(["TODO", "FIXME", "HACK", "XXX"]))
      .default(["TODO", "FIXME", "HACK", "XXX"])
      .describe("Annotation types to look for"),
    maxResults: tool.schema
      .number()
      .default(200)
      .describe("Cap on number of matches returned"),
  },
  async execute(args, context) {
    let scanPaths: string[] = args.paths;

    if (args.onlyChanged) {
      try {
        const { stdout } = await exec(
          "git",
          ["diff", "--name-only", "HEAD"],
          { cwd: context.directory, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
        );
        scanPaths = String(stdout).split("\n").filter(Boolean);
        if (scanPaths.length === 0) return "(no changed files)";
      } catch (err) {
        const e = err as { message: string };
        return `git diff failed: ${e.message}`;
      }
    }

    const pattern = `(${args.types.join("|")})\\b`;
    const rgArgs = [
      "--line-number",
      "--no-heading",
      "--color=never",
      "-e",
      pattern,
      ...scanPaths,
    ];

    try {
      const { stdout } = await exec("rg", rgArgs, {
        cwd: context.directory,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const lines = String(stdout).split("\n").filter(Boolean);
      const capped = lines.slice(0, args.maxResults);
      const suffix =
        lines.length > args.maxResults
          ? `\n\n[truncated: ${lines.length - args.maxResults} additional matches — narrow paths or raise maxResults]`
          : "";
      return capped.length > 0
        ? capped.join("\n") + suffix
        : `(no ${args.types.join("/")} matches in scanned paths)`;
    } catch (err) {
      const e = err as { code?: number; message: string };
      // ripgrep exits 1 when there are no matches — not an error for us
      if (e.code === 1) return `(no ${args.types.join("/")} matches in scanned paths)`;
      return `rg error: ${e.message}`;
    }
  },
});
