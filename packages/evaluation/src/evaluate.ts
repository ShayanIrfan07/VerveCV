import { opensWithActionVerb } from "./action-verbs.js";
import { actionVerbScore, bulletLengthScore, impactScore, keywordMatchScore, quantifiedMetricScore, uniqueSkillScore } from "./bands.js";
import { assessBulletQuality } from "./bullets.js";
import { matchEntryBullets, type KeywordDictionary } from "./detectors.js";
import { parseEntries } from "./entries.js";
import { hasMeasurableImpact } from "./impact.js";
import { hasMeaningfulQuantity } from "./quantities.js";
import { measureRoles } from "./roles.js";
import { isTechnicalTerm } from "./technical-terms.js";
import { formattingConsistencyRule } from "./formatting.js";
import { grammarAndSpellingRule, punctuationRule, type SpellChecker } from "./grammar.js";
import type {
  EvaluationFinding,
  EvidenceReference,
  ResumeBlock,
  ResumeDocument,
  ResumeSectionKind,
  RuleResult,
  RuleWithholdReasonCode,
  ScoreStatus,
} from "./model.js";
import { CRITERION_MAXIMA, RUBRIC_VERSION } from "./rubric.js";

export type CandidateType = "FRESHER" | "EXPERIENCED";

export interface EvaluationOptions {
  candidateType: CandidateType | null;
  candidateName: string | null;
  jobDescription: string | null;
  ignoredTerms?: string[];
  spellChecker?: SpellChecker | null;
  /**
   * Caller-supplied keyword list. Absent, empty, malformed, or paired with an
   * ambiguous entry parse leaves industry keywords withheld. This is not a
   * production role vocabulary, and the API does not accept one from a client.
   */
  keywordDictionary?: KeywordDictionary;
}

export interface JdMatch {
  status: "not_implemented";
  appliedToScore: false;
}

export interface PenaltyAssessment {
  penaltyId: string;
  status: "not_evaluated" | "scored";
  deduction: number | null;
  reasonCode?: RuleWithholdReasonCode;
}

export interface EvaluationResult {
  rubricVersion: string;
  scoreStatus: ScoreStatus;
  baseScore: number;
  penaltyTotal: number | null;
  penaltyStatus: "not_evaluated" | "evaluated";
  penalties: PenaltyAssessment[];
  finalScore: number | null;
  denominator: number;
  criteria: RuleResult[];
  jdMatch: JdMatch | null;
}

/** Documented React spellings only. Further aliases need a new version. */
export const SKILL_ALIAS_VERSION = "skill-aliases-2026-11-12";

const SKILL_ALIASES: Record<string, string> = {
  react: "react",
  "react.js": "react",
  reactjs: "react",
};

const BULLET_RULES = [
  ["bullet-length", CRITERION_MAXIMA.bulletLength],
  ["action-verbs", CRITERION_MAXIMA.actionVerbs],
  ["quantified-metrics", CRITERION_MAXIMA.quantifiedMetrics],
  ["impact-metrics", CRITERION_MAXIMA.impactMetrics],
  ["minimum-bullets-per-role", CRITERION_MAXIMA.minimumBulletsPerRole],
] as const;

const WITHHELD_RULES: Array<[string, number, RuleWithholdReasonCode]> = [
  ["section-ordering", CRITERION_MAXIMA.sectionOrdering, "OPEN_DECISION"],
  ["reverse-chronology", CRITERION_MAXIMA.reverseChronology, "OPEN_DECISION"],
  ["readability", CRITERION_MAXIMA.readability, "OPEN_DECISION"],
  ["entry-details", CRITERION_MAXIMA.entryDetails, "OPEN_DECISION"],
  ["education-details", CRITERION_MAXIMA.educationDetails, "OPEN_DECISION"],
  ["skills-ratio", CRITERION_MAXIMA.skillsRatio, "OPEN_DECISION"],
];

export function evaluate(document: ResumeDocument, options: EvaluationOptions): EvaluationResult {
  const criteria = [
    ...bulletCriteria(document),
    filenameRule(document, options.candidateName, detectCandidateName(document)),
    grammarAndSpellingRule(document, {
      candidateName: options.candidateName,
      ignoredTerms: options.ignoredTerms,
      spellChecker: options.spellChecker,
    }),
    punctuationRule(document),
    formattingConsistencyRule(document),
    ...WITHHELD_RULES.map(([ruleId, maxScore, reasonCode]) => withheld(ruleId, maxScore, reasonCode)),
    industryKeywords(document, options.keywordDictionary),
    requiredSections(document, options.candidateType),
    contactInformation(document, options.candidateName, detectCandidateName(document)),
    uniqueSkills(document),
  ];
  const aggregated = aggregate(criteria, unevaluatedPenalties());
  const description = options.jobDescription?.trim() ?? "";
  return {
    rubricVersion: RUBRIC_VERSION,
    scoreStatus: "PROVISIONAL",
    ...aggregated,
    jdMatch: description.length > 0 ? { status: "not_implemented", appliedToScore: false } : null,
  };
}

export function aggregate(
  criteria: RuleResult[],
  penalties: PenaltyAssessment[],
): Pick<EvaluationResult, "baseScore" | "penaltyTotal" | "penaltyStatus" | "penalties" | "finalScore" | "denominator" | "criteria"> {
  let baseScore = 0;
  let denominator = 0;
  for (const criterion of criteria) {
    if (criterion.status === "scored") {
      baseScore += criterion.score;
      denominator += criterion.maxScore;
    }
  }
  const pending = penalties.some((penalty) => penalty.status !== "scored" || !Number.isFinite(penalty.deduction) || (penalty.deduction ?? 0) < 0);
  const penaltyTotal = pending ? null : penalties.reduce((sum, penalty) => sum + (penalty.deduction ?? 0), 0);
  return {
    baseScore,
    penaltyTotal,
    penaltyStatus: pending ? "not_evaluated" : "evaluated",
    penalties,
    finalScore: penaltyTotal === null || criteria.some((criterion) => criterion.status !== "scored") ? null : clamp(baseScore - penaltyTotal, 0, 100),
    denominator,
    criteria,
  };
}

function unevaluatedPenalties(): PenaltyAssessment[] {
  const open: Array<[string, RuleWithholdReasonCode]> = [
    ["short-resume", "OPEN_DECISION"],
    ["personal-pronouns", "OPEN_DECISION"],
    ["unprofessional-contact", "OPEN_DECISION"],
    ["inappropriate-language", "OPEN_DECISION"],
    ["personal-information", "OPEN_DECISION"],
    ["special-characters", "OPEN_DECISION"],
    ["duplication", "RULE_UNSPECIFIED"],
  ];
  return open.map(([penaltyId, reasonCode]) => ({ penaltyId, status: "not_evaluated", deduction: null, reasonCode }));
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function bulletCriteria(document: ResumeDocument): RuleResult[] {
  const assessment = assessBulletQuality(document);
  if (assessment.unlock === "below-minimum") {
    const finding = findingFor(
      "bullet-unlock",
      "bulletQuality",
      "Bullet-quality criteria score 0 until there are at least five bullets in work experience, leadership, or projects.",
    );
    return BULLET_RULES.map(([ruleId, maxScore]) => scored(ruleId, maxScore, 0, [finding]));
  }
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  const measured = assessment.length.readings
    .map((reading) => byId.get(reading.blockId))
    .filter((block): block is ResumeBlock => block !== undefined);
  return [
    lengthCriterion(assessment.length.readings, measured),
    verbCriterion(measured),
    quantityCriterion(measured),
    impactCriterion(measured),
    roleCriterion(document),
  ];
}

function lengthCriterion(readings: ReadonlyArray<{ blockId: string; meetsMinimum: boolean }>, blocks: readonly ResumeBlock[]): RuleResult {
  const maxScore = CRITERION_MAXIMA.bulletLength;
  if (readings.length === 0) {
    return scored("bullet-length", maxScore, 0, []);
  }
  const band = bulletLengthScore((readings.filter((reading) => reading.meetsMinimum).length / readings.length) * 100);
  if (band.status === "withheld") {
    return withheld("bullet-length", maxScore, "UNRESOLVED_BAND");
  }
  return scored(
    "bullet-length",
    maxScore,
    band.score,
    findingsFor(blocks.filter((_, index) => readings[index]?.meetsMinimum === false), "bullet-length", "This bullet is shorter than the length check allows."),
  );
}

function verbCriterion(blocks: readonly ResumeBlock[]): RuleResult {
  const maxScore = CRITERION_MAXIMA.actionVerbs;
  return percentCriterion(blocks, maxScore, "action-verbs", (block) => opensWithActionVerb(block.text), actionVerbScore, "Start this bullet with an action verb.");
}

function quantityCriterion(blocks: readonly ResumeBlock[]): RuleResult {
  const maxScore = CRITERION_MAXIMA.quantifiedMetrics;
  const hits = blocks.filter((block) => hasMeaningfulQuantity(block.text)).length;
  const percent = blocks.length === 0 ? 0 : (hits / blocks.length) * 100;
  const band = quantifiedMetricScore(percent);
  if (band.status === "withheld") {
    return withheld("quantified-metrics", maxScore, "UNRESOLVED_BAND");
  }
  const findings = band.score === maxScore
    ? []
    : findingsFor(blocks.filter((block) => !hasMeaningfulQuantity(block.text)), "quantified-metrics", "This bullet does not include a measurable quantity.");
  return scored("quantified-metrics", maxScore, band.score, findings);
}

function impactCriterion(blocks: readonly ResumeBlock[]): RuleResult {
  const maxScore = CRITERION_MAXIMA.impactMetrics;
  const quantified = blocks.filter((block) => hasMeaningfulQuantity(block.text));
  const impacted = quantified.filter((block) => hasMeasurableImpact(block.text));
  const quantifiedPercent = blocks.length === 0 ? 0 : (quantified.length / blocks.length) * 100;
  const impactPercent = quantified.length === 0 ? 0 : (impacted.length / quantified.length) * 100;
  const band = impactScore(quantifiedPercent, impactPercent);
  if (band.status === "withheld") {
    return withheld("impact-metrics", maxScore, "UNRESOLVED_BAND");
  }
  const weak = blocks.filter((block) => !hasMeasurableImpact(block.text) && (hasMeaningfulQuantity(block.text) || /\b(?:improv|reduc|increas)/iu.test(block.text)));
  return scored("impact-metrics", maxScore, band.score, band.score === maxScore ? [] : findingsFor(weak, "impact-metrics", "This bullet does not state a measurable outcome."));
}

function roleCriterion(document: ResumeDocument): RuleResult {
  const maxScore = CRITERION_MAXIMA.minimumBulletsPerRole;
  const measured = measureRoles(document);
  if (measured === null || measured.band.status === "withheld") {
    return withheld("minimum-bullets-per-role", maxScore, measured === null ? "OPEN_DECISION" : "UNRESOLVED_BAND");
  }
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  const blocks = measured.shortBlockIds
    .map((id) => byId.get(id))
    .filter((block): block is ResumeBlock => block !== undefined);
  return scored(
    "minimum-bullets-per-role",
    maxScore,
    measured.band.score,
    measured.band.score === maxScore ? [] : findingsFor(blocks, "minimum-bullets-per-role", "This role has fewer bullets than the check allows."),
  );
}

function percentCriterion(
  blocks: readonly ResumeBlock[],
  maxScore: number,
  ruleId: string,
  passes: (block: ResumeBlock) => boolean,
  scoreBand: (percent: number) => { status: "scored"; score: number } | { status: "withheld" },
  message: string,
): RuleResult {
  const percent = blocks.length === 0 ? 0 : (blocks.filter(passes).length / blocks.length) * 100;
  const band = scoreBand(percent);
  if (band.status === "withheld") {
    return withheld(ruleId, maxScore, "UNRESOLVED_BAND");
  }
  return scored(ruleId, maxScore, band.score, band.score === maxScore ? [] : findingsFor(blocks.filter((block) => !passes(block)), ruleId, message));
}

function findingsFor(blocks: readonly ResumeBlock[], ruleId: string, message: string): EvaluationFinding[] {
  return blocks.map((block) => ({
    id: `${ruleId}:${block.id}`,
    ruleId,
    category: "bulletQuality",
    severity: "warning" as const,
    message,
    confidence: "high" as const,
    evidence: [{ blockId: block.id, startOffset: 0, endOffset: block.text.length, ...(block.page === undefined ? {} : { page: block.page }) }],
    status: "active" as const,
  }));
}

function requiredSections(document: ResumeDocument, candidateType: CandidateType | null): RuleResult {
  const maxScore = CRITERION_MAXIMA.requiredSections;
  if (candidateType === null) {
    return withheld("required-sections", maxScore, "MISSING_CANDIDATE_TYPE");
  }
  const kinds = new Set(document.sections.map((section) => section.kind));
  const experience = kinds.has("WORK_EXPERIENCE") || kinds.has("LEADERSHIP_EXPERIENCE") || kinds.has("PROJECTS");
  const present =
    candidateType === "FRESHER"
      ? kinds.has("EDUCATION") && kinds.has("SKILLS") && experience
      : kinds.has("WORK_EXPERIENCE") && kinds.has("EDUCATION") && kinds.has("SKILLS");
  return scored("required-sections", maxScore, present ? maxScore : 0, []);
}

function contactInformation(
  document: ResumeDocument,
  candidateName: string | null,
  detectedName: string | null,
): RuleResult {
  const blocks = contactBlocks(document);
  const text = blocks.map((block) => block.text).join("\n");
  const links = hyperlinks(document);
  let points = 0;
  const findings: EvaluationFinding[] = [];
  if (detectedName !== null || hasSuppliedName(blocks, candidateName)) {
    points += 1;
  } else {
    findings.push(findingFor("contact-name", "relevantInformation", "A candidate name was not found."));
  }
  const phone = text.match(PHONE)?.[0] ?? "";
  if (PHONE.test(text) && digitCount(phone) >= 7) {
    points += 1;
  } else {
    findings.push(findingFor("contact-phone", "relevantInformation", "A phone number was not found."));
  }
  if (EMAIL.test(text)) {
    points += 1;
  } else {
    findings.push(findingFor("contact-email", "relevantInformation", "An email address was not found."));
  }
  if (hasLinkedInProfile(text) || links.some((link) => hasLinkedInProfile(link))) {
    points += 1;
  } else {
    findings.push(findingFor("contact-linkedin", "relevantInformation", "A LinkedIn profile URL was not found."));
  }
  return scored("contact-information", CRITERION_MAXIMA.contactInformation, points, findings);
}

function uniqueSkills(document: ResumeDocument): RuleResult {
  const skills = new Set<string>();
  for (const section of document.sections) {
    if (section.kind !== "SKILLS") continue;
    for (const blockId of section.blockIds) {
      const block = document.blocks.find((item) => item.id === blockId);
      if (!block || block.type === "heading") continue;
      for (const skill of splitSkills(block.text)) {
        const normalized = normalizeSkill(skill);
        if (normalized) skills.add(normalized);
      }
    }
  }
  const points = uniqueSkillScore(skills.size);
  if (points === null) {
    return withheld("unique-skills", CRITERION_MAXIMA.uniqueSkills, "OPEN_DECISION");
  }
  return scored("unique-skills", CRITERION_MAXIMA.uniqueSkills, points, []);
}

function filenameRule(
  document: ResumeDocument,
  candidateName: string | null,
  detectedName: string | null,
): RuleResult {
  const maxScore = CRITERION_MAXIMA.filename;
  const tokens = nameTokens(detectedName ?? candidateName);
  if (tokens.length === 0) {
    return withheld("resume-filename", maxScore, "OPEN_DECISION");
  }
  const stem = filenameStem(document.filename);
  const parts = filenameNameParts(stem);
  if (!filenameContainsName(parts, tokens)) {
    return scored("resume-filename", maxScore, 0, [
      findingFor("resume-filename", "formatting", "The filename does not contain the candidate name."),
    ]);
  }
  if (approvedFilenamePattern(stem, tokens)) {
    return scored("resume-filename", maxScore, maxScore, []);
  }
  return withheld("resume-filename", maxScore, "UNRESOLVED_BAND", [
    findingFor(
      "resume-filename",
      "formatting",
      "The filename contains the candidate name, but it does not match an approved pattern, so these points are not available.",
    ),
  ]);
}

function contactBlocks(document: ResumeDocument): ResumeBlock[] {
  const sections = new Map(document.sections.map((section) => [section.id, section]));
  if (document.sections.length === 0) {
    return document.blocks.filter((block) => block.type !== "heading");
  }
  return document.blocks.filter((block) => {
    const section = sections.get(block.sectionId);
    if (section === undefined || block.type === "heading") return false;
    return section.kind === "CONTACT" || (section.kind === "OTHER" && section.heading.trim().length === 0);
  });
}

function hasSuppliedName(blocks: ResumeBlock[], candidateName: string | null): boolean {
  const tokens = nameTokens(candidateName);
  if (tokens.length === 0) {
    return false;
  }
  const haystack = blocks.map((block) => block.text.toLowerCase()).join("\n");
  return tokens.every((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, "u").test(haystack));
}

const NAME_STOPWORDS = new Set([
  "college",
  "curriculum",
  "developer",
  "education",
  "email",
  "engineer",
  "experience",
  "github",
  "intern",
  "junior",
  "linkedin",
  "manager",
  "phone",
  "professional",
  "profile",
  "projects",
  "resume",
  "senior",
  "skills",
  "software",
  "student",
  "summary",
  "university",
  "vitae",
]);

function detectCandidateName(document: ResumeDocument): string | null {
  const blocks = contactBlocks(document).filter((block) => block.text.trim().length > 0);
  for (let index = 0; index < Math.min(blocks.length, 6); index += 1) {
    const block = blocks[index];
    if (!block) {
      continue;
    }
    const joined = joinSplitName(block, blocks[index + 1]);
    const detected = nameFromLine(joined, lineHasContact(joined) || lineHasContact(blocks[index + 1]?.text ?? ""));
    if (detected) {
      return detected;
    }
  }
  return null;
}

function joinSplitName(current: ResumeBlock, next: ResumeBlock | undefined): string {
  if (!next || !singleNameToken(current.text) || !singleNameToken(next.text)) {
    return current.text;
  }
  if (!verticallyAligned(current, next)) {
    return current.text;
  }
  return `${current.text.trim()} ${next.text.trim()}`;
}

function singleNameToken(value: string): boolean {
  return nameTokensFromLine(value).length === 1 && !NAME_STOPWORDS.has(nameTokensFromLine(value)[0]?.toLowerCase() ?? "");
}

function verticallyAligned(current: ResumeBlock, next: ResumeBlock): boolean {
  const left = current.boxes?.[0];
  const right = next.boxes?.[0];
  if (!left || !right) {
    return current.page === undefined || next.page === undefined || current.page === next.page;
  }
  return left.page === right.page && Math.abs(left.y - right.y) <= 4;
}

function nameFromLine(value: string, allowLowercase: boolean): string | null {
  const tokens = nameTokensFromLine(value);
  if (tokens.length < 2 || tokens.length > 4) {
    return null;
  }
  if (tokens.some((token) => NAME_STOPWORDS.has(token.toLowerCase()))) {
    return null;
  }
  const capitalized = tokens.every((token) => /^[\p{Lu}][\p{Ll}'’-]+$/u.test(token));
  const allCaps = tokens.every((token) => /^[\p{Lu}]{2,}$/u.test(token));
  const lowercase = tokens.every((token) => /^[\p{Ll}][\p{Ll}'’-]+$/u.test(token));
  if (capitalized || allCaps || (allowLowercase && lowercase)) {
    return tokens.join(" ");
  }
  return null;
}

function nameTokensFromLine(value: string): string[] {
  const normalized = value.normalize("NFKC").replace(/\p{Z}+/gu, " ").trim().split(/\n/u)[0] ?? "";
  const leading = normalized.split(/\s*(?:\||•|●|·)\s*|\s{2,}/u)[0] ?? normalized;
  const withoutContact =
    leading.split(/\s+(?=\S+@|\+?\d[\d\s().-]{6,}|(?:https?:\/\/)?(?:www\.)?(?:linkedin|github)\.)/iu)[0] ?? leading;
  return withoutContact
    .split(/\s+/u)
    .flatMap((token) => (isTechnicalTerm(token) ? [token] : token.split(/(?<=\p{Ll})(?=\p{Lu})/u)))
    .map((token) => token.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, ""))
    .filter((token) => token.length > 1);
}

function lineHasContact(value: string): boolean {
  return EMAIL.test(value) || PHONE.test(value) || /linkedin\.com|github\.com/iu.test(value);
}

function nameTokens(candidateName: string | null): string[] {
  if (candidateName === null) return [];
  return candidateName
    .toLowerCase()
    .split(/\s+/u)
    .map((token) => token.replace(/[^a-z]/gu, ""))
    .filter((token) => token.length > 0);
}

function filenameStem(filename: string): string {
  const base = filename.split(/[\\/]/u).at(-1) ?? filename;
  return base.replace(/\.[^.]+$/u, "");
}

const GENERIC_FILENAME_TOKENS = new Set(["cv", "curriculum", "profile", "resume", "vitae"]);

function filenameNameParts(stem: string): string[] {
  const expanded = stem.normalize("NFKC").replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
  return expanded
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((part) => part.length > 0 && !GENERIC_FILENAME_TOKENS.has(part));
}

function filenameContainsName(parts: string[], tokens: string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  if (parts.some((part) => part === tokens.join(""))) {
    return true;
  }
  const unused = [...parts];
  for (const token of tokens) {
    const index = unused.indexOf(token);
    if (index < 0) {
      return false;
    }
    unused.splice(index, 1);
  }
  return true;
}

function approvedFilenamePattern(stem: string, tokens: string[]): boolean {
  if (!filenameContainsName(filenameNameParts(stem), tokens)) {
    return false;
  }
  if (/^Resume_[A-Za-z]+$/iu.test(stem) || /^[A-Za-z]+_Resume$/iu.test(stem)) {
    return true;
  }
  const parts = stem.split("_");
  if (parts.length !== 2 || parts.some((part) => GENERIC_FILENAME_TOKENS.has(part.toLowerCase()))) {
    return false;
  }
  return /^[A-Za-z]+_[A-Za-z]+$/iu.test(stem);
}

function splitSkills(text: string): string[] {
  return text
    .split(/[\n\t,;|•●·]|(?:\s+\/\s+)|(?:\s+-\s+)/u)
    .map((part) => part.replace(/^[-*]\s+/u, "").trim())
    .filter((part) => part.length > 0);
}

function normalizeSkill(skill: string): string | null {
  if (EMAIL.test(skill) || PHONE.test(skill) || hasLinkedInProfile(skill)) return null;
  if (/^\d+$/u.test(skill)) return null;
  const words = skill.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length > 5 || /[.!?]["']?$/u.test(skill) || /\.\s+\p{L}/u.test(skill)) return null;
  const lower = skill.toLowerCase().trim().replace(/\s+/gu, " ");
  return SKILL_ALIASES[lower] ?? lower;
}

const PHONE = /(?:\+?\d[\d\s().-]{6,}\d)/u;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const LINKEDIN_RESERVED = new Set([
  "about",
  "company",
  "companies",
  "events",
  "feed",
  "groups",
  "help",
  "job",
  "jobs",
  "learning",
  "legal",
  "login",
  "messaging",
  "mwlite",
  "notifications",
  "posts",
  "premium",
  "pulse",
  "sales",
  "school",
  "schools",
  "search",
  "signup",
  "talent",
]);

function hyperlinks(document: ResumeDocument): string[] {
  const value = document.metadata["hyperlinks"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function hasLinkedInProfile(value: string): boolean {
  const pattern = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_%-]+))?/giu;
  for (const match of value.matchAll(pattern)) {
    const first = match[1]?.toLowerCase() ?? "";
    const second = match[2] ?? "";
    if (first === "in" || first === "pub") {
      if (/[A-Za-z]/u.test(second) && second.length >= 2) {
        return true;
      }
      continue;
    }
    if (!LINKEDIN_RESERVED.has(first) && first.length >= 3 && /[A-Za-z]/u.test(first) && second.length === 0) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function digitCount(value: string): number {
  return value.replace(/\D/gu, "").length;
}

function keywordRequirement(kind: ResumeSectionKind): number | null {
  if (kind === "WORK_EXPERIENCE") {
    return 8;
  }
  if (kind === "LEADERSHIP_EXPERIENCE" || kind === "PROJECTS") {
    return 2;
  }
  return null;
}

function industryKeywords(document: ResumeDocument, dictionary: KeywordDictionary | undefined): RuleResult {
  const maxScore = CRITERION_MAXIMA.industryKeywords;
  if (!usableKeywordDictionary(dictionary)) {
    return withheld("industry-keywords", maxScore, "OPEN_DECISION");
  }
  const parsed = parseEntries(document);
  if (parsed.issues.length > 0 || parsed.entries.length === 0) {
    return withheld("industry-keywords", maxScore, "OPEN_DECISION");
  }
  const text = new Map(document.blocks.map((block) => [block.id, block.text]));
  const completions: number[] = [];
  for (const entry of parsed.entries) {
    const required = keywordRequirement(entry.sectionKind);
    if (required === null) {
      return withheld("industry-keywords", maxScore, "OPEN_DECISION");
    }
    const bullets = entry.bulletBlockIds.map((id) => text.get(id) ?? "");
    const found = matchEntryBullets(bullets, dictionary, entry.id).length;
    completions.push(Math.min(found / required, 1));
  }
  const band = keywordMatchScore(completions);
  if (band.status !== "scored") {
    return withheld("industry-keywords", maxScore, "OPEN_DECISION");
  }
  return scored("industry-keywords", maxScore, band.score, []);
}

function usableKeywordDictionary(value: KeywordDictionary | undefined): value is KeywordDictionary {
  if (value === undefined || typeof value.version !== "string" || value.version.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(value.terms) || value.terms.length === 0) {
    return false;
  }
  const ids = new Set<string>();
  for (const term of value.terms) {
    if (typeof term !== "object" || term === null) {
      return false;
    }
    if (typeof term.id !== "string" || term.id.trim().length === 0 || ids.has(term.id)) {
      return false;
    }
    ids.add(term.id);
    if (typeof term.canonical !== "string" || term.canonical.normalize("NFKC").trim().length === 0) {
      return false;
    }
    if (!usablePhrases(term.aliases)) {
      return false;
    }
    if (term.excludes !== undefined && !usablePhrases(term.excludes)) {
      return false;
    }
  }
  return true;
}

function usablePhrases(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((phrase: unknown) => typeof phrase === "string" && phrase.normalize("NFKC").trim().length > 0);
}

function scored(ruleId: string, maxScore: number, score: number, findings: EvaluationFinding[]): RuleResult {
  if (!Number.isFinite(score) || score < 0 || score > maxScore) {
    throw new Error(`${ruleId} score ${score} is outside 0..${maxScore}`);
  }
  return { ruleId, maxScore, score, status: "scored", findings, version: RUBRIC_VERSION };
}

function withheld(
  ruleId: string,
  maxScore: number,
  reasonCode: RuleWithholdReasonCode,
  findings: EvaluationFinding[] = [],
): RuleResult {
  return { ruleId, maxScore, score: null, status: "withheld", reasonCode, findings, version: RUBRIC_VERSION };
}

function findingFor(ruleId: string, category: string, message: string): EvaluationFinding {
  const evidence: EvidenceReference[] = [];
  return {
    id: ruleId,
    ruleId,
    category,
    severity: "info",
    message,
    confidence: "high",
    evidence,
    status: "active",
  };
}
