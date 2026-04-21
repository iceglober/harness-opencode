import type { ToolDefinition } from "@opencode-ai/plugin";
import astGrepTool from "./ast_grep.js";
import tscCheckTool from "./tsc_check.js";
import eslintCheckTool from "./eslint_check.js";
import todoScanTool from "./todo_scan.js";
import commentCheckTool from "./comment_check.js";

export function createTools(): Record<string, ToolDefinition> {
  return {
    ast_grep: astGrepTool,
    tsc_check: tscCheckTool,
    eslint_check: eslintCheckTool,
    todo_scan: todoScanTool,
    comment_check: commentCheckTool,
  };
}
