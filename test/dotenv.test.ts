import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { parseDotenv, loadDotenv } from "../src/plugins/dotenv.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

describe("parseDotenv", () => {
  it("returns empty record for blank input", () => {
    expect(parseDotenv("")).toEqual({});
    expect(parseDotenv("   \n\n  \n")).toEqual({});
  });

  it("skips comment lines", () => {
    expect(parseDotenv("# this is a comment\n# another")).toEqual({});
  });

  it("parses KEY=value", () => {
    expect(parseDotenv("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("parses multiple keys", () => {
    expect(parseDotenv("A=1\nB=2\nC=3")).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("handles double-quoted values", () => {
    expect(parseDotenv('KEY="hello world"')).toEqual({ KEY: "hello world" });
  });

  it("handles single-quoted values", () => {
    expect(parseDotenv("KEY='hello world'")).toEqual({ KEY: "hello world" });
  });

  it("handles empty value", () => {
    expect(parseDotenv("KEY=")).toEqual({ KEY: "" });
  });

  it("strips inline comments on unquoted values", () => {
    expect(parseDotenv("KEY=value # this is a comment")).toEqual({
      KEY: "value",
    });
  });

  it("preserves # inside double quotes", () => {
    expect(parseDotenv('KEY="value # not a comment"')).toEqual({
      KEY: "value # not a comment",
    });
  });

  it("preserves # inside single quotes", () => {
    expect(parseDotenv("KEY='value # not a comment'")).toEqual({
      KEY: "value # not a comment",
    });
  });

  it("strips export prefix", () => {
    expect(parseDotenv("export FOO=bar")).toEqual({ FOO: "bar" });
    expect(parseDotenv("export  FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("trims whitespace on keys and unquoted values", () => {
    expect(parseDotenv("  KEY  =  value  ")).toEqual({ KEY: "value" });
  });

  it("ignores lines without =", () => {
    expect(parseDotenv("NOEQUALS\nKEY=val")).toEqual({ KEY: "val" });
  });

  it("accepts keys with dots, underscores, and digits", () => {
    expect(parseDotenv("MY.VAR_2=x")).toEqual({ "MY.VAR_2": "x" });
  });

  it("handles mixed content", () => {
    const input = [
      "# Database config",
      "DB_HOST=localhost",
      "DB_PORT=5432",
      "",
      "# API keys",
      'API_KEY="sk-abc123"',
      "export SECRET=hunter2",
      "EMPTY=",
      "INLINE=value # comment",
      "MALFORMED_LINE",
    ].join("\n");

    expect(parseDotenv(input)).toEqual({
      DB_HOST: "localhost",
      DB_PORT: "5432",
      API_KEY: "sk-abc123",
      SECRET: "hunter2",
      EMPTY: "",
      INLINE: "value",
    });
  });

  it("handles Windows-style line endings", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

// ---------------------------------------------------------------------------
// Loader integration tests
// ---------------------------------------------------------------------------

describe("loadDotenv", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  // Track which env vars we set so we can clean up
  const trackedKeys = new Set<string>();

  function trackEnvKey(key: string) {
    if (!trackedKeys.has(key)) {
      savedEnv[key] = process.env[key];
      trackedKeys.add(key);
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-test-"));
  });

  afterEach(() => {
    // Restore process.env
    for (const key of trackedKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    trackedKeys.clear();

    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads .env and sets vars", () => {
    const key = `DOTENV_TEST_A_${Date.now()}`;
    trackEnvKey(key);

    fs.writeFileSync(path.join(tmpDir, ".env"), `${key}=1`);

    const result = loadDotenv(tmpDir);
    expect(result.filesLoaded).toEqual([".env"]);
    expect(result.varsSet).toBe(1);
    expect(process.env[key]).toBe("1");
  });

  it(".env.local overrides .env for the same key", () => {
    const keyA = `DOTENV_TEST_OVR_${Date.now()}`;
    const keyB = `DOTENV_TEST_B_${Date.now()}`;
    trackEnvKey(keyA);
    trackEnvKey(keyB);

    fs.writeFileSync(path.join(tmpDir, ".env"), `${keyA}=1\n${keyB}=2`);
    fs.writeFileSync(path.join(tmpDir, ".env.local"), `${keyA}=override`);

    const result = loadDotenv(tmpDir);
    expect(result.filesLoaded).toEqual([".env", ".env.local"]);
    expect(process.env[keyA]).toBe("override");
    expect(process.env[keyB]).toBe("2");
  });

  it("shell-env wins — does not overwrite existing process.env", () => {
    const key = `DOTENV_TEST_EXISTING_${Date.now()}`;
    trackEnvKey(key);

    process.env[key] = "shell";
    fs.writeFileSync(path.join(tmpDir, ".env"), `${key}=dotenv`);

    const result = loadDotenv(tmpDir);
    expect(result.varsSet).toBe(0);
    expect(process.env[key]).toBe("shell");
  });

  it("returns empty result when no .env files exist", () => {
    const result = loadDotenv(tmpDir);
    expect(result.filesLoaded).toEqual([]);
    expect(result.varsSet).toBe(0);
  });

  it("loads only .env.local when .env is missing", () => {
    const key = `DOTENV_TEST_LOCAL_${Date.now()}`;
    trackEnvKey(key);

    fs.writeFileSync(path.join(tmpDir, ".env.local"), `${key}=local`);

    const result = loadDotenv(tmpDir);
    expect(result.filesLoaded).toEqual([".env.local"]);
    expect(result.varsSet).toBe(1);
    expect(process.env[key]).toBe("local");
  });
});
