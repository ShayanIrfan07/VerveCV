import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultLookupBase = path.join(repoRoot, "packages", "evaluation", "package.json");

const customRoot = process.argv[2];
const lookupFrom = customRoot
  ? path.join(path.resolve(customRoot), "package.json")
  : defaultLookupBase;
const requireFromTarget = createRequire(lookupFrom);

function packageDirectory(pkgName, resolver = requireFromTarget) {
  try {
    const entry = resolver.resolve(`${pkgName}/package.json`);
    return path.dirname(realpathSync(entry));
  } catch {
    const mainEntry = resolver.resolve(pkgName);
    let dir = path.dirname(realpathSync(mainEntry));
    while (dir !== path.dirname(dir)) {
      try {
        statSync(path.join(dir, "package.json"));
        return dir;
      } catch {
        dir = path.dirname(dir);
      }
    }
    throw new Error(`Unable to locate package root for ${pkgName}`);
  }
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

const corpusPath = path.join(scriptDir, "fixtures", "technical-probe-corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const modules = [
  ["nspell", requireFromTarget],
  ["dictionary-en", requireFromTarget],
];
const sizes = {};
for (const [name, resolver] of modules) {
  sizes[name] = directoryBytes(packageDirectory(name, resolver));
}
const nspellResolver = createRequire(path.join(packageDirectory("nspell", requireFromTarget), "package.json"));
sizes["is-buffer"] = directoryBytes(packageDirectory("is-buffer", nspellResolver));
sizes.total = Object.values(sizes).reduce((sum, value) => sum + value, 0);

const dictionaryDir = packageDirectory("dictionary-en");
const aff = readFileSync(path.join(dictionaryDir, "index.aff"));
const dic = readFileSync(path.join(dictionaryDir, "index.dic"));

const nspellEntry = path.join(packageDirectory("nspell"), "lib", "index.js");
const nspell = (await import(pathToFileURL(nspellEntry).href)).default;
const rawSpell = nspell(aff, dic);

const evalDistPath = path.join(repoRoot, "packages", "evaluation", "dist", "index.js");
const evaluation = await import(pathToFileURL(evalDistPath).href);
const allowlistedSpell = evaluation.createSpellCheckerFromDictionary({ aff, dic });

const uniqueTerms = [...new Set(corpus.technicalTerms)];
const rawUnknown = uniqueTerms.filter((term) => rawSpell.correct(term) !== true);
const allowlistedUnknown = uniqueTerms.filter((term) => allowlistedSpell.correct(term) !== true);

const controlResults = Object.fromEntries(
  corpus.controlEnglishWords.map((word) => [word, allowlistedSpell.correct(word) === true]),
);
const misspellingResults = Object.fromEntries(
  corpus.knownMisspellings.map((word) => [word, allowlistedSpell.correct(word) === false]),
);

process.stdout.write(
  `${JSON.stringify({
    corpusVersion: corpus.version,
    technicalAllowlistVersion: evaluation.TECHNICAL_ALLOWLIST_VERSION,
    sizes,
    termCount: uniqueTerms.length,
    rawUnknownCount: rawUnknown.length,
    rawUnknown,
    allowlistedUnknownCount: allowlistedUnknown.length,
    allowlistedUnknown,
    controlResults,
    misspellingResults,
  })}\n`,
);
