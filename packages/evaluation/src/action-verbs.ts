import { tokenizeWords } from "./detectors.js";

/** Resume past-tense starter list, stored as lemmas. Versioned and private. */
export const ACTION_VERB_LEXICON_VERSION = "action-verbs-2026-11-26-v1";

const LEMMAS = [
  "develop",
  "implement",
  "design",
  "engineer",
  "build",
  "integrate",
  "deploy",
  "optimize",
  "improve",
  "reduce",
  "accelerate",
  "streamline",
  "enhance",
  "lead",
  "manage",
  "direct",
  "mentor",
  "coordinate",
  "supervise",
  "analyze",
  "evaluate",
  "investigate",
  "identify",
  "assess",
  "research",
  "deliver",
  "launch",
  "execute",
  "complete",
  "establish",
  "migrate",
  "resolve",
  "test",
  "validate",
  "secure",
  "automate",
  "refactor",
  "increase",
  "generate",
  "achieve",
  "negotiate",
  "expand",
  "acquire",
  "maintain",
  "monitor",
  "configure",
  "administer",
  "support",
  "upgrade",
] as const;

const IRREGULAR: Record<string, readonly string[]> = {
  lead: ["lead", "leads", "leading", "led"],
  build: ["build", "builds", "building", "built"],
};

const FORMS = new Set(LEMMAS.flatMap((lemma) => IRREGULAR[lemma] ?? inflections(lemma)));

export function opensWithActionVerb(text: string): boolean {
  const first = tokenizeWords(text)[0]?.toLowerCase();
  return first !== undefined && FORMS.has(first);
}

function inflections(lemma: string): string[] {
  return [lemma, thirdPerson(lemma), pastTense(lemma), gerund(lemma)];
}

function thirdPerson(lemma: string): string {
  if (consonantY(lemma)) {
    return `${lemma.slice(0, -1)}ies`;
  }
  if (/(?:s|x|z|ch|sh)$/u.test(lemma)) {
    return `${lemma}es`;
  }
  return `${lemma}s`;
}

function pastTense(lemma: string): string {
  if (consonantY(lemma)) {
    return `${lemma.slice(0, -1)}ied`;
  }
  if (lemma.endsWith("e")) {
    return `${lemma}d`;
  }
  return `${lemma}ed`;
}

function gerund(lemma: string): string {
  if (lemma.endsWith("e") && !lemma.endsWith("ee")) {
    return `${lemma.slice(0, -1)}ing`;
  }
  return `${lemma}ing`;
}

function consonantY(lemma: string): boolean {
  return lemma.length > 2 && lemma.endsWith("y") && !/[aeiou]/u.test(lemma.charAt(lemma.length - 2));
}
