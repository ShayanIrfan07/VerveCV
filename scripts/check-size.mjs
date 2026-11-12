import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LIMIT_BYTES = 104_857_600;

export function isExcludedSource(file) {
  const normalized = file.replaceAll("\\", "/");
  return (
    normalized.startsWith("fixtures/") ||
    normalized.includes("/fixtures/") ||
    normalized.startsWith("dist/") ||
    normalized.includes("/dist/") ||
    normalized.endsWith(".tsbuildinfo")
  );
}

export function listGitTrackedFiles(rootDir) {
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z"], {
      cwd: rootDir,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to list git-tracked source files in "${rootDir}": ${detail}`, {
      cause: error,
    });
  }
  return listed
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

export function measureSourceBytes(rootDir, options = {}) {
  const files = options.trackedFiles ?? listGitTrackedFiles(rootDir);
  let total = 0;
  for (const file of files) {
    if (file.length === 0 || isExcludedSource(file)) {
      continue;
    }
    const fullPath = path.join(rootDir, file);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to stat tracked source file "${file}": ${detail}`, { cause: error });
    }
    if (stats.isFile()) {
      total += stats.size;
    }
  }
  return total;
}

export function measureProductionDependencies(rootDir, options = {}) {
  const canonicalRoot = resolveExistingRealPath(rootDir, "workspace root");
  const targetPlatform = {
    os: options.platform ?? process.platform,
    cpu: options.arch ?? process.arch,
    libc: options.libc ?? detectRuntimeLibc(),
  };
  const { workspacesByRealPath, workspacesByName, ignoredOptionalDeps } =
    discoverWorkspaces(canonicalRoot);
  const visitedWorkspaces = new Set();
  const measuredByRealPath = new Map();

  function traverseWorkspace(workspace) {
    if (visitedWorkspaces.has(workspace.realDir)) {
      return;
    }
    visitedWorkspaces.add(workspace.realDir);

    const requiredDeps = asStringRecord(workspace.manifest.dependencies);
    for (const [depName, specifier] of Object.entries(requiredDeps)) {
      const target = resolveRequiredDependency(
        workspace.realDir,
        depName,
        specifier,
        canonicalRoot,
        workspacesByName,
        `workspace "${workspace.name}"`,
        true,
      );
      visitTarget(target, depName, false);
    }

    const optionalDeps = asStringRecord(workspace.manifest.optionalDependencies);
    for (const [depName, specifier] of Object.entries(optionalDeps)) {
      if (ignoredOptionalDeps.has(depName)) {
        continue;
      }
      const target = resolveOptionalDependency(
        workspace.realDir,
        depName,
        specifier,
        canonicalRoot,
        workspacesByName,
        workspacesByRealPath,
        false,
      );
      if (target !== null) {
        visitTarget(target, depName, true);
      }
    }
  }

  function visitTarget(realTargetDir, fallbackName, isOptionalBranch) {
    const matchedWorkspace = workspacesByRealPath.get(realTargetDir);
    if (matchedWorkspace !== undefined) {
      traverseWorkspace(matchedWorkspace);
      return;
    }

    if (measuredByRealPath.has(realTargetDir)) {
      return;
    }

    const manifest = readPackageManifest(realTargetDir);
    const pkgName =
      typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : fallbackName;

    if (isOptionalBranch) {
      if (ignoredOptionalDeps.has(pkgName)) {
        return;
      }
      if (!matchesPlatformConstraints(manifest, targetPlatform)) {
        return;
      }
    }

    const pkgVersion =
      typeof manifest.version === "string" && manifest.version.length > 0
        ? manifest.version
        : "unknown";
    const pkgLabel = `${pkgName}@${pkgVersion}`;

    const entry = {
      name: pkgName,
      version: pkgVersion,
      bytes: directorySize(realTargetDir),
      path: realTargetDir,
    };
    measuredByRealPath.set(realTargetDir, entry);

    const requiredDeps = asStringRecord(manifest.dependencies);
    for (const [depName, specifier] of Object.entries(requiredDeps)) {
      const child = resolveRequiredDependency(
        realTargetDir,
        depName,
        specifier,
        canonicalRoot,
        workspacesByName,
        pkgLabel,
        false,
      );
      visitTarget(child, depName, false);
    }

    const optionalDeps = asStringRecord(manifest.optionalDependencies);
    for (const [depName, specifier] of Object.entries(optionalDeps)) {
      if (ignoredOptionalDeps.has(depName)) {
        continue;
      }
      const child = resolveOptionalDependency(
        realTargetDir,
        depName,
        specifier,
        canonicalRoot,
        workspacesByName,
        workspacesByRealPath,
        false,
      );
      if (child !== null) {
        visitTarget(child, depName, true);
      }
    }

    const peerDeps = asStringRecord(manifest.peerDependencies);
    const peerMeta = asObjectRecord(manifest.peerDependenciesMeta);
    for (const [depName, specifier] of Object.entries(peerDeps)) {
      if (isOptionalPeer(peerMeta[depName])) {
        continue;
      }
      const child = resolveOptionalDependency(
        realTargetDir,
        depName,
        specifier,
        canonicalRoot,
        workspacesByName,
        workspacesByRealPath,
        true,
      );
      if (child !== null) {
        visitTarget(child, depName, false);
      }
    }

    for (const nestedPkg of listDirectNestedPackages(realTargetDir)) {
      const nestedIsOptional = Object.prototype.hasOwnProperty.call(
        optionalDeps,
        nestedPkg.fallbackName,
      );
      visitTarget(nestedPkg.realDir, nestedPkg.fallbackName, nestedIsOptional);
    }
  }

  for (const workspace of workspacesByRealPath.values()) {
    traverseWorkspace(workspace);
  }

  const packages = [...measuredByRealPath.values()];
  packages.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  return packages;
}

export function analyzeFootprint(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const limitBytes = options.limitBytes ?? LIMIT_BYTES;
  const sourceBytes = measureSourceBytes(rootDir, { trackedFiles: options.trackedFiles });
  const dependencies = measureProductionDependencies(rootDir, {
    platform: options.platform,
    arch: options.arch,
    libc: options.libc,
  });
  const dependencyBytes = dependencies.reduce((total, item) => total + item.bytes, 0);
  const totalBytes = sourceBytes + dependencyBytes;
  const headroomBytes = limitBytes - totalBytes;

  return {
    sourceBytes,
    dependencyBytes,
    totalBytes,
    limitBytes,
    headroomBytes,
    exceeded: totalBytes > limitBytes,
    dependencies,
    frontendBundleBytes: measureOptionalArtifact(path.join(rootDir, "apps", "web", "dist")),
    backendArtifactBytes: measureOptionalArtifact(path.join(rootDir, "apps", "api", "dist")),
  };
}

export function runSizeCheck(options = {}) {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;
  const report = analyzeFootprint(options);

  log("VerveCV source + production dependency footprint");
  log(`Source files:            ${formatBytes(report.sourceBytes)}`);
  log(`Production dependencies: ${formatBytes(report.dependencyBytes)}`);
  log(`Total:                   ${formatBytes(report.totalBytes)}`);
  log(`Limit:                   ${formatBytes(report.limitBytes)}`);
  log(`Headroom:                ${formatBytes(report.headroomBytes)}`);
  log("");
  log("20 largest production dependencies");
  for (const [index, item] of report.dependencies.slice(0, 20).entries()) {
    log(
      `${String(index + 1).padStart(2, " ")}. ${formatBytes(item.bytes).padStart(16, " ")}  ${item.name}@${item.version}`,
    );
  }

  logSeparateArtifact(log, "Frontend production bundle", report.frontendBundleBytes);
  logSeparateArtifact(log, "Backend deployment artifact", report.backendArtifactBytes);

  if (report.exceeded) {
    errorLog("Size check failed: the approved footprint exceeds 100 MiB.");
    return { ...report, exitCode: 1 };
  }

  return { ...report, exitCode: 0 };
}

export function formatBytes(bytes) {
  const sign = bytes < 0 ? "-" : "";
  const absolute = Math.abs(bytes);
  return `${sign}${absolute.toLocaleString("en-US")} B (${(absolute / 1024 / 1024).toFixed(2)} MiB)`;
}

function logSeparateArtifact(log, label, bytes) {
  if (bytes === null) {
    log(`${label}: not built`);
    return;
  }
  log(`${label} (reported separately, excluded from the 100 MiB gate): ${formatBytes(bytes)}`);
}

function measureOptionalArtifact(directory) {
  if (!existsSync(directory)) {
    return null;
  }
  const realDir = resolveExistingRealPath(directory, "build artifact directory");
  return directorySize(realDir);
}

function discoverWorkspaces(canonicalRoot) {
  const workspacesByRealPath = new Map();
  const workspacesByName = new Map();

  const rootManifest = readPackageManifest(canonicalRoot);
  const rootEntry = {
    name:
      typeof rootManifest.name === "string" && rootManifest.name.length > 0
        ? rootManifest.name
        : "root",
    version: typeof rootManifest.version === "string" ? rootManifest.version : "0.0.0",
    realDir: canonicalRoot,
    manifest: rootManifest,
  };
  workspacesByRealPath.set(canonicalRoot, rootEntry);
  workspacesByName.set(rootEntry.name, rootEntry);

  const { patterns, ignoredOptionalDeps } = readWorkspaceConfig(canonicalRoot, rootManifest);
  const includedDirs = new Set();
  const excludedRelative = new Set();

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      for (const dir of expandWorkspacePattern(canonicalRoot, pattern.slice(1))) {
        excludedRelative.add(normalizeSlashes(path.relative(canonicalRoot, dir)));
      }
      continue;
    }
    for (const dir of expandWorkspacePattern(canonicalRoot, pattern)) {
      includedDirs.add(dir);
    }
  }

  for (const dir of includedDirs) {
    const rel = normalizeSlashes(path.relative(canonicalRoot, dir));
    if (excludedRelative.has(rel)) {
      continue;
    }
    const manifestPath = path.join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const realDir = resolveExistingRealPath(dir, `workspace directory "${rel}"`);
    if (workspacesByRealPath.has(realDir)) {
      continue;
    }
    const manifest = readPackageManifest(realDir);
    const wsName =
      typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : rel;
    const wsEntry = {
      name: wsName,
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      realDir,
      manifest,
    };
    workspacesByRealPath.set(realDir, wsEntry);
    workspacesByName.set(wsName, wsEntry);
  }

  return { workspacesByRealPath, workspacesByName, ignoredOptionalDeps };
}

function readWorkspaceConfig(canonicalRoot, rootManifest) {
  const ignoredOptionalDeps = new Set();
  if (
    rootManifest.pnpm !== null &&
    typeof rootManifest.pnpm === "object" &&
    Array.isArray(rootManifest.pnpm.ignoredOptionalDependencies)
  ) {
    for (const item of rootManifest.pnpm.ignoredOptionalDependencies) {
      if (typeof item === "string" && item.length > 0) {
        ignoredOptionalDeps.add(item);
      }
    }
  }

  const pnpmWorkspacePath = path.join(canonicalRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmWorkspacePath)) {
    const yamlContent = readFileSync(pnpmWorkspacePath, "utf8");
    for (const ignored of parseYamlStringList(yamlContent, "ignoredOptionalDependencies")) {
      ignoredOptionalDeps.add(ignored);
    }
    const parsedPackages = parseYamlStringList(yamlContent, "packages");
    if (parsedPackages.length > 0) {
      return { patterns: parsedPackages.map(normalizeSlashes), ignoredOptionalDeps };
    }
  }

  if (Array.isArray(rootManifest.workspaces)) {
    return {
      patterns: rootManifest.workspaces.filter((item) => typeof item === "string" && item.length > 0),
      ignoredOptionalDeps,
    };
  }
  if (
    rootManifest.workspaces !== null &&
    typeof rootManifest.workspaces === "object" &&
    Array.isArray(rootManifest.workspaces.packages)
  ) {
    return {
      patterns: rootManifest.workspaces.packages.filter(
        (item) => typeof item === "string" && item.length > 0,
      ),
      ignoredOptionalDeps,
    };
  }

  return { patterns: ["apps/*", "packages/*"], ignoredOptionalDeps };
}

function parseYamlStringList(yamlContent, keyName) {
  const values = [];
  let inSection = false;
  const headerRegex = new RegExp(`^${keyName}\\s*:\\s*$`, "u");

  for (const rawLine of yamlContent.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    if (!inSection) {
      if (headerRegex.test(rawLine)) {
        inSection = true;
      }
      continue;
    }
    if (!/^\s+/u.test(rawLine)) {
      break;
    }
    const match = /^\s*-\s*(.+?)\s*$/u.exec(rawLine);
    if (!match) {
      continue;
    }
    const rawValue = match[1];
    if (rawValue === undefined) {
      continue;
    }
    const unquoted = stripQuotes(stripInlineYamlComment(rawValue)).trim();
    if (unquoted.length > 0) {
      values.push(unquoted);
    }
  }

  return values;
}

function stripInlineYamlComment(value) {
  if (value.startsWith('"') || value.startsWith("'")) {
    return value;
  }
  const commentIndex = value.indexOf(" #");
  return commentIndex === -1 ? value : value.slice(0, commentIndex);
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function matchesPlatformConstraints(manifest, targetPlatform) {
  if (!matchesConstraintArray(manifest.os, targetPlatform.os)) {
    return false;
  }
  if (!matchesConstraintArray(manifest.cpu, targetPlatform.cpu)) {
    return false;
  }
  if (targetPlatform.os === "linux" && !matchesConstraintArray(manifest.libc, targetPlatform.libc)) {
    return false;
  }
  return true;
}

function matchesConstraintArray(rawField, currentValue) {
  if (!Array.isArray(rawField) || rawField.length === 0) {
    return true;
  }
  const entries = rawField.filter((item) => typeof item === "string" && item.length > 0);
  if (entries.length === 0) {
    return true;
  }
  const positives = entries.filter((item) => !item.startsWith("!"));
  const negatives = entries.filter((item) => item.startsWith("!")).map((item) => item.slice(1));
  if (negatives.includes(currentValue)) {
    return false;
  }
  if (positives.length > 0 && !positives.includes(currentValue)) {
    return false;
  }
  return true;
}

function detectRuntimeLibc() {
  if (process.platform !== "linux") {
    return "glibc";
  }
  const report = process.report?.getReport?.();
  if (
    report &&
    typeof report === "object" &&
    "header" in report &&
    report.header &&
    typeof report.header === "object" &&
    "glibcVersionRuntime" in report.header &&
    typeof report.header.glibcVersionRuntime === "string"
  ) {
    return "glibc";
  }
  return "musl";
}

function expandWorkspacePattern(rootDir, rawPattern) {
  const segments = normalizeSlashes(rawPattern)
    .replace(/\/+$/u, "")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");

  let currentDirs = [rootDir];
  for (const segment of segments) {
    const nextDirs = [];
    for (const currentDir of currentDirs) {
      if (!existsSync(currentDir)) {
        continue;
      }
      if (segment === "*") {
        for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            nextDirs.push(path.join(currentDir, entry.name));
          }
        }
      } else {
        const candidate = path.join(currentDir, segment);
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          nextDirs.push(candidate);
        }
      }
    }
    currentDirs = nextDirs;
  }

  return currentDirs;
}

function resolveRequiredDependency(
  fromDir,
  depName,
  specifier,
  canonicalRoot,
  workspacesByName,
  requesterLabel,
  allowWorkspaceProtocol,
) {
  const resolved = resolveFromNodeModulesChain(fromDir, depName, canonicalRoot, null);
  if (resolved !== null) {
    return resolved;
  }

  if (allowWorkspaceProtocol) {
    const linked = resolveProtocolDependency(fromDir, depName, specifier, workspacesByName);
    if (linked !== null) {
      return linked;
    }
  }

  throw new Error(
    `Missing installed production dependency "${depName}" required by ${requesterLabel}`,
  );
}

function resolveOptionalDependency(
  fromDir,
  depName,
  specifier,
  canonicalRoot,
  workspacesByName,
  workspacesByRealPath,
  stopAtWorkspaceBoundary,
) {
  const stopSet = stopAtWorkspaceBoundary ? workspacesByRealPath : null;
  const resolved = resolveFromNodeModulesChain(fromDir, depName, canonicalRoot, stopSet);
  if (resolved !== null) {
    return resolved;
  }

  if (!stopAtWorkspaceBoundary) {
    return resolveProtocolDependency(fromDir, depName, specifier, workspacesByName);
  }

  return null;
}

function resolveProtocolDependency(fromDir, depName, specifier, workspacesByName) {
  if (typeof specifier !== "string") {
    return null;
  }
  if (specifier.startsWith("workspace:")) {
    const targetWorkspace = workspacesByName.get(depName);
    return targetWorkspace ? targetWorkspace.realDir : null;
  }
  if (specifier.startsWith("link:") || specifier.startsWith("file:")) {
    const relativeTarget = specifier.replace(/^(?:link|file):/u, "");
    const candidate = path.resolve(fromDir, relativeTarget);
    if (existsSync(candidate)) {
      return resolveExistingRealPath(candidate, `linked dependency "${depName}"`);
    }
  }
  return null;
}

function resolveFromNodeModulesChain(fromDir, depName, canonicalRoot, stopWorkspaces) {
  const nameSegments = depName.split("/");
  let current = fromDir;

  while (true) {
    if (stopWorkspaces !== null && stopWorkspaces.has(current)) {
      break;
    }

    const candidate = path.join(current, "node_modules", ...nameSegments);
    const stats = tryLstat(candidate);
    if (stats !== null) {
      const realCandidate = resolveExistingRealPath(candidate, `dependency "${depName}"`);
      const manifestPath = path.join(realCandidate, "package.json");
      if (!existsSync(manifestPath)) {
        throw new Error(
          `Installed dependency "${depName}" at "${realCandidate}" is missing package.json`,
        );
      }
      return realCandidate;
    }

    if (current === canonicalRoot) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function listDirectNestedPackages(packageDir) {
  const nestedNodeModules = path.join(packageDir, "node_modules");
  if (!existsSync(nestedNodeModules)) {
    return [];
  }

  let stats;
  try {
    stats = statSync(nestedNodeModules);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) {
    return [];
  }

  const results = [];
  for (const entry of readdirSync(nestedNodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(nestedNodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      const scopeStats = tryStatDirectory(entryPath, entry.name);
      if (scopeStats === null) {
        continue;
      }
      for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
        if (scopedEntry.name.startsWith(".")) {
          continue;
        }
        const scopedPath = path.join(entryPath, scopedEntry.name);
        const scopedName = `${entry.name}/${scopedEntry.name}`;
        const realDir = resolveNestedPackageDir(scopedPath, scopedName);
        if (realDir !== null) {
          results.push({ realDir, fallbackName: scopedName });
        }
      }
      continue;
    }

    const realDir = resolveNestedPackageDir(entryPath, entry.name);
    if (realDir !== null) {
      results.push({ realDir, fallbackName: entry.name });
    }
  }

  return results;
}

function resolveNestedPackageDir(candidatePath, fallbackName) {
  const stats = tryLstat(candidatePath);
  if (stats === null) {
    return null;
  }
  const realCandidate = resolveExistingRealPath(
    candidatePath,
    `nested dependency "${fallbackName}"`,
  );
  if (!existsSync(path.join(realCandidate, "package.json"))) {
    return null;
  }
  return realCandidate;
}

function directorySize(directory) {
  const seenFiles = new Set();
  const seenDirectories = new Set([directory]);
  return walkDirectory(directory, seenFiles, seenDirectories);
}

function walkDirectory(directory, seenFiles, seenDirectories) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    const linkStats = tryLstat(fullPath);
    if (linkStats === null) {
      continue;
    }
    const realPath = resolveExistingRealPath(fullPath, `package entry "${fullPath}"`);
    const stats = statSync(realPath);
    if (stats.isDirectory()) {
      if (seenDirectories.has(realPath)) {
        continue;
      }
      seenDirectories.add(realPath);
      total += walkDirectory(realPath, seenFiles, seenDirectories);
      continue;
    }
    if (stats.isFile() && !seenFiles.has(realPath)) {
      seenFiles.add(realPath);
      total += stats.size;
    }
  }
  return total;
}

function readPackageManifest(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read "${manifestPath}": ${detail}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in "${manifestPath}": ${detail}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected package manifest object in "${manifestPath}"`);
  }
  return parsed;
}

function asStringRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      output[key] = item;
    }
  }
  return output;
}

function asObjectRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function isOptionalPeer(metaEntry) {
  return (
    metaEntry !== null &&
    typeof metaEntry === "object" &&
    !Array.isArray(metaEntry) &&
    "optional" in metaEntry &&
    metaEntry.optional === true
  );
}

function tryLstat(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function tryStatDirectory(targetPath, label) {
  const real = resolveExistingRealPath(targetPath, label);
  const stats = statSync(real);
  return stats.isDirectory() ? stats : null;
}

function resolveExistingRealPath(targetPath, description) {
  try {
    return realpathSync(targetPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Broken or inaccessible path for ${description} ("${targetPath}"): ${detail}`, {
      cause: error,
    });
  }
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function isExecutedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  }
}

if (isExecutedDirectly()) {
  try {
    const result = runSizeCheck();
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Size check failed: ${message}`);
    process.exit(1);
  }
}
