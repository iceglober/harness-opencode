import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export default tool({
  description:
    "Search or rewrite TypeScript/JavaScript/Python/etc. by AST pattern using ast-grep. " +
    "Use this instead of grep when you need structural matching: function signatures, " +
    "JSX patterns, import shapes, decorator usage, etc. Patterns use $VAR for captures.",
  args: {
    pattern: tool.schema
      .string()
      .describe(
        "ast-grep pattern, e.g. 'console.log($MSG)' or 'function $NAME($$$ARGS) { $$$BODY }'",
      ),
    rewrite: tool.schema
      .string()
      .optional()
      .describe(
        "If set, rewrites matches to this template. Use $VAR to reference captures.",
      ),
    paths: tool.schema
      .array(tool.schema.string())
      .default(["."])
      .describe("Files or directories to search"),
    language: tool.schema
      .enum(["ts", "tsx", "js", "jsx", "py", "go", "rs"])
      .optional()
      .describe("Language hint; auto-detected by extension if omitted"),
    dryRun: tool.schema
      .boolean()
      .default(true)
      .describe("If false and rewrite is set, applies changes to disk"),
  },
  async execute(args, context) {
    const cmdArgs: string[] = ["run", "--pattern", args.pattern];
    if (args.rewrite) cmdArgs.push("--rewrite", args.rewrite);
    if (args.language) cmdArgs.push("--lang", args.language);
    if (args.rewrite && !args.dryRun) cmdArgs.push("--update-all");
    cmdArgs.push(...args.paths);

    try {
      const { stdout, stderr } = await exec("ast-grep", cmdArgs, {
        maxBuffer: 10 * 1024 * 1024,
        cwd: context.directory,
        encoding: "utf8",
      });
      const out = String(stdout || "(no matches)");
      const warn = stderr ? `\n[warnings]\n${String(stderr)}` : "";
      return out + warn;
    } catch (err) {
      const e = err as { message: string; stderr?: string };
      return `ast-grep error: ${e.message}${e.stderr ? "\n" + e.stderr : ""}`;
    }
  },
});
