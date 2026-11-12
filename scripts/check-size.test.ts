import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeFootprint,
  isExcludedSource,
  LIMIT_BYTES,
  measureProductionDependencies,
  measureSourceBytes,
  runSizeCheck,
} from "./check-size.mjs";

interface FixtureFileSpec {
  json?: Record<string, unknown>;
  text?: string;
  size?: number;
}

interface WorkspaceFootprintFixture {
  pnpmWorkspaceYaml: string;
  trackedFiles: string[];
  files: Record<string, FixtureFileSpec>;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECK_SIZE_SCRIPT = path.join(SCRIPT_DIR, "check-size.mjs");
const FIXTURE_SPEC_PATH = path.join(SCRIPT_DIR, "fixtures", "workspace-footprint.json");

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vervecv-size-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeText(rootDir: string, relativePath: string, content: string): number {
  const fullPath = path.join(rootDir, ...relativePath.split("/"));
  mkdirSync(path.dirname(fullPath), { recursive: true });
  const bytes = Buffer.from(content, "utf8");
  writeFileSync(fullPath, bytes);
  return bytes.byteLength;
}

function writeJson(rootDir: string, relativePath: string, value: unknown): number {
  return writeText(rootDir, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSizedFile(rootDir: string, relativePath: string, sizeBytes: number): number {
  const fullPath = path.join(rootDir, ...relativePath.split("/"));
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, "");
  truncateSync(fullPath, sizeBytes);
  return sizeBytes;
}

function linkDirectory(targetDir: string, linkPath: string): void {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(targetDir, linkPath, "junction");
}

function materializeCommittedFixture(): {
  rootDir: string;
  fixture: WorkspaceFootprintFixture;
} {
  const fixture = JSON.parse(readFileSync(FIXTURE_SPEC_PATH, "utf8")) as WorkspaceFootprintFixture;
  const rootDir = createTempWorkspace();
  writeText(rootDir, "pnpm-workspace.yaml", fixture.pnpmWorkspaceYaml);

  for (const [relativePath, spec] of Object.entries(fixture.files)) {
    if (spec.json !== undefined) {
      writeJson(rootDir, relativePath, spec.json);
    } else if (spec.text !== undefined) {
      writeText(rootDir, relativePath, spec.text);
    } else if (spec.size !== undefined) {
      writeSizedFile(rootDir, relativePath, spec.size);
    }
  }

  return { rootDir, fixture };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("check-size production dependency and source accounting", () => {
  it("measures nested dependencies, workspace transitive deps, and excludes devDependencies and artifacts", () => {
    const { rootDir, fixture } = materializeCommittedFixture();

    const report = analyzeFootprint({
      rootDir,
      trackedFiles: fixture.trackedFiles,
    });

    const names = report.dependencies.map((item) => `${item.name}@${item.version}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "pkg-alpha@1.0.0",
        "pkg-nested-beta@2.0.0",
        "pkg-deep-gamma@3.1.0",
        "pkg-bundled-helper@0.4.0",
        "pkg-shared-runtime@1.2.0",
      ]),
    );
    expect(report.dependencies).toHaveLength(5);

    expect(names).not.toContain("@fixture/shared@0.0.0");
    expect(names).not.toContain("dev-only-linter@1.0.0");
    expect(names).not.toContain("dev-test-runner@3.0.0");

    const expectedDepBytes = [
      "node_modules/pkg-alpha/package.json",
      "node_modules/pkg-alpha/index.js",
      "node_modules/pkg-alpha/node_modules/pkg-nested-beta/package.json",
      "node_modules/pkg-alpha/node_modules/pkg-nested-beta/index.js",
      "node_modules/pkg-alpha/node_modules/pkg-nested-beta/node_modules/pkg-deep-gamma/package.json",
      "node_modules/pkg-alpha/node_modules/pkg-nested-beta/node_modules/pkg-deep-gamma/index.js",
      "node_modules/pkg-alpha/node_modules/pkg-bundled-helper/package.json",
      "node_modules/pkg-alpha/node_modules/pkg-bundled-helper/index.js",
      "node_modules/pkg-shared-runtime/package.json",
      "node_modules/pkg-shared-runtime/index.js",
    ].reduce((sum, rel) => sum + statSync(path.join(rootDir, ...rel.split("/"))).size, 0);

    expect(report.dependencyBytes).toBe(expectedDepBytes);

    const expectedSourceBytes = [
      "package.json",
      "pnpm-workspace.yaml",
      "apps/api/package.json",
      "apps/api/src/index.ts",
      "packages/shared/package.json",
      "packages/shared/src/index.ts",
    ].reduce((sum, rel) => sum + statSync(path.join(rootDir, ...rel.split("/"))).size, 0);

    expect(report.sourceBytes).toBe(expectedSourceBytes);
    expect(report.backendArtifactBytes).toBe(4096);
    expect(report.frontendBundleBytes).toBeNull();
    expect(report.exceeded).toBe(false);
    expect(report.limitBytes).toBe(LIMIT_BYTES);
  });

  it("deduplicates pnpm virtual-store symlinks, counts only the matching platform optional binary, and honors ignoredOptionalDependencies", () => {
    const rootDir = createTempWorkspace();
    writeText(
      rootDir,
      "pnpm-workspace.yaml",
      'packages:\n  - "apps/*"\nignoredOptionalDependencies:\n  - "@napi-rs/canvas"\n',
    );
    writeJson(rootDir, "package.json", {
      name: "pnpm-fixture",
      private: true,
      devDependencies: {
        typescript: "5.9.3",
      },
    });
    writeJson(rootDir, "apps/api/package.json", {
      name: "@fixture/api",
      version: "0.0.0",
      dependencies: {
        "shared-core": "1.0.0",
        "@vendor/hasher": "2.0.0",
      },
    });
    writeJson(rootDir, "apps/web/package.json", {
      name: "@fixture/web",
      version: "0.0.0",
      dependencies: {
        "shared-core": "1.0.0",
      },
    });

    const sharedStoreDir = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "shared-core@1.0.0_peer-dep@1.0.0",
      "node_modules",
      "shared-core",
    );
    const sharedManifestBytes = writeJson(
      rootDir,
      "node_modules/.pnpm/shared-core@1.0.0_peer-dep@1.0.0/node_modules/shared-core/package.json",
      {
        name: "shared-core",
        version: "1.0.0",
        optionalDependencies: {
          "@napi-rs/canvas": "1.1.1",
        },
        peerDependencies: {
          "peer-dep": "^1.0.0",
          "@electric-sql/pglite": "^0.5.0",
          typescript: "^5.0.0",
        },
        peerDependenciesMeta: {
          "@electric-sql/pglite": { optional: true },
        },
      },
    );
    const sharedCodeBytes = writeSizedFile(
      rootDir,
      "node_modules/.pnpm/shared-core@1.0.0_peer-dep@1.0.0/node_modules/shared-core/index.js",
      1200,
    );

    // Ignored optional dependency present on disk -> must be skipped
    const canvasStoreDir = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "@napi-rs+canvas@1.1.1",
      "node_modules",
      "@napi-rs",
      "canvas",
    );
    writeJson(
      rootDir,
      "node_modules/.pnpm/@napi-rs+canvas@1.1.1/node_modules/@napi-rs/canvas/package.json",
      { name: "@napi-rs/canvas", version: "1.1.1" },
    );
    writeSizedFile(
      rootDir,
      "node_modules/.pnpm/@napi-rs+canvas@1.1.1/node_modules/@napi-rs/canvas/canvas.node",
      500_000,
    );
    linkDirectory(
      canvasStoreDir,
      path.join(
        rootDir,
        "node_modules",
        ".pnpm",
        "shared-core@1.0.0_peer-dep@1.0.0",
        "node_modules",
        "@napi-rs",
        "canvas",
      ),
    );

    const peerStoreDir = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "peer-dep@1.0.0",
      "node_modules",
      "peer-dep",
    );
    const peerManifestBytes = writeJson(
      rootDir,
      "node_modules/.pnpm/peer-dep@1.0.0/node_modules/peer-dep/package.json",
      { name: "peer-dep", version: "1.0.0" },
    );
    const peerCodeBytes = writeSizedFile(
      rootDir,
      "node_modules/.pnpm/peer-dep@1.0.0/node_modules/peer-dep/index.js",
      600,
    );
    linkDirectory(
      peerStoreDir,
      path.join(
        rootDir,
        "node_modules",
        ".pnpm",
        "shared-core@1.0.0_peer-dep@1.0.0",
        "node_modules",
        "peer-dep",
      ),
    );

    const optionalDevPeerStoreDir = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "@electric-sql+pglite@0.5.16",
      "node_modules",
      "@electric-sql",
      "pglite",
    );
    writeJson(
      rootDir,
      "node_modules/.pnpm/@electric-sql+pglite@0.5.16/node_modules/@electric-sql/pglite/package.json",
      { name: "@electric-sql/pglite", version: "0.5.16" },
    );
    writeSizedFile(
      rootDir,
      "node_modules/.pnpm/@electric-sql+pglite@0.5.16/node_modules/@electric-sql/pglite/pglite.wasm",
      250_000,
    );
    linkDirectory(
      optionalDevPeerStoreDir,
      path.join(
        rootDir,
        "node_modules",
        ".pnpm",
        "shared-core@1.0.0_peer-dep@1.0.0",
        "node_modules",
        "@electric-sql",
        "pglite",
      ),
    );

    writeJson(rootDir, "node_modules/typescript/package.json", {
      name: "typescript",
      version: "5.9.3",
    });
    writeSizedFile(rootDir, "node_modules/typescript/tsc.js", 90_000);

    const hasherStoreDir = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "@vendor+hasher@2.0.0",
      "node_modules",
      "@vendor",
      "hasher",
    );
    const hasherManifestBytes = writeJson(
      rootDir,
      "node_modules/.pnpm/@vendor+hasher@2.0.0/node_modules/@vendor/hasher/package.json",
      {
        name: "@vendor/hasher",
        version: "2.0.0",
        optionalDependencies: {
          "@vendor/hasher-linux-x64": "2.0.0",
          "@vendor/hasher-darwin-arm64": "2.0.0",
        },
      },
    );
    const hasherJsBytes = writeSizedFile(
      rootDir,
      "node_modules/.pnpm/@vendor+hasher@2.0.0/node_modules/@vendor/hasher/index.js",
      250,
    );

    const linuxStoreDir = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "@vendor+hasher-linux-x64@2.0.0",
      "node_modules",
      "@vendor",
      "hasher-linux-x64",
    );
    const linuxManifestBytes = writeJson(
      rootDir,
      "node_modules/.pnpm/@vendor+hasher-linux-x64@2.0.0/node_modules/@vendor/hasher-linux-x64/package.json",
      { name: "@vendor/hasher-linux-x64", version: "2.0.0", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
    );
    const linuxBinBytes = writeSizedFile(
      rootDir,
      "node_modules/.pnpm/@vendor+hasher-linux-x64@2.0.0/node_modules/@vendor/hasher-linux-x64/hasher.node",
      4096,
    );

    const darwinStoreDir = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "@vendor+hasher-darwin-arm64@2.0.0",
      "node_modules",
      "@vendor",
      "hasher-darwin-arm64",
    );
    writeJson(
      rootDir,
      "node_modules/.pnpm/@vendor+hasher-darwin-arm64@2.0.0/node_modules/@vendor/hasher-darwin-arm64/package.json",
      { name: "@vendor/hasher-darwin-arm64", version: "2.0.0", os: ["darwin"], cpu: ["arm64"] },
    );
    writeSizedFile(
      rootDir,
      "node_modules/.pnpm/@vendor+hasher-darwin-arm64@2.0.0/node_modules/@vendor/hasher-darwin-arm64/hasher.node",
      8192,
    );

    linkDirectory(
      linuxStoreDir,
      path.join(
        rootDir,
        "node_modules",
        ".pnpm",
        "@vendor+hasher@2.0.0",
        "node_modules",
        "@vendor",
        "hasher-linux-x64",
      ),
    );
    linkDirectory(
      darwinStoreDir,
      path.join(
        rootDir,
        "node_modules",
        ".pnpm",
        "@vendor+hasher@2.0.0",
        "node_modules",
        "@vendor",
        "hasher-darwin-arm64",
      ),
    );
    linkDirectory(sharedStoreDir, path.join(rootDir, "apps", "api", "node_modules", "shared-core"));
    linkDirectory(sharedStoreDir, path.join(rootDir, "apps", "web", "node_modules", "shared-core"));
    linkDirectory(
      hasherStoreDir,
      path.join(rootDir, "apps", "api", "node_modules", "@vendor", "hasher"),
    );

    const packages = measureProductionDependencies(rootDir, {
      platform: "linux",
      arch: "x64",
      libc: "glibc",
    });
    expect(packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      "@vendor/hasher-linux-x64@2.0.0",
      "shared-core@1.0.0",
      "peer-dep@1.0.0",
      "@vendor/hasher@2.0.0",
    ]);

    const totalDepBytes = packages.reduce((sum, pkg) => sum + pkg.bytes, 0);
    expect(totalDepBytes).toBe(
      sharedManifestBytes +
        sharedCodeBytes +
        peerManifestBytes +
        peerCodeBytes +
        hasherManifestBytes +
        hasherJsBytes +
        linuxManifestBytes +
        linuxBinBytes,
    );
  });

  it("fails closed when a required production dependency is missing or broken", () => {
    const rootDir = createTempWorkspace();
    writeText(rootDir, "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n');
    writeJson(rootDir, "package.json", { name: "missing-dep-fixture", private: true });
    writeJson(rootDir, "apps/api/package.json", {
      name: "@fixture/api",
      version: "0.0.0",
      dependencies: {
        "not-installed-prod-pkg": "^1.0.0",
      },
    });

    expect(() => measureProductionDependencies(rootDir)).toThrow(
      /Missing installed production dependency "not-installed-prod-pkg"/,
    );
  });

  it("fails closed when a transitive production dependency has corrupt package.json", () => {
    const rootDir = createTempWorkspace();
    writeJson(rootDir, "package.json", {
      name: "corrupt-manifest-fixture",
      private: true,
      dependencies: {
        "broken-pkg": "1.0.0",
      },
    });
    writeText(rootDir, "node_modules/broken-pkg/package.json", "{ invalid json");

    expect(() => measureProductionDependencies(rootDir)).toThrow(/Invalid JSON/);
  });

  it("reports failure and exits non-zero from CLI when footprint exceeds 100 MiB", () => {
    const rootDir = createTempWorkspace();
    execFileSync("git", ["init", "-q"], { cwd: rootDir });
    writeJson(rootDir, "package.json", {
      name: "oversized-fixture",
      private: true,
      dependencies: {
        "huge-prod-pkg": "1.0.0",
      },
    });
    execFileSync("git", ["add", "package.json"], { cwd: rootDir });

    writeJson(rootDir, "node_modules/huge-prod-pkg/package.json", {
      name: "huge-prod-pkg",
      version: "1.0.0",
    });
    writeSizedFile(rootDir, "node_modules/huge-prod-pkg/weights.bin", LIMIT_BYTES + 1024);

    const logs: string[] = [];
    const errors: string[] = [];
    const inProcess = runSizeCheck({
      rootDir,
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
    });

    expect(inProcess.exceeded).toBe(true);
    expect(inProcess.exitCode).toBe(1);
    expect(errors).toContain("Size check failed: the approved footprint exceeds 100 MiB.");

    const cliResult = spawnSync(process.execPath, [CHECK_SIZE_SCRIPT], {
      cwd: rootDir,
      encoding: "utf8",
    });
    expect(cliResult.status).toBe(1);
    expect(cliResult.stderr).toContain("Size check failed: the approved footprint exceeds 100 MiB.");
  });

  it("excludes dist, fixtures, and tsbuildinfo paths from tracked source bytes", () => {
    expect(isExcludedSource("fixtures/sample.pdf")).toBe(true);
    expect(isExcludedSource("scripts/fixtures/workspace-footprint.json")).toBe(true);
    expect(isExcludedSource("apps/web/dist/index.js")).toBe(true);
    expect(isExcludedSource("apps/api/tsconfig.tsbuildinfo")).toBe(true);
    expect(isExcludedSource("apps/api/src/app.ts")).toBe(false);

    const rootDir = createTempWorkspace();
    const srcBytes = writeText(rootDir, "apps/api/src/app.ts", "export const x = 1;\n");
    writeSizedFile(rootDir, "apps/api/dist/app.js", 10_000);
    writeSizedFile(rootDir, "scripts/fixtures/data.bin", 20_000);

    expect(
      measureSourceBytes(rootDir, {
        trackedFiles: [
          "apps/api/src/app.ts",
          "apps/api/dist/app.js",
          "scripts/fixtures/data.bin",
        ],
      }),
    ).toBe(srcBytes);
  });
});
