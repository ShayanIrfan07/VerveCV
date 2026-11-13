import type {
  EvaluationFinding,
  EvidenceReference,
  ResumeBlock,
  ResumeDocument,
  ResumeSection,
  ResumeSectionKind,
  WithheldRuleResult,
} from "./model.js";
import { CRITERION_MAXIMA, RUBRIC_VERSION } from "./rubric.js";
import {
  COMMON_MISSPELLINGS,
  createSpellCheckerFromDictionary,
  DICTIONARY_CANDIDATE,
  fastHighConfidenceSuggestion,
  getDefaultSpellChecker,
  matchCase,
  type DictionarySource,
  type SpellChecker,
} from "./spellchecker.js";
import {
  isTechnicalTerm,
  normalizeTermKey,
  TECHNICAL_ALLOWLIST_VERSION,
} from "./technical-terms.js";

export {
  createSpellCheckerFromDictionary,
  DICTIONARY_CANDIDATE,
  getDefaultSpellChecker,
  isTechnicalTerm,
  TECHNICAL_ALLOWLIST_VERSION,
};
export type { DictionarySource, SpellChecker };

export interface GrammarEvaluationOptions {
  candidateName?: string | null | undefined;
  ignoredTerms?: readonly string[] | undefined;
  spellChecker?: SpellChecker | null | undefined;
}

interface OffsetSpan {
  start: number;
  end: number;
}

interface RawDetection {
  ruleId: string;
  dedupeKey: string;
  message: string;
  suggestion?: string | undefined;
  confidence: "high" | "medium" | "low";
  status: "active" | "ignored";
  evidence: EvidenceReference;
}

const GRAMMAR_CATEGORY = "grammarAndReadability";
const BULLET_SECTIONS: ReadonlySet<ResumeSectionKind> = new Set([
  "WORK_EXPERIENCE",
  "LEADERSHIP_EXPERIENCE",
  "PROJECTS",
]);

/**
 * Unambiguous missing-apostrophe contractions owned EXCLUSIVELY by `punctuationRule`
 * so `grammarAndSpellingRule` never double-counts them as spelling errors.
 * Words with valid non-contraction meanings on resumes ("id", "its", "were", "well",
 * "shell", "cant", "wont", "ill") are intentionally omitted to avoid false positives.
 */
const MISSING_APOSTROPHE_CONTRACTIONS: ReadonlyMap<string, string> = new Map([
  ["dont", "don't"],
  ["doesnt", "doesn't"],
  ["didnt", "didn't"],
  ["isnt", "isn't"],
  ["arent", "aren't"],
  ["wasnt", "wasn't"],
  ["werent", "weren't"],
  ["hasnt", "hasn't"],
  ["havent", "haven't"],
  ["hadnt", "hadn't"],
  ["wouldnt", "wouldn't"],
  ["couldnt", "couldn't"],
  ["shouldnt", "shouldn't"],
  ["mustnt", "mustn't"],
  ["youre", "you're"],
  ["theyre", "they're"],
  ["weve", "we've"],
  ["theyve", "they've"],
  ["youve", "you've"],
]);

const IRREGULAR_PAST_CORRECTIONS: ReadonlyMap<string, string> = new Map([
  ["breaked", "broke"],
  ["bringed", "brought"],
  ["builded", "built"],
  ["buyed", "bought"],
  ["catched", "caught"],
  ["choosed", "chose"],
  ["drawed", "drew"],
  ["drived", "drove"],
  ["finded", "found"],
  ["flyed", "flew"],
  ["gived", "gave"],
  ["growed", "grew"],
  ["holded", "held"],
  ["keeped", "kept"],
  ["knowed", "knew"],
  ["maked", "made"],
  ["runed", "ran"],
  ["seeked", "sought"],
  ["selled", "sold"],
  ["sended", "sent"],
  ["speaked", "spoke"],
  ["spended", "spent"],
  ["taked", "took"],
  ["teached", "taught"],
  ["telled", "told"],
  ["thinked", "thought"],
  ["wroted", "wrote"],
]);

const DID_BASE_VERB: ReadonlyMap<string, string> = new Map([
  ["built", "build"],
  ["came", "come"],
  ["created", "create"],
  ["deployed", "deploy"],
  ["developed", "develop"],
  ["gave", "give"],
  ["implemented", "implement"],
  ["made", "make"],
  ["ran", "run"],
  ["saw", "see"],
  ["took", "take"],
  ["went", "go"],
  ["wrote", "write"],
]);

const HAVE_PARTICIPLE: ReadonlyMap<string, string> = new Map([
  ["ate", "eaten"],
  ["began", "begun"],
  ["broke", "broken"],
  ["came", "come"],
  ["chose", "chosen"],
  ["drove", "driven"],
  ["fell", "fallen"],
  ["gave", "given"],
  ["ran", "run"],
  ["saw", "seen"],
  ["spoke", "spoken"],
  ["took", "taken"],
  ["went", "gone"],
  ["wrote", "written"],
]);

const PREPOSITION_FIXES: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
  key: string;
  explanation: string;
}> = [
  {
    pattern: /\b(responsible)[ \t]+of\b/giu,
    replacement: "for",
    key: "responsible-of",
    explanation: 'Use "responsible for" instead of "responsible of".',
  },
  {
    pattern: /\b(capable)[ \t]+to\b/giu,
    replacement: "of",
    key: "capable-to",
    explanation: 'Use "capable of" instead of "capable to".',
  },
  {
    pattern: /\b(depend(?:s|ed|ing)?)[ \t]+of\b/giu,
    replacement: "on",
    key: "depend-of",
    explanation: 'Use "depend on" instead of "depend of".',
  },
  {
    pattern: /\b(compli(?:ed|es)|comply|complying)[ \t]+to\b/giu,
    replacement: "with",
    key: "comply-to",
    explanation: 'Use "comply with" instead of "comply to".',
  },
  {
    pattern: /\b(adher(?:ed|es|e|ing))[ \t]+with\b/giu,
    replacement: "to",
    key: "adhere-with",
    explanation: 'Use "adhere to" instead of "adhere with".',
  },
  {
    pattern: /\b(interested)[ \t]+on\b/giu,
    replacement: "in",
    key: "interested-on",
    explanation: 'Use "interested in" instead of "interested on".',
  },
];

/**
 * Evaluates deterministic grammar and spelling checks across a normalized resume.
 *
 * Per RUBRIC.md §5.1 and ADR 0001 item A9, distinct-error counting and grammar-vs-punctuation
 * precedence remain open product decisions, so the criterion returns `status: "withheld"`
 * (`score: null`) while exposing validated detections as informational findings (`severity: "info"`).
 */
export function grammarAndSpellingRule(
  document?: ResumeDocument,
  options: GrammarEvaluationOptions = {},
): WithheldRuleResult {
  const checker =
    options.spellChecker === undefined ? getDefaultSpellChecker() : options.spellChecker;
  const reasonCode = checker === null ? "DICTIONARY_UNAVAILABLE" : "OPEN_DECISION";

  if (!document || document.blocks.length === 0) {
    return {
      ruleId: "grammar-and-spelling",
      maxScore: CRITERION_MAXIMA.grammarAndSpelling,
      score: null,
      status: "withheld",
      reasonCode,
      findings: [],
      version: RUBRIC_VERSION,
    };
  }

  const ignoredSet = buildIgnoredSet(options.ignoredTerms);
  const candidateTokens = buildCandidateNameSet(options.candidateName);
  const sectionsById = new Map<string, ResumeSection>(
    document.sections.map((section) => [section.id, section]),
  );

  const rawDetections: RawDetection[] = [];

  for (const block of document.blocks) {
    if (block.text.length === 0) {
      continue;
    }
    const section = sectionsById.get(block.sectionId);
    const protectedSpans = findProtectedSpans(block.text);
    const claimedSpans: OffsetSpan[] = [...protectedSpans];

    collectGrammarDetections(block, claimedSpans, rawDetections);

    if (checker !== null) {
      collectSpellingDetections(
        block,
        section,
        checker,
        ignoredSet,
        candidateTokens,
        claimedSpans,
        rawDetections,
      );
    }
  }

  return {
    ruleId: "grammar-and-spelling",
    maxScore: CRITERION_MAXIMA.grammarAndSpelling,
    score: null,
    status: "withheld",
    reasonCode,
    findings: deduplicateDetections("grammar", rawDetections),
    version: RUBRIC_VERSION,
  };
}

/**
 * Evaluates deterministic punctuation checks separately from `grammarAndSpellingRule`
 * so punctuation issues are never double-counted under grammar/spelling.
 *
 * Remains `status: "withheld"` (`reasonCode: "OPEN_DECISION"`) until ADR 0001 item A9 is closed.
 */
export function punctuationRule(document?: ResumeDocument): WithheldRuleResult {
  if (!document || document.blocks.length === 0) {
    return {
      ruleId: "punctuation",
      maxScore: CRITERION_MAXIMA.punctuation,
      score: null,
      status: "withheld",
      reasonCode: "OPEN_DECISION",
      findings: [],
      version: RUBRIC_VERSION,
    };
  }

  const sectionsById = new Map<string, ResumeSection>(
    document.sections.map((section) => [section.id, section]),
  );
  const rawDetections: RawDetection[] = [];

  for (const block of document.blocks) {
    if (block.text.length === 0) {
      continue;
    }
    const protectedSpans = findProtectedSpans(block.text);
    const claimedSpans: OffsetSpan[] = [...protectedSpans];

    collectPunctuationDetections(block, claimedSpans, rawDetections);
  }

  collectBulletPeriodInconsistencies(document, sectionsById, rawDetections);

  return {
    ruleId: "punctuation",
    maxScore: CRITERION_MAXIMA.punctuation,
    score: null,
    status: "withheld",
    reasonCode: "OPEN_DECISION",
    findings: deduplicateDetections("punctuation", rawDetections),
    version: RUBRIC_VERSION,
  };
}

function collectGrammarDetections(
  block: ResumeBlock,
  claimedSpans: OffsetSpan[],
  out: RawDetection[],
): void {
  const text = block.text;

  // 1. Repeated adjacent words ("the the", "built built")
  const repeatedWordPattern = /\b([A-Za-z]{2,})([ \t]+)(\1)\b/giu;
  for (const match of text.matchAll(repeatedWordPattern)) {
    const start = match.index;
    const firstWord = match[1];
    if (start === undefined || firstWord === undefined) continue;
    const fullMatch = match[0];
    const end = start + fullMatch.length;
    const lower = firstWord.toLowerCase();
    // "had had" can be valid past-perfect English prose
    if (lower === "had" || overlapsAny(claimedSpans, start, end)) {
      continue;
    }
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-repeated-word",
      dedupeKey: `repeated-word:${lower}`,
      message: `Repeated word "${firstWord}".`,
      suggestion: firstWord,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  // 2. Clear indefinite article ("a" vs "an") mismatches
  const articlePattern = /\b(a|an|A|An)([ \t]+)([A-Za-z][A-Za-z-]*)\b/gu;
  for (const match of text.matchAll(articlePattern)) {
    const start = match.index;
    const article = match[1];
    const space = match[2];
    const nextWord = match[3];
    if (start === undefined || !article || !space || !nextWord) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;

    // Uppercase "A" is only treated as an indefinite article at sentence/block start before a lowercase word
    if (article === "A" || article === "An") {
      if (!isAtClauseStart(text, start) || !/^[a-z]/u.test(nextWord)) {
        continue;
      }
    }

    const expectedLower = expectedIndefiniteArticle(nextWord);
    if (expectedLower === null) continue;
    const actualLower = article.toLowerCase();
    if (actualLower === expectedLower) continue;

    const correctedArticle = matchCase(article, expectedLower);
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-article",
      dedupeKey: `article:${actualLower}:${nextWord.toLowerCase()}`,
      message: `Use "${correctedArticle}" before "${nextWord}".`,
      suggestion: `${correctedArticle}${space}${nextWord}`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  // 3. Clear subject-verb agreement errors
  for (const match of text.matchAll(/\b(we|they|you)([ \t]+)was\b/giu)) {
    const start = match.index;
    const subj = match[1];
    const space = match[2];
    if (start === undefined || !subj || !space) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-agreement",
      dedupeKey: `agreement:${subj.toLowerCase()}-was`,
      message: `Subject-verb agreement: use "${subj} were".`,
      suggestion: `${subj}${space}were`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  for (const match of text.matchAll(/\b(he|she|it)([ \t]+)were\b/giu)) {
    const start = match.index;
    const subj = match[1];
    const space = match[2];
    if (start === undefined || !subj || !space) continue;
    // Allow subjunctive ("if it were", "as though it were", "wish he were")
    const before = text.slice(Math.max(0, start - 16), start);
    if (/\b(?:if|though|wish)\s+$/iu.test(before)) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-agreement",
      dedupeKey: `agreement:${subj.toLowerCase()}-were`,
      message: `Subject-verb agreement: use "${subj} was".`,
      suggestion: `${subj}${space}was`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  for (const match of text.matchAll(/\b(he|she|it)([ \t]+)(have|do)\b/giu)) {
    const start = match.index;
    const subj = match[1];
    const space = match[2];
    const verb = match[3];
    if (start === undefined || !subj || !space || !verb) continue;
    // Skip auxiliarized clauses like "did it have" / "does it have" / "will it have"
    const before = text.slice(Math.max(0, start - 12), start);
    if (/\b(?:did|does|will|would|could|should|may|might|can|must)\s+$/iu.test(before)) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    const fixedVerb = verb.toLowerCase() === "have" ? "has" : "does";
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-agreement",
      dedupeKey: `agreement:${subj.toLowerCase()}-${verb.toLowerCase()}`,
      message: `Subject-verb agreement: use "${subj} ${fixedVerb}".`,
      suggestion: `${subj}${space}${fixedVerb}`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  for (const match of text.matchAll(/\b(I|[Ww]e|[Tt]hey|[Yy]ou)([ \t]+)(has|does)\b/gu)) {
    const start = match.index;
    const subj = match[1];
    const space = match[2];
    const verb = match[3];
    if (start === undefined || !subj || !space || !verb) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    const fixedVerb = verb.toLowerCase() === "has" ? "have" : "do";
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-agreement",
      dedupeKey: `agreement:${subj.toLowerCase()}-${verb.toLowerCase()}`,
      message: `Subject-verb agreement: use "${subj} ${fixedVerb}".`,
      suggestion: `${subj}${space}${fixedVerb}`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  for (const match of text.matchAll(
    /\b(there)([ \t]+)(is|was)([ \t]+)(many|several|multiple|numerous|various|two|three|four|five|\d{2,})\b/giu,
  )) {
    const start = match.index;
    const thereWord = match[1];
    const space1 = match[2];
    const copula = match[3];
    const space2 = match[4];
    const quantifier = match[5];
    if (start === undefined || !thereWord || !space1 || !copula || !space2 || !quantifier) {
      continue;
    }
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    const fixedCopula = copula.toLowerCase() === "is" ? "are" : "were";
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-agreement",
      dedupeKey: `agreement:there-${copula.toLowerCase()}-plural`,
      message: `Subject-verb agreement: use "${thereWord} ${fixedCopula}".`,
      suggestion: `${thereWord}${space1}${fixedCopula}${space2}${quantifier}`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  // 4. Verb-form errors: non-standard irregular pasts, "did <past>", "have <past>", "should of"
  for (const match of text.matchAll(
    /\b(did(?:n't|[ \t]+not)?)([ \t]+)([A-Za-z]+)\b/giu,
  )) {
    const start = match.index;
    const aux = match[1];
    const space = match[2];
    const verb = match[3];
    if (start === undefined || !aux || !space || !verb) continue;
    const base = DID_BASE_VERB.get(verb.toLowerCase());
    if (!base) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-verb-form",
      dedupeKey: `verb-form:did-${verb.toLowerCase()}`,
      message: `Use the base verb "${base}" after "${aux}".`,
      suggestion: `${aux}${space}${base}`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  for (const match of text.matchAll(/\b(have|has|had)([ \t]+)([A-Za-z]+)\b/giu)) {
    const start = match.index;
    const aux = match[1];
    const space = match[2];
    const verb = match[3];
    if (start === undefined || !aux || !space || !verb) continue;
    const participle = HAVE_PARTICIPLE.get(verb.toLowerCase());
    if (!participle) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-verb-form",
      dedupeKey: `verb-form:${aux.toLowerCase()}-${verb.toLowerCase()}`,
      message: `Use past participle "${participle}" after "${aux}".`,
      suggestion: `${aux}${space}${participle}`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  for (const match of text.matchAll(
    /\b(could|should|would|must|might)([ \t]+)of(?=[ \t]+(?:been|had|done|made|built|taken|seen|gone|known|used|achieved|improved|reduced)\b)/giu,
  )) {
    const start = match.index;
    const modal = match[1];
    const space = match[2];
    if (start === undefined || !modal || !space) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-verb-form",
      dedupeKey: `verb-form:${modal.toLowerCase()}-of`,
      message: `Use "${modal} have" instead of "${modal} of".`,
      suggestion: `${modal}${space}have`,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  for (const match of text.matchAll(/\b([A-Za-z]+)\b/gu)) {
    const start = match.index;
    const word = match[1];
    if (start === undefined || !word) continue;
    const corrected = IRREGULAR_PAST_CORRECTIONS.get(word.toLowerCase());
    if (!corrected) continue;
    const end = start + word.length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    const cased = matchCase(word, corrected);
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-verb-form",
      dedupeKey: `verb-form:irregular:${word.toLowerCase()}`,
      message: `Non-standard verb form "${word}"; prefer "${cased}".`,
      suggestion: cased,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  // 5. Clear preposition errors
  for (const prep of PREPOSITION_FIXES) {
    for (const match of text.matchAll(prep.pattern)) {
      const start = match.index;
      const headWord = match[1];
      if (start === undefined || !headWord) continue;
      const end = start + match[0].length;
      if (overlapsAny(claimedSpans, start, end)) continue;
      claimedSpans.push({ start, end });
      out.push({
        ruleId: "grammar-preposition",
        dedupeKey: `preposition:${prep.key}`,
        message: prep.explanation,
        suggestion: `${headWord} ${prep.replacement}`,
        confidence: "high",
        status: "active",
        evidence: evidenceFor(block, start, end),
      });
    }
  }
}

function collectSpellingDetections(
  block: ResumeBlock,
  section: ResumeSection | undefined,
  checker: SpellChecker,
  ignoredSet: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
  claimedSpans: OffsetSpan[],
  out: RawDetection[],
): void {
  const text = block.text;
  const isContactSection = section?.kind === "CONTACT";
  const tokenPattern = /[A-Za-z]+(?:-[A-Za-z]+)*(?:['’][A-Za-z]+)*/gu;

  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index;
    const rawToken = match[0];
    if (start === undefined || rawToken.length <= 1) continue;
    const end = start + rawToken.length;

    if (overlapsAny(claimedSpans, start, end)) {
      continue;
    }

    // Skip tokens adjacent to digits/underscores/slashes/hashes/dots (code/path/handle fragments)
    const prevChar = start > 0 ? text[start - 1] : "";
    const nextChar = end < text.length ? text[end] : "";
    if (
      (prevChar !== undefined && /[0-9_/#+@.]/u.test(prevChar)) ||
      (nextChar !== undefined && /[0-9_/#+@]/u.test(nextChar))
    ) {
      continue;
    }

    const normalized = normalizeTermKey(rawToken);
    if (normalized.length <= 1) continue;

    // Owned by punctuationRule: never double-count missing-apostrophe contractions
    if (MISSING_APOSTROPHE_CONTRACTIONS.has(normalized)) {
      continue;
    }

    // Never penalize the candidate's own name or technical vocabulary
    if (candidateTokens.has(normalized) || isTechnicalTerm(rawToken)) {
      continue;
    }

    // Tokens with internal/trailing uppercase letters (PascalCase, camelCase, ALLCAPS, APIs, macOS)
    if (/[A-Z]/u.test(rawToken.slice(1))) {
      continue;
    }

    const isTitleCase = /^[A-Z][a-z]+(?:-[A-Za-z]+)*$/u.test(rawToken);
    if (isContactSection && !COMMON_MISSPELLINGS.has(normalized)) {
      continue;
    }

    if (isTitleCase) {
      // Conservative proper-noun handling (RUBRIC.md §5.1): capitalized words absent from the
      // dictionary (names, cities, companies, institutions) are NOT flagged unless they match
      // a known unambiguous misspelling (e.g. "Recieve", "Teh", "Developped", "Experiance").
      if (!COMMON_MISSPELLINGS.has(normalized)) {
        continue;
      }
    }

    const isMisspelled = COMMON_MISSPELLINGS.has(normalized) || !checker.correct(rawToken);
    if (!isMisspelled) {
      continue;
    }

    const isIgnored =
      ignoredSet.has(normalized) || ignoredSet.has(rawToken.trim().toLowerCase());
    const status: "active" | "ignored" = isIgnored ? "ignored" : "active";
    const suggestion = fastHighConfidenceSuggestion(rawToken, checker);

    claimedSpans.push({ start, end });
    out.push({
      ruleId: "grammar-spelling",
      dedupeKey: `spelling:${normalized}`,
      message: `Possible misspelling "${rawToken}".`,
      ...(suggestion !== undefined ? { suggestion } : {}),
      confidence: suggestion !== undefined ? "high" : "medium",
      status,
      evidence: evidenceFor(block, start, end),
    });
  }
}

function collectPunctuationDetections(
  block: ResumeBlock,
  claimedSpans: OffsetSpan[],
  out: RawDetection[],
): void {
  const text = block.text;

  // 1. Repeated punctuation (",,", ";;", "!!", "??", "::", and ".." excluding "...")
  for (const match of text.matchAll(/([,;:!?])\1+/gu)) {
    const start = match.index;
    const single = match[1];
    if (start === undefined || !single) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "punctuation-repeated",
      dedupeKey: `punct-repeated:${single}`,
      message: `Repeated punctuation "${match[0]}".`,
      suggestion: single,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  for (const match of text.matchAll(/(?<!\.)\.\.(?!\.)/gu)) {
    const start = match.index;
    if (start === undefined) continue;
    const end = start + 2;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "punctuation-repeated",
      dedupeKey: "punct-repeated:..",
      message: 'Repeated period "..".',
      suggestion: ".",
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  // 2. Unexpected space before clause/sentence punctuation ("word ,", "word .")
  for (const match of text.matchAll(/(?<=[A-Za-z0-9%)])[ \t]+([,;:!?]|\.(?=\s|$))/gu)) {
    const start = match.index;
    const punct = match[1];
    if (start === undefined || !punct) continue;
    const end = start + match[0].length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "punctuation-spacing",
      dedupeKey: `punct-space-before:${punct}`,
      message: `Remove space before "${punct}".`,
      suggestion: punct,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  // 3. Missing space after comma or semicolon between words ("APIs,deployed")
  for (const match of text.matchAll(/(?<=[A-Za-z])([,;])(?=[A-Za-z])/gu)) {
    const start = match.index;
    const punct = match[1];
    if (start === undefined || !punct) continue;
    const end = start + 1;
    if (overlapsAny(claimedSpans, start, end)) continue;
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "punctuation-spacing",
      dedupeKey: `punct-missing-space-after:${punct}`,
      message: `Add a space after "${punct}".`,
      suggestion: `${punct} `,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }

  // 4. Missing apostrophe in unambiguous contractions ("dont" -> "don't")
  for (const match of text.matchAll(/\b([A-Za-z]+)\b/gu)) {
    const start = match.index;
    const word = match[1];
    if (start === undefined || !word) continue;
    const replacement = MISSING_APOSTROPHE_CONTRACTIONS.get(word.toLowerCase());
    if (!replacement) continue;
    const end = start + word.length;
    if (overlapsAny(claimedSpans, start, end)) continue;
    const cased = matchCase(word, replacement);
    claimedSpans.push({ start, end });
    out.push({
      ruleId: "punctuation-apostrophe",
      dedupeKey: `punct-apostrophe:${word.toLowerCase()}`,
      message: `Missing apostrophe in "${word}".`,
      suggestion: cased,
      confidence: "high",
      status: "active",
      evidence: evidenceFor(block, start, end),
    });
  }
}

function collectBulletPeriodInconsistencies(
  document: ResumeDocument,
  sectionsById: ReadonlyMap<string, ResumeSection>,
  out: RawDetection[],
): void {
  const bullets = document.blocks.filter((block) => {
    if (block.type !== "bullet" || block.text.trim().length === 0) {
      return false;
    }
    const section = sectionsById.get(block.sectionId);
    return section !== undefined && BULLET_SECTIONS.has(section.kind);
  });

  // Consistent omission or consistent use of periods on bullets is never penalized (RUBRIC.md §5.3).
  if (bullets.length < 3) {
    return;
  }

  const withPeriod: ResumeBlock[] = [];
  const withoutPeriod: ResumeBlock[] = [];

  for (const bullet of bullets) {
    const trimmed = bullet.text.trimEnd();
    if (trimmed.endsWith(".")) {
      withPeriod.push(bullet);
    } else {
      withoutPeriod.push(bullet);
    }
  }

  if (withPeriod.length === 0 || withoutPeriod.length === 0) {
    return;
  }

  const minority =
    withPeriod.length < withoutPeriod.length ? withPeriod : withoutPeriod;

  for (const bullet of minority) {
    const trimmedLen = bullet.text.trimEnd().length;
    const start = Math.max(0, trimmedLen - 1);
    const end = Math.max(start + 1, trimmedLen);
    out.push({
      ruleId: "punctuation-bullet-consistency",
      dedupeKey: "punct-bullet-terminal-period",
      message:
        "Terminal periods are inconsistent across resume bullets; either end all bullets with a period or omit periods consistently.",
      confidence: "medium",
      status: "active",
      evidence: evidenceFor(bullet, start, end),
    });
  }
}

function findProtectedSpans(text: string): OffsetSpan[] {
  const spans: OffsetSpan[] = [];

  const addTrimmedUrls = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined) continue;
      const trimmed = match[0].replace(/[.,;:!?)\]]+$/u, "");
      if (trimmed.length > 0) {
        spans.push({ start, end: start + trimmed.length });
      }
    }
  };

  // URLs, domain paths, and email addresses
  addTrimmedUrls(/https?:\/\/[^\s<>"]+|www\.[^\s<>"]+/giu);
  addTrimmedUrls(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\/[A-Za-z0-9._~:/?#[\]@!$&'*+,;=%-]*/gu);
  for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu)) {
    if (match.index !== undefined) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  // Symbolic, dotted, and slashed technical tokens (C#, C++, .NET, Node.js, CI/CD, etc.)
  const technicalTokenPatterns = [
    /(?<![A-Za-z0-9])(?:[CFQ]#|[CG]\+\+)(?![A-Za-z0-9])/giu,
    /(?<![A-Za-z0-9])(?:ASP|VB)?\.NET\b/giu,
    /\b[A-Za-z][A-Za-z0-9-]*\.(?:js|ts|mjs|cjs|jsx|tsx|py|rb|go|rs|io|ai|dev|sh|css|vue|svelte)\b/gu,
    /\b(?:CI\/CD|TCP\/IP|UDP\/IP|HTTP\/[123](?:\.\d)?|I\/O|UI\/UX|UX\/UI|A\/B|R&D|P&L|PL\/SQL)\b/giu,
    /\bv?\d+(?:\.\d+)+(?:-[A-Za-z0-9.-]+)?\b/gu,
    /\b\d+(?:,\d{3})+(?:\.\d+)?\b/gu,
    /\b\d{1,2}:\d{2}(?::\d{2})?\b/gu,
  ];

  for (const pattern of technicalTokenPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) {
        spans.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }

  return spans;
}

function expectedIndefiniteArticle(rawWord: string): "a" | "an" | null {
  const head = rawWord.split("-")[0] ?? rawWord;
  if (head.length < 2) {
    return null;
  }
  // Skip all-caps / mixed-case acronyms ("SQL", "API", "UI", "URL", "SRE") whose spoken
  // initial sound can vary by reader ("a SQL" vs "an SQL")
  if (/[A-Z]/u.test(head.slice(1))) {
    return null;
  }

  const lower = head.toLowerCase();

  // Consonant-glide vowel spellings ("a user", "a unique", "a university", "a one-time")
  if (
    /^(?:uni(?:form\w*|fy\w*|fied|que\w*|t|ts|ted|ting|ty|vers\w*|lateral\w*)|use(?:r|rs|d|ful\w*|less\w*)?|usua\w*|util\w*|euro\w*|one|once)$/u.test(
      lower,
    )
  ) {
    return "a";
  }

  // Silent-h words ("an hour", "an honest", "an honor")
  if (/^(?:hour(?:s|ly)?|honest(?:ly|y)?|hono(?:u)?r(?:s|ed|ing|able|ably)?|heir(?:s|loom)?)$/u.test(lower)) {
    return "an";
  }

  // Unambiguous vowel-initial words (a, e except eu*, i, o except one/once)
  if (/^[aeio]/u.test(lower)) {
    if (lower.startsWith("eu") || lower.startsWith("ew")) {
      return null;
    }
    return "an";
  }

  // Unambiguous short-u words ("an update", "an upgrade", "an unhandled", "an urgent")
  if (
    /^(?:un(?:able|authorized|available|aware|balanced|bounded|changed|checked|clear|common|conditional|expected|familiar|finished|healthy|indexed|known|limited|locked|managed|matched|necessary|ordered|planned|processed|published|qualified|reachable|reliable|resolved|safe|signed|stable|structured|supported|tested|trusted|used|usual|verified)|under\w*|up(?:dat\w*|grad\w*|hold\w*|load\w*|stream\w*|time\w*)|urgent\w*|ultim\w*|umbr\w*)/u.test(
      lower,
    )
  ) {
    return "an";
  }

  // Other h* or u* words are left unflagged to avoid dialectal false positives ("a/an historic")
  if (lower.startsWith("h") || lower.startsWith("u")) {
    return null;
  }

  if (/^[bcdfgjklmnpqrstvwxyz]/u.test(lower)) {
    return "a";
  }

  return null;
}

function isAtClauseStart(text: string, index: number): boolean {
  const prefix = text.slice(0, index).trimEnd();
  if (prefix.length === 0) {
    return true;
  }
  const lastChar = prefix[prefix.length - 1];
  return lastChar === "." || lastChar === "!" || lastChar === "?" || lastChar === "\n";
}

function overlapsAny(spans: readonly OffsetSpan[], start: number, end: number): boolean {
  for (const span of spans) {
    if (start < span.end && end > span.start) {
      return true;
    }
  }
  return false;
}

function evidenceFor(block: ResumeBlock, startOffset: number, endOffset: number): EvidenceReference {
  return {
    blockId: block.id,
    startOffset,
    endOffset,
    ...(block.page !== undefined ? { page: block.page } : {}),
  };
}

function deduplicateDetections(prefix: string, detections: readonly RawDetection[]): EvaluationFinding[] {
  const grouped = new Map<
    string,
    {
      detection: RawDetection;
      evidenceMap: Map<string, EvidenceReference>;
    }
  >();

  for (const item of detections) {
    const groupKey = `${item.ruleId}|${item.status}|${item.dedupeKey}`;
    const refKey = `${item.evidence.blockId}:${item.evidence.startOffset}:${item.evidence.endOffset}`;
    const existing = grouped.get(groupKey);
    if (existing) {
      if (!existing.evidenceMap.has(refKey)) {
        existing.evidenceMap.set(refKey, item.evidence);
      }
      continue;
    }
    const evidenceMap = new Map<string, EvidenceReference>([[refKey, item.evidence]]);
    grouped.set(groupKey, { detection: item, evidenceMap });
  }

  const findings: EvaluationFinding[] = [];
  let index = 0;
  for (const { detection, evidenceMap } of grouped.values()) {
    index += 1;
    findings.push({
      id: `${prefix}-finding-${index}`,
      ruleId: detection.ruleId,
      category: GRAMMAR_CATEGORY,
      severity: "info",
      message: detection.message,
      ...(detection.suggestion !== undefined ? { suggestion: detection.suggestion } : {}),
      confidence: detection.confidence,
      evidence: [...evidenceMap.values()],
      status: detection.status,
    });
  }

  return findings;
}

function buildIgnoredSet(ignoredTerms: readonly string[] | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (!ignoredTerms) {
    return set;
  }
  for (const term of ignoredTerms) {
    const trimmed = term.trim().toLowerCase();
    if (trimmed.length > 0) {
      set.add(trimmed);
      const normalized = normalizeTermKey(trimmed);
      if (normalized.length > 0) {
        set.add(normalized);
      }
    }
  }
  return set;
}

function buildCandidateNameSet(candidateName: string | null | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (!candidateName) {
    return set;
  }
  for (const part of candidateName.split(/[\s,.-]+/u)) {
    const normalized = normalizeTermKey(part);
    if (normalized.length > 1) {
      set.add(normalized);
    }
  }
  return set;
}
