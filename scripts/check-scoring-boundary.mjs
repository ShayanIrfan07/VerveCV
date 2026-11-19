import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PRIVATE_SCORING_TOKENS = [
  "OPEN_DECISION",
  "UNRESOLVED_BAND",
  "DICTIONARY_UNAVAILABLE",
  "MISSING_CANDIDATE_TYPE",
  "rubric-2026-11-12-provisional",
  "CRITERION_MAXIMA",
  "@vervecv/evaluation",
  "not_implemented",
  "appliedToScore",
  "penaltyStatus",
];

export function webSourceFiles() {
  const sourceDir = path.join(rootDir, "apps", "web", "src");
  return walk(sourceDir).filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"));
}

export function sourceLeakage() {
  const packageJson = JSON.parse(readFileSync(path.join(rootDir, "apps", "web", "package.json"), "utf8"));
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  const leaks = [];
  if (dependencies["@vervecv/evaluation"]) {
    leaks.push("apps/web/package.json depends on @vervecv/evaluation");
  }
  for (const file of webSourceFiles()) {
    const text = readFileSync(file, "utf8");
    for (const token of PRIVATE_SCORING_TOKENS) {
      if (text.includes(token)) {
        leaks.push(`${path.relative(rootDir, file)} contains ${token}`);
      }
    }
  }
  const viteConfig = readFileSync(path.join(rootDir, "apps", "web", "vite.config.ts"), "utf8");
  if (!viteConfig.includes("sourcemap: false")) {
    leaks.push("apps/web/vite.config.ts does not disable production sourcemaps");
  }
  return leaks;
}

export function bundleLeakage() {
  const distDir = path.join(rootDir, "apps", "web", "dist");
  const files = walk(distDir);
  const leaks = [];
  for (const file of files) {
    if (file.endsWith(".map")) {
      leaks.push(`${path.relative(rootDir, file)} is a production sourcemap`);
      continue;
    }
    if (!/\.(js|css|html)$/.test(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const token of PRIVATE_SCORING_TOKENS) {
      if (text.includes(token)) {
        leaks.push(`${path.relative(rootDir, file)} contains ${token}`);
      }
    }
  }
  return leaks;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const leaks = bundleLeakage();
  if (leaks.length > 0) {
    console.error(leaks.join("\n"));
    process.exit(1);
  }
}
