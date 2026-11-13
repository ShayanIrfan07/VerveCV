import nspellModule, { type NSpellDictionary, type NSpellInstance } from "nspell";
import {
  isProductiveHyphenPrefix,
  isTechnicalTerm,
  normalizeTermKey,
  TECHNICAL_ALLOWLIST_VERSION,
} from "./technical-terms.js";

export type DictionarySource = NSpellDictionary;

export interface SpellChecker {
  correct(word: string): boolean;
}

/**
 * Measured from nspell@2.1.5, dictionary-en@4.0.0, and is-buffer (622,389 B unpacked).
 * Accepted for Phase 5 deterministic spellchecking when paired with the versioned
 * technical-term allowlist (TECHNICAL_ALLOWLIST_VERSION).
 */
export const DICTIONARY_CANDIDATE = {
  spellchecker: "nspell@2.1.5",
  dictionary: "dictionary-en@4.0.0",
  technicalAllowlistVersion: TECHNICAL_ALLOWLIST_VERSION,
  unpackedBytes: 622_389,
  accepted: true,
} as const;

const createNspell = (
  typeof nspellModule === "function"
    ? nspellModule
    : (nspellModule as { default: typeof nspellModule }).default
) as typeof nspellModule;

export function createSpellCheckerFromDictionary(source: DictionarySource): SpellChecker {
  const engine: NSpellInstance = createNspell(source.aff, source.dic);
  return wrapWithTechnicalAllowlist(engine);
}

function wrapWithTechnicalAllowlist(engine: NSpellInstance): SpellChecker {
  const checkSingle = (token: string): boolean => {
    const trimmed = token.trim();
    if (trimmed.length <= 1) {
      return true;
    }
    if (isTechnicalTerm(trimmed)) {
      return true;
    }
    if (engine.correct(trimmed)) {
      return true;
    }
    // Possessive form on a known word or technical term (e.g. "Kubernetes's", "company's")
    if (/['’]s$/iu.test(trimmed)) {
      const stem = trimmed.slice(0, -2);
      if (stem.length > 1 && (isTechnicalTerm(stem) || engine.correct(stem))) {
        return true;
      }
    }
    // Hyphenated compounds (e.g. "micro-services", "client-side", "pre-built")
    if (trimmed.includes("-")) {
      const parts = trimmed.split("-").filter((part) => part.length > 0);
      if (
        parts.length >= 2 &&
        parts.every(
          (part, index) =>
            (index === 0 && isProductiveHyphenPrefix(part)) ||
            isTechnicalTerm(part) ||
            engine.correct(part),
        )
      ) {
        return true;
      }
    }
    return false;
  };

  return {
    correct(word: string): boolean {
      return checkSingle(word);
    },
  };
}

let cachedDefaultChecker: SpellChecker | null | undefined;

/**
 * Lazily loads `dictionary-en` when running on Node.js without introducing static
 * `node:*` imports that would break browser bundles. Browser callers may pass a
 * preloaded `SpellChecker` created via `createSpellCheckerFromDictionary`.
 */
export function getDefaultSpellChecker(): SpellChecker | null {
  if (cachedDefaultChecker !== undefined) {
    return cachedDefaultChecker;
  }

  const runtimeProcess = (
    globalThis as {
      process?: {
        versions?: { node?: string };
        getBuiltinModule?: (id: string) => unknown;
      };
    }
  ).process;

  if (!runtimeProcess?.versions?.node || typeof runtimeProcess.getBuiltinModule !== "function") {
    cachedDefaultChecker = null;
    return null;
  }

  try {
    const fs = runtimeProcess.getBuiltinModule("node:fs") as {
      readFileSync(filePath: string): Uint8Array;
    };
    const path = runtimeProcess.getBuiltinModule("node:path") as {
      dirname(p: string): string;
      join(...parts: string[]): string;
    };
    const mod = runtimeProcess.getBuiltinModule("node:module") as {
      createRequire(filename: string | URL): { resolve(id: string): string };
    };

    const requireFromHere = mod.createRequire(import.meta.url);
    const dictionaryEntry = requireFromHere.resolve("dictionary-en");
    const dictionaryDir = path.dirname(dictionaryEntry);
    const aff = fs.readFileSync(path.join(dictionaryDir, "index.aff"));
    const dic = fs.readFileSync(path.join(dictionaryDir, "index.dic"));

    cachedDefaultChecker = createSpellCheckerFromDictionary({ aff, dic });
    return cachedDefaultChecker;
  } catch {
    cachedDefaultChecker = null;
    return null;
  }
}

/**
 * Curated high-frequency English & resume misspellings mapped to their canonical spelling.
 * Used both for instant O(1) high-confidence suggestions and to catch unambiguous
 * sentence-initial capitalized typos without false-flagging proper nouns.
 */
export const COMMON_MISSPELLINGS: ReadonlyMap<string, string> = new Map([
  ["accomodate", "accommodate"],
  ["accomodated", "accommodated"],
  ["acheive", "achieve"],
  ["acheived", "achieved"],
  ["acheivement", "achievement"],
  ["acheivements", "achievements"],
  ["acheiving", "achieving"],
  ["acknowlege", "acknowledge"],
  ["acknowleged", "acknowledged"],
  ["aquiring", "acquiring"],
  ["aquisition", "acquisition"],
  ["apparant", "apparent"],
  ["architechture", "architecture"],
  ["architechtures", "architectures"],
  ["asyncronous", "asynchronous"],
  ["automatize", "automate"],
  ["beleive", "believe"],
  ["buisness", "business"],
  ["calender", "calendar"],
  ["catagory", "category"],
  ["collabortaed", "collaborated"],
  ["collaobrated", "collaborated"],
  ["colaborated", "collaborated"],
  ["collegue", "colleague"],
  ["collegues", "colleagues"],
  ["commited", "committed"],
  ["commiting", "committing"],
  ["communcation", "communication"],
  ["compatable", "compatible"],
  ["concious", "conscious"],
  ["consistant", "consistent"],
  ["consistantly", "consistently"],
  ["continous", "continuous"],
  ["continously", "continuously"],
  ["custome", "custom"],
  ["definately", "definitely"],
  ["definitly", "definitely"],
  ["dependant", "dependent"],
  ["develope", "develop"],
  ["developped", "developed"],
  ["developper", "developer"],
  ["developpers", "developers"],
  ["developpment", "development"],
  ["efficency", "efficiency"],
  ["efficent", "efficient"],
  ["efficently", "efficiently"],
  ["embarass", "embarrass"],
  ["enviroment", "environment"],
  ["enviroments", "environments"],
  ["enviornment", "environment"],
  ["existance", "existence"],
  ["experiance", "experience"],
  ["experianced", "experienced"],
  ["familar", "familiar"],
  ["finaly", "finally"],
  ["foriegn", "foreign"],
  ["fourty", "forty"],
  ["futher", "further"],
  ["garantee", "guarantee"],
  ["garanteed", "guaranteed"],
  ["govornment", "government"],
  ["goverment", "government"],
  ["grammer", "grammar"],
  ["harrass", "harass"],
  ["immediatly", "immediately"],
  ["implment", "implement"],
  ["implmented", "implemented"],
  ["implmenting", "implementing"],
  ["implmentation", "implementation"],
  ["independant", "independent"],
  ["independantly", "independently"],
  ["infrastruture", "infrastructure"],
  ["infrastucture", "infrastructure"],
  ["intgrated", "integrated"],
  ["intergrated", "integrated"],
  ["intergration", "integration"],
  ["javasript", "JavaScript"],
  ["knowlege", "knowledge"],
  ["kubernets", "Kubernetes"],
  ["latnecy", "latency"],
  ["liason", "liaison"],
  ["maintainance", "maintenance"],
  ["maintenence", "maintenance"],
  ["managment", "management"],
  ["millenium", "millennium"],
  ["monitering", "monitoring"],
  ["neccessary", "necessary"],
  ["necesary", "necessary"],
  ["noticable", "noticeable"],
  ["occured", "occurred"],
  ["occurence", "occurrence"],
  ["occuring", "occurring"],
  ["optmize", "optimize"],
  ["optmized", "optimized"],
  ["optmizing", "optimizing"],
  ["parliment", "parliament"],
  ["performace", "performance"],
  ["perseverence", "perseverance"],
  ["persistant", "persistent"],
  ["postgress", "Postgres"],
  ["priviledge", "privilege"],
  ["prodcution", "production"],
  ["profesional", "professional"],
  ["publically", "publicly"],
  ["recieve", "receive"],
  ["recieved", "received"],
  ["recieving", "receiving"],
  ["recomend", "recommend"],
  ["recomended", "recommended"],
  ["refered", "referred"],
  ["refering", "referring"],
  ["relevent", "relevant"],
  ["relability", "reliability"],
  ["repitition", "repetition"],
  ["responsibilites", "responsibilities"],
  ["responsiblity", "responsibility"],
  ["scalabilty", "scalability"],
  ["seperate", "separate"],
  ["seperated", "separated"],
  ["seperately", "separately"],
  ["succesful", "successful"],
  ["succesfully", "successfully"],
  ["sucessful", "successful"],
  ["sucessfully", "successfully"],
  ["supercede", "supersede"],
  ["teh", "the"],
  ["thier", "their"],
  ["threshhold", "threshold"],
  ["tommorow", "tomorrow"],
  ["truely", "truly"],
  ["typescipt", "TypeScript"],
  ["untill", "until"],
  ["usefull", "useful"],
  ["wierd", "weird"],
]);

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/**
 * Generates a deterministic high-confidence suggestion in O(word.length) dictionary
 * lookups (< 1ms) without running slow full-affix permutation scans. Returns undefined
 * unless there is an explicit known correction or a single unambiguous 1-edit match.
 */
export function fastHighConfidenceSuggestion(
  rawWord: string,
  checker: SpellChecker,
): string | undefined {
  const lower = normalizeTermKey(rawWord);
  const direct = COMMON_MISSPELLINGS.get(lower);
  if (direct !== undefined) {
    return matchCase(rawWord, direct);
  }

  if (lower.length < 3 || lower.length > 24 || !/^[a-z]+$/u.test(lower)) {
    return undefined;
  }

  const validCandidates = new Set<string>();

  // 1. Adjacent transpositions ("form" vs typos like "realtim" / "latnecy")
  for (let i = 0; i < lower.length - 1; i += 1) {
    if (lower[i] === lower[i + 1]) continue;
    const candidate =
      lower.slice(0, i) + (lower[i + 1] ?? "") + (lower[i] ?? "") + lower.slice(i + 2);
    if (checker.correct(candidate)) {
      validCandidates.add(candidate);
    }
  }
  if (validCandidates.size === 1) {
    const [only] = validCandidates;
    return only ? matchCase(rawWord, only) : undefined;
  }
  if (validCandidates.size > 1) {
    return undefined;
  }

  // 2. Single-character deletions & insertions
  for (let i = 0; i < lower.length; i += 1) {
    const deleted = lower.slice(0, i) + lower.slice(i + 1);
    if (deleted.length >= 3 && checker.correct(deleted)) {
      validCandidates.add(deleted);
    }
  }
  for (let i = 0; i <= lower.length; i += 1) {
    for (const ch of ALPHABET) {
      const inserted = lower.slice(0, i) + ch + lower.slice(i);
      if (checker.correct(inserted)) {
        validCandidates.add(inserted);
      }
    }
  }

  if (validCandidates.size === 1) {
    const [only] = validCandidates;
    return only ? matchCase(rawWord, only) : undefined;
  }

  return undefined;
}

export function matchCase(original: string, suggestion: string): string {
  if (original.length === 0 || suggestion.length === 0) {
    return suggestion;
  }
  if (/[A-Z]/u.test(suggestion.slice(1))) {
    // Preserve canonical MixedCase technical brand names like "JavaScript" or "Kubernetes"
    return suggestion;
  }
  const firstChar = original[0];
  if (firstChar !== undefined && firstChar >= "A" && firstChar <= "Z") {
    return (suggestion[0]?.toUpperCase() ?? "") + suggestion.slice(1);
  }
  return suggestion;
}
