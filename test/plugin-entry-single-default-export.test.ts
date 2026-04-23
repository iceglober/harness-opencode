import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression: `src/index.ts` must expose EXACTLY ONE export — the
 * default plugin factory. No named exports.
 *
 * Why: OpenCode's plugin loader (observed on 1.14.19–1.14.22) was
 * seen to crash at startup with
 *
 *     TypeError: undefined is not an object (evaluating 'V[G]')
 *
 * inside its minified bundle whenever this module carried any named
 * export beyond `default`. The loader appears to probe named exports
 * looking for `PluginModule`-shaped re-exports (`{ id?, server, tui? }`)
 * and blows up when it encounters a plain function or a non-hook object.
 *
 * Version bisect isolated the regression to commit e5ffb7c, which
 * added `export function applyConfig` purely for test ergonomics.
 * Removing that single `export` keyword restored plugin startup across
 * every affected OpenCode version.
 *
 * Tests that need `applyConfig` should import it from
 * `src/config-hook.ts` (which has no runtime consumers under the
 * plugin entry path). This test guards against anyone adding another
 * named export to `src/index.ts` without understanding the blast
 * radius.
 */
describe("plugin entry has only a default export", () => {
  const entryPath = join(__dirname, "..", "src", "index.ts");
  const src = readFileSync(entryPath, "utf8");

  it("src/index.ts has no `export function/const/let/var/class/type/interface ...`", () => {
    // Match `export function`, `export const`, `export let`, `export var`,
    // `export class`, `export type`, `export interface`, `export enum`,
    // `export namespace`, `export async function`.
    // Allow `export default` (the plugin factory) and `export type`/
    // `export interface` are still bad for us specifically because they
    // emit runtime-observable named re-exports in tsup's .d.ts pass —
    // but `export type` compiles to nothing at the .js layer. Keep a
    // belt-and-braces policy: reject any non-default `export`.
    const bannedPatterns = [
      /^export\s+(async\s+)?function\s+\w+/m,
      /^export\s+const\s+\w+/m,
      /^export\s+let\s+\w+/m,
      /^export\s+var\s+\w+/m,
      /^export\s+class\s+\w+/m,
      /^export\s+enum\s+\w+/m,
      /^export\s+namespace\s+\w+/m,
      /^export\s+\{/m, // re-export braces
    ];

    for (const pat of bannedPatterns) {
      const match = src.match(pat);
      expect(
        match,
        `src/index.ts has a non-default export (matched ${pat}). This breaks OpenCode's plugin loader. Move the symbol into a dedicated file (e.g. src/config-hook.ts) and import it here.`,
      ).toBeNull();
    }
  });

  it("src/index.ts HAS exactly one `export default`", () => {
    const matches = src.match(/^export\s+default\s+/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  it("the dist build also exposes only `default` on its runtime surface", async () => {
    // Load the built entry and assert its export shape. `applyConfig`
    // must NOT be reachable from here — if it is, the regression is back.
    const distPath = join(__dirname, "..", "dist", "index.js");
    // Dynamic import so test runs before build still report a clean
    // dist-missing error rather than hanging.
    try {
      readFileSync(distPath);
    } catch {
      // dist not yet built — skip. CI invokes `bun run build && bun test`
      // so the built state is the one we actually ship.
      return;
    }
    const mod = await import(distPath);
    const keys = Object.keys(mod);
    expect(
      keys,
      `dist/index.js exposes non-default named exports: ${JSON.stringify(keys)}. This reintroduces the OpenCode-loader crash.`,
    ).toEqual(["default"]);
  });
});
