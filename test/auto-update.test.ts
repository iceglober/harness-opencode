import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  inspectCachePin,
  refreshPluginCache,
  readOurPackageVersion,
  PACKAGE_NAME,
  getOpenCodeCachePackageDir,
} from "../src/auto-update.js";

/**
 * Auto-update tests use a throwaway cache dir under $TMPDIR so we never
 * mutate the user's real OpenCode cache when running tests.
 */

let tmpCacheDir = "";

function makeTmpCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harness-opencode-test-"));
}

beforeEach(() => {
  tmpCacheDir = makeTmpCacheDir();
});

afterEach(() => {
  if (tmpCacheDir) {
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
    tmpCacheDir = "";
  }
  delete process.env["HARNESS_OPENCODE_AUTO_UPDATE"];
});

function writeCachePin(dir: string, version: string, opts: { withLock?: boolean; withNodeModules?: boolean } = {}) {
  const pkgJson = {
    name: `${PACKAGE_NAME}@latest`,
    dependencies: { [PACKAGE_NAME]: version },
  };
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
    "utf8",
  );
  if (opts.withLock !== false) {
    const lock = {
      name: `${PACKAGE_NAME}@latest`,
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { [PACKAGE_NAME]: version } },
        [`node_modules/${PACKAGE_NAME}`]: {
          version,
          resolved: `https://registry.npmjs.org/${PACKAGE_NAME}/-/harness-opencode-${version}.tgz`,
          integrity: "sha512-OLD-OLD-OLD==",
        },
      },
    };
    fs.writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify(lock, null, 2),
      "utf8",
    );
  }
  if (opts.withNodeModules) {
    const nm = path.join(dir, "node_modules", "@glrs-dev", "harness-opencode");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  }
}

describe("getOpenCodeCachePackageDir", () => {
  it("resolves to the OpenCode packages path under cache home", () => {
    const dir = getOpenCodeCachePackageDir();
    expect(dir).toContain(path.join("opencode", "packages"));
    expect(dir).toContain("@glrs-dev");
    expect(dir).toContain("harness-opencode@latest");
  });

  it("honours XDG_CACHE_HOME when set", () => {
    const prev = process.env["XDG_CACHE_HOME"];
    process.env["XDG_CACHE_HOME"] = "/custom/cache";
    try {
      const dir = getOpenCodeCachePackageDir();
      expect(dir.startsWith("/custom/cache")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["XDG_CACHE_HOME"];
      else process.env["XDG_CACHE_HOME"] = prev;
    }
  });
});

describe("inspectCachePin", () => {
  it("returns 'missing' when the cache dir has no package.json", async () => {
    const result = await inspectCachePin(tmpCacheDir);
    expect(result.kind).toBe("missing");
  });

  it("returns 'exact' for a pure semver pin", async () => {
    writeCachePin(tmpCacheDir, "0.1.2");
    const result = await inspectCachePin(tmpCacheDir);
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.version).toBe("0.1.2");
  });

  it("returns 'non-exact' for a caret range", async () => {
    fs.writeFileSync(
      path.join(tmpCacheDir, "package.json"),
      JSON.stringify({ dependencies: { [PACKAGE_NAME]: "^0.6.0" } }),
    );
    const result = await inspectCachePin(tmpCacheDir);
    expect(result.kind).toBe("non-exact");
    if (result.kind === "non-exact") expect(result.spec).toBe("^0.6.0");
  });

  it("returns 'not-our-package' when the pinned dep is a different name", async () => {
    fs.writeFileSync(
      path.join(tmpCacheDir, "package.json"),
      JSON.stringify({ name: "some-other-pkg", dependencies: { foo: "1.0.0" } }),
    );
    const result = await inspectCachePin(tmpCacheDir);
    expect(result.kind).toBe("not-our-package");
  });

  it("returns 'missing' when package.json is malformed JSON", async () => {
    fs.writeFileSync(path.join(tmpCacheDir, "package.json"), "{not json");
    const result = await inspectCachePin(tmpCacheDir);
    expect(result.kind).toBe("missing");
  });
});

describe("refreshPluginCache", () => {
  it("no-ops when HARNESS_OPENCODE_AUTO_UPDATE=0", async () => {
    process.env["HARNESS_OPENCODE_AUTO_UPDATE"] = "0";
    writeCachePin(tmpCacheDir, "0.1.2");
    const result = await refreshPluginCache("0.1.2", "0.6.0", {
      cacheDir: tmpCacheDir,
    });
    expect(result.outcome).toBe("disabled");
    // package.json should still have the old version
    const pkgRaw = fs.readFileSync(path.join(tmpCacheDir, "package.json"), "utf8");
    expect(pkgRaw).toContain("0.1.2");
    expect(pkgRaw).not.toContain("0.6.0");
  });

  it("reports 'already-current' when running version equals latest", async () => {
    writeCachePin(tmpCacheDir, "0.6.0");
    const result = await refreshPluginCache("0.6.0", "0.6.0", {
      cacheDir: tmpCacheDir,
    });
    expect(result.outcome).toBe("already-current");
  });

  it("reports 'cache-missing' when the cache dir has no pin", async () => {
    const result = await refreshPluginCache("0.1.2", "0.6.0", {
      cacheDir: tmpCacheDir, // empty dir
    });
    expect(result.outcome).toBe("cache-missing");
  });

  it("reports 'non-exact-pin' and does not rewrite when user uses a range spec", async () => {
    fs.writeFileSync(
      path.join(tmpCacheDir, "package.json"),
      JSON.stringify({ dependencies: { [PACKAGE_NAME]: "^0.6.0" } }, null, 2),
    );
    const result = await refreshPluginCache("0.1.2", "0.6.0", {
      cacheDir: tmpCacheDir,
    });
    expect(result.outcome).toBe("non-exact-pin");
    const pkgRaw = fs.readFileSync(path.join(tmpCacheDir, "package.json"), "utf8");
    expect(pkgRaw).toContain("^0.6.0");
  });

  it("reports 'already-current' when cache is already pinned to the new version", async () => {
    writeCachePin(tmpCacheDir, "0.6.0");
    const result = await refreshPluginCache("0.1.2", "0.6.0", {
      cacheDir: tmpCacheDir,
    });
    expect(result.outcome).toBe("already-current");
    expect(result.toVersion).toBe("0.6.0");
  });

  it("returns 'refreshed' without writing in dry-run mode", async () => {
    writeCachePin(tmpCacheDir, "0.1.2");
    const result = await refreshPluginCache("0.1.2", "0.6.0", {
      cacheDir: tmpCacheDir,
      dryRun: true,
    });
    expect(result.outcome).toBe("refreshed");
    expect(result.fromVersion).toBe("0.1.2");
    expect(result.toVersion).toBe("0.6.0");
    // Nothing actually written
    const pkgRaw = fs.readFileSync(path.join(tmpCacheDir, "package.json"), "utf8");
    expect(pkgRaw).toContain("0.1.2");
  });

  it("rewrites package.json and lockfile and removes node_modules on real refresh", async () => {
    writeCachePin(tmpCacheDir, "0.1.2", { withNodeModules: true });
    const nmPath = path.join(tmpCacheDir, "node_modules");
    expect(fs.existsSync(nmPath)).toBe(true);

    const result = await refreshPluginCache("0.1.2", "0.6.0", {
      cacheDir: tmpCacheDir,
    });
    expect(result.outcome).toBe("refreshed");

    // package.json now pins 0.6.0
    const pkg = JSON.parse(
      fs.readFileSync(path.join(tmpCacheDir, "package.json"), "utf8"),
    );
    expect(pkg.dependencies[PACKAGE_NAME]).toBe("0.6.0");

    // lockfile updated and stale resolved/integrity stripped
    const lock = JSON.parse(
      fs.readFileSync(path.join(tmpCacheDir, "package-lock.json"), "utf8"),
    );
    expect(lock.packages[""].dependencies[PACKAGE_NAME]).toBe("0.6.0");
    const nmEntry = lock.packages[`node_modules/${PACKAGE_NAME}`];
    expect(nmEntry.version).toBe("0.6.0");
    expect(nmEntry.resolved).toBeUndefined();
    expect(nmEntry.integrity).toBeUndefined();

    // node_modules removed
    expect(fs.existsSync(nmPath)).toBe(false);
  });

  it("handles missing lockfile gracefully (writes only package.json)", async () => {
    writeCachePin(tmpCacheDir, "0.1.2", { withLock: false });
    const result = await refreshPluginCache("0.1.2", "0.6.0", {
      cacheDir: tmpCacheDir,
    });
    expect(result.outcome).toBe("refreshed");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(tmpCacheDir, "package.json"), "utf8"),
    );
    expect(pkg.dependencies[PACKAGE_NAME]).toBe("0.6.0");
  });

  it("deletes malformed lockfile rather than corrupting further", async () => {
    writeCachePin(tmpCacheDir, "0.1.2");
    // Corrupt the lockfile
    fs.writeFileSync(path.join(tmpCacheDir, "package-lock.json"), "{garbage");
    const result = await refreshPluginCache("0.1.2", "0.6.0", {
      cacheDir: tmpCacheDir,
    });
    expect(result.outcome).toBe("refreshed");
    // Lockfile should be gone — next install rebuilds it
    expect(fs.existsSync(path.join(tmpCacheDir, "package-lock.json"))).toBe(false);
  });
});

describe("readOurPackageVersion", () => {
  it("reads a semver string matching package.json", () => {
    // When invoked from src/auto-update.ts (test-time), should find the repo package.json.
    // Use the import.meta.url of the auto-update module indirectly by constructing a
    // similar URL. Easier: just check it returns a non-fallback value when invoked
    // with the test file's URL, which lives under test/.
    const version = readOurPackageVersion(import.meta.url);
    expect(typeof version).toBe("string");
    // Should match the repo's current package.json — read it directly for comparison.
    const pkgRaw = fs.readFileSync(
      path.join(process.cwd(), "package.json"),
      "utf8",
    );
    const pkg = JSON.parse(pkgRaw) as { version: string };
    expect(version).toBe(pkg.version);
  });

  it("falls back to 0.0.0 when no package.json is found", () => {
    // Pass a bogus file URL that won't find anything upward.
    const version = readOurPackageVersion("file:///nonexistent/deep/path/foo.js");
    expect(version).toBe("0.0.0");
  });
});
