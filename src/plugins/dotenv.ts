/**
 * Minimal dotenv loader — reads `.env` and `.env.local` into `process.env`
 * at plugin-init time so that OpenCode's `{env:VAR}` MCP config
 * interpolation resolves project-local secrets without a shell-side
 * `source .env` ritual.
 *
 * Load order: `.env` first, then `.env.local` (local overrides base).
 * Shell-env wins: a variable already present in `process.env` is never
 * overwritten.
 *
 * No external dependencies — inline parser only.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DOTENV_FILES = [".env", ".env.local"] as const;

/**
 * Parse a dotenv-formatted string into a key-value map.
 *
 * Supports:
 *   - Blank lines and `#` comment lines (skipped)
 *   - `KEY=value`
 *   - `KEY="double quoted"` / `KEY='single quoted'`
 *   - `KEY=` (empty value)
 *   - `export KEY=value` prefix
 *   - Inline comments on unquoted values (`KEY=val # comment`)
 *   - Leading/trailing whitespace trimming on keys and unquoted values
 *
 * Silently ignores malformed lines (no `=` sign).
 */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Strip optional `export ` prefix
    if (line.startsWith("export ")) {
      line = line.slice(7).trimStart();
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue; // malformed — no `=`

    const key = line.slice(0, eq).trim();
    if (!key) continue; // empty key after trim

    let val = line.slice(eq + 1);

    // Detect quoted values
    const trimmedVal = val.trimStart();
    if (
      (trimmedVal.startsWith('"') && trimmedVal.endsWith('"')) ||
      (trimmedVal.startsWith("'") && trimmedVal.endsWith("'"))
    ) {
      // Quoted — strip quotes, preserve inner content (including `#`)
      val = trimmedVal.slice(1, -1);
    } else {
      // Unquoted — strip inline comments and trim
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) {
        val = val.slice(0, hashIdx);
      }
      val = val.trim();
    }

    out[key] = val;
  }

  return out;
}

export interface LoadDotenvResult {
  filesLoaded: string[];
  varsSet: number;
}

/**
 * Load `.env` and `.env.local` from `directory` into `process.env`.
 *
 * - `.env` is parsed first, then `.env.local`. For duplicate keys across
 *   files, `.env.local` wins (it's parsed second and overwrites the
 *   merged map).
 * - A variable already present in `process.env` is never overwritten
 *   (shell-env-wins precedence).
 * - Missing files are silently skipped.
 *
 * Uses synchronous I/O (`readFileSync`) so the caller doesn't need to
 * await — env vars are guaranteed to be set before the function returns.
 */
export function loadDotenv(directory: string): LoadDotenvResult {
  const merged: Record<string, string> = {};
  const filesLoaded: string[] = [];

  for (const name of DOTENV_FILES) {
    const filePath = path.join(directory, name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      // File doesn't exist or isn't readable — skip silently
      continue;
    }

    const parsed = parseDotenv(content);
    // Merge: later files (.env.local) override earlier (.env)
    Object.assign(merged, parsed);
    filesLoaded.push(name);
  }

  // Apply to process.env — shell-env wins
  let varsSet = 0;
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in process.env)) {
      process.env[key] = value;
      varsSet++;
    }
  }

  return { filesLoaded, varsSet };
}
