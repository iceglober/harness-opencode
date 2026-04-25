/**
 * Load a `pilot.yaml` file from disk and produce a typed `Plan`.
 *
 * This module is the boundary between "raw bytes on disk" and "in-memory
 * validated plan". Everything downstream (`dag.ts`, `globs.ts`, the
 * worker, the CLI) operates on `Plan` instances; loading is the single
 * spot that touches `fs` and parses YAML.
 *
 * Error envelopes are uniform across failure modes (file-not-found, YAML
 * parse error, schema validation error) so callers (`pilot validate`,
 * `pilot build`) can render the same way regardless of which layer
 * complained. Each failure has a `kind` discriminator and a stable
 * `errors` array of `{ path, message }` for the schema-validation layer
 * (or a single-element array for fs/yaml failures, with `path = "<file>"`).
 *
 * What this module does NOT do:
 *   - Slug derivation: `slug.ts`.
 *   - DAG / glob validation: `dag.ts`, `globs.ts`. The loader returns a
 *     schema-valid `Plan` and stops there. `pilot validate` runs the
 *     extra validators afterward.
 *   - Filesystem layout choices for plans dir: `paths.ts` (Phase A5).
 *
 * Ship-checklist alignment: Phase A2 of `PILOT_TODO.md`.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { parsePlan, type Plan } from "./schema.js";

// --- Public types ----------------------------------------------------------

/**
 * Successful load: validated, typed plan ready for DAG/glob checks.
 */
export type LoadOk = { ok: true; plan: Plan; absPath: string };

/**
 * Loader error envelope. `kind` lets the CLI render appropriate
 * boilerplate (`File not found:` vs `YAML parse error:` vs schema-issue
 * list).
 */
export type LoadErr =
  | {
      ok: false;
      kind: "fs";
      absPath: string;
      errors: Array<{ path: string; message: string }>;
    }
  | {
      ok: false;
      kind: "yaml";
      absPath: string;
      errors: Array<{ path: string; message: string }>;
    }
  | {
      ok: false;
      kind: "schema";
      absPath: string;
      errors: Array<{ path: string; message: string }>;
    };

export type LoadResult = LoadOk | LoadErr;

// --- Public API ------------------------------------------------------------

/**
 * Load and validate a plan from a filesystem path. Path may be relative;
 * it's resolved to absolute against process.cwd() before any IO.
 *
 * Failure modes:
 *   - `kind: "fs"`     — file missing, permission denied, EISDIR, etc.
 *   - `kind: "yaml"`   — content present but not valid YAML.
 *   - `kind: "schema"` — YAML parsed to a JS value but it doesn't match
 *                        `PlanSchema`.
 *
 * Returns a discriminated union; callers branch on `result.ok`.
 *
 * The loader does NOT throw for any expected failure; only the
 * caller-bug cases (`absPath` not a string) bubble up as exceptions.
 */
export async function loadPlan(absPath: string): Promise<LoadResult> {
  if (typeof absPath !== "string") {
    throw new TypeError(`loadPlan: expected string path, got ${typeof absPath}`);
  }
  const resolved = path.resolve(absPath);

  // --- Step 1: read bytes ---------------------------------------------
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    return {
      ok: false,
      kind: "fs",
      absPath: resolved,
      errors: [{ path: "<file>", message: errorMessage(err) }],
    };
  }

  // --- Step 2: parse YAML ---------------------------------------------
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    // The `yaml` package throws YAMLParseError with line/col info. Render
    // it inline so the caller doesn't have to inspect the error object.
    let msg: string;
    if (err instanceof YAMLParseError) {
      const pos = err.linePos?.[0];
      const where = pos ? ` (line ${pos.line}, col ${pos.col})` : "";
      msg = `YAML parse error${where}: ${err.message}`;
    } else {
      msg = `YAML parse error: ${errorMessage(err)}`;
    }
    return {
      ok: false,
      kind: "yaml",
      absPath: resolved,
      errors: [{ path: "<file>", message: msg }],
    };
  }

  // YAML can legally parse to `null`/`undefined` (empty file or bare `~`).
  // Treat that as a yaml-level error rather than letting Zod produce a
  // confusing `expected object, received null` — we want the user to
  // know their file is empty.
  if (parsed === null || parsed === undefined) {
    return {
      ok: false,
      kind: "yaml",
      absPath: resolved,
      errors: [
        {
          path: "<file>",
          message: "YAML parsed to null — the file is empty or contains only `~`/null",
        },
      ],
    };
  }

  // --- Step 3: schema validate ----------------------------------------
  const result = parsePlan(parsed);
  if (!result.ok) {
    return {
      ok: false,
      kind: "schema",
      absPath: resolved,
      errors: result.errors,
    };
  }

  return { ok: true, plan: result.plan, absPath: resolved };
}

// --- Helpers ---------------------------------------------------------------

/**
 * Extract a printable message from an unknown thrown value. Mirrors the
 * `errorMessage` helper used elsewhere in the harness — every spot that
 * narrows `unknown` to a message string.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
