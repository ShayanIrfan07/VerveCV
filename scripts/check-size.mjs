import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const LIMIT_BYTES = 104_857_600;
const ROOT = process.cwd();
const optionalDependencyNames = new Map();
const workspaceDeps = readWorkspaceDependencyNames();

const sourceBytes = measureSourceBytes();
const dependencies = measureProductionDependencies();
const dependencyBytes = dependencies.reduce((total, item) => total + item.bytes, 0);
const totalBytes = sourceBytes + dependencyBytes;

console.log("VerveCV source + production dependency footprint");
console.log(`Source files:            ${formatBytes(sourceBytes)}`);
console.log(`Production dependencies: ${formatBytes(dependencyBytes)}`);
console.log(`Total:                   ${formatBytes(totalBytes)}`);
console.log(`Limit:                   ${formatBytes(LIMIT_BYTES)}`);
console.log(`Headroom:                ${formatBytes(LIMIT_BYTES - totalBytes)}`);
console.log("");
console.log("20 largest production dependencies");
for (const [index, item] of dependencies.slice(0, 20).entries()) {
  console.log(`${String(index + 1).padStart(2, " ")}. ${formatBytes(item.bytes).padStart(16, " ")}  ${item.name}@${item.version}`);
}

reportSeparate("Frontend production bundle", path.join(ROOT, "apps", "web", "dist"));
reportSeparate("Backend deployment artifact", path.join(ROOT, "apps", "api", "dist"));

if (totalBytes > LIMIT_BYTES) {
  console.error("Size check failed: the approved footprint exceeds 100 MiB.");
  process.exit(1);
}

function measureSourceBytes() {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer" });
  let total = 0;
  for (const file of listed.toString("utf8").split("\0")) {
    if (file.length === 0 || isExcludedSource(file)) {
      continue;
    }
    total += statSync(path.join(ROOT, file)).size;
  }
  return total;
}

function isExcludedSource(file) {
  const normalized = file.replaceAll("\\", "/");
  return (
    normalized.startsWith("fixtures/") ||
    normalized.includes("/fixtures/") ||
    normalized.startsWith("dist/") ||
    normalized.includes("/dist/") ||
    normalized.endsWith(".tsbuildinfo")
  );
}

function pnpmList() {
  const args = ["list", "-r", "--prod", "--json", "--depth", "Infinity"];
  const execPath = process.env.npm_execpath;
  if (typeof execPath === "string" && execPath.toLowerCase().includes("pnpm")) {
    return execFileSync(process.execPath, [execPath, ...args], { cwd: ROOT, encoding: "utf8" });
  }
  return execFileSync("pnpm", args, { cwd: ROOT, encoding: "utf8" });
}

function measureProductionDependencies() {
  const raw = pnpmList();
  const seenPaths = new Set();
  const packages = [];
  for (const workspace of JSON.parse(raw)) {
    collectDependencies(workspace.dependencies, seenPaths, packages);
  }
  packages.sort((left, right) => right.bytes - left.bytes);
  return packages;
}

function collectDependencies(dependencies, seenPaths, packages, parentRoot) {
  if (dependencies === undefined) {
    return;
  }
  const optionalNames = parentRoot ? readOptionalDependencyNames(parentRoot) : new Set();
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (dependency.optional === true || isDevelopmentOnly(name) || isUnusedOptional(name, optionalNames)) {
      continue;
    }
    const packagePath = dependency.path;
    let packageRoot;
    if (typeof packagePath === "string" && isInstalledPackage(packagePath) && !seenPaths.has(packagePath)) {
      try {
        packageRoot = realpathSync(packagePath);
      } catch {
        packageRoot = undefined;
      }
      if (packageRoot) {
        seenPaths.add(packagePath);
        packages.push({
          name,
          version: dependency.version ?? "unknown",
          bytes: directorySize(packageRoot),
        });
      }
    }
    collectDependencies(dependency.dependencies, seenPaths, packages, packageRoot);
  }
}

function readOptionalDependencyNames(packageRoot) {
  const cached = optionalDependencyNames.get(packageRoot);
  if (cached) {
    return cached;
  }
  const names = new Set();
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      names.add(name);
    }
  } catch {
    // A virtual store entry without a manifest contributes no optional names.
  }
  optionalDependencyNames.set(packageRoot, names);
  return names;
}

function isUnusedOptional(name, optionalNames) {
  if (!optionalNames.has(name)) {
    return false;
  }
  // These packages are optional only so the hasher can ship one native build per OS.
  return !name.startsWith("@node-rs/argon2-");
}

function isDevelopmentOnly(name) {
  return workspaceDeps.dev.has(name) && !workspaceDeps.prod.has(name);
}

function readWorkspaceDependencyNames() {
  const prod = new Set();
  const dev = new Set();
  for (const file of ["package.json", ...workspacePackageFiles()]) {
    const json = JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
    for (const name of Object.keys(json.dependencies ?? {})) {
      prod.add(name);
    }
    for (const name of Object.keys(json.devDependencies ?? {})) {
      dev.add(name);
    }
  }
  return { prod, dev };
}

function workspacePackageFiles() {
  const files = [];
  for (const group of ["apps", "packages"]) {
    const directory = path.join(ROOT, group);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        files.push(path.join(group, entry.name, "package.json"));
      }
    }
  }
  return files;
}

function isInstalledPackage(packagePath) {
  const relative = path.relative(ROOT, packagePath).replaceAll("\\", "/");
  return relative.includes("node_modules/");
}

function directorySize(directory) {
  const seenFiles = new Set();
  return walk(directory, seenFiles);
}

function walk(directory, seenFiles) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    let realPath;
    try {
      realPath = realpathSync(fullPath);
    } catch {
      continue;
    }
    if (seenFiles.has(realPath)) {
      continue;
    }
    const stats = statSync(realPath);
    if (stats.isDirectory()) {
      total += walk(realPath, seenFiles);
      continue;
    }
    if (stats.isFile()) {
      seenFiles.add(realPath);
      total += stats.size;
    }
  }
  return total;
}

function reportSeparate(label, directory) {
  let bytes;
  try {
    bytes = directorySize(realpathSync(directory));
  } catch {
    console.log(`${label}: not built`);
    return;
  }
  console.log(`${label} (reported separately, excluded from the 100 MiB gate): ${formatBytes(bytes)}`);
}

function formatBytes(bytes) {
  const sign = bytes < 0 ? "-" : "";
  const absolute = Math.abs(bytes);
  return `${sign}${absolute.toLocaleString("en-US")} B (${(absolute / 1024 / 1024).toFixed(2)} MiB)`;
}
