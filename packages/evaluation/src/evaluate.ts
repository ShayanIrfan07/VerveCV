import { uniqueSkillScore } from "./bands.js";
import type {
  EvaluationFinding,
  EvidenceReference,
  ResumeBlock,
  ResumeDocument,
  ResumeSection,
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
}

export interface JdMatch {
  version: "jd-match-v1";
  appliedToScore: false;
}

export interface EvaluationResult {
  rubricVersion: string;
  scoreStatus: ScoreStatus;
  baseScore: number;
  penaltyTotal: number;
  finalScore: number;
  denominator: number;
  criteria: RuleResult[];
  jdMatch: JdMatch | null;
}

const BULLET_SECTIONS = new Set<ResumeSectionKind>(["WORK_EXPERIENCE", "LEADERSHIP_EXPERIENCE", "PROJECTS"]);
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
  ["formatting-consistency", CRITERION_MAXIMA.formattingConsistency, "OPEN_DECISION"],
  ["grammar-and-spelling", CRITERION_MAXIMA.grammarAndSpelling, "DICTIONARY_UNAVAILABLE"],
  ["readability", CRITERION_MAXIMA.readability, "OPEN_DECISION"],
  ["punctuation", CRITERION_MAXIMA.punctuation, "OPEN_DECISION"],
  ["entry-details", CRITERION_MAXIMA.entryDetails, "OPEN_DECISION"],
  ["education-details", CRITERION_MAXIMA.educationDetails, "OPEN_DECISION"],
  ["skills-ratio", CRITERION_MAXIMA.skillsRatio, "OPEN_DECISION"],
  ["industry-keywords", CRITERION_MAXIMA.industryKeywords, "OPEN_DECISION"],
];

export function evaluate(document: ResumeDocument, options: EvaluationOptions): EvaluationResult {
  const criteria = [
    ...bulletCriteria(document),
    filenameRule(document, options.candidateName),
    ...WITHHELD_RULES.map(([ruleId, maxScore, reasonCode]) => withheld(ruleId, maxScore, reasonCode)),
    requiredSections(document, options.candidateType),
    contactInformation(document, options.candidateName),
    uniqueSkills(document),
  ];
  const aggregated = aggregate(criteria);
  const withDescription = options.jobDescription !== null && options.jobDescription.trim().length > 0;
  return {
    rubricVersion: RUBRIC_VERSION,
    scoreStatus: "PROVISIONAL",
    ...aggregated,
    jdMatch: withDescription ? { version: "jd-match-v1", appliedToScore: false } : null,
  };
}

export function aggregate(criteria: RuleResult[]): Pick<EvaluationResult, "baseScore" | "penaltyTotal" | "finalScore" | "denominator" | "criteria"> {
  let baseScore = 0;
  let denominator = 0;
  for (const criterion of criteria) {
    if (criterion.status === "scored") {
      baseScore += criterion.score;
      denominator += criterion.maxScore;
    }
  }
  const penaltyTotal = 0;
  return {
    baseScore,
    penaltyTotal,
    finalScore: clamp(baseScore - penaltyTotal, 0, 100),
    denominator,
    criteria,
  };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function bulletCriteria(document: ResumeDocument): RuleResult[] {
  const eligible = eligibleBullets(document).length;
  if (eligible < 5) {
    const finding = findingFor(
      "bullet-unlock",
      "bulletQuality",
      "Bullet-quality criteria score 0 until there are at least five bullets in work experience, leadership, or projects.",
    );
    return BULLET_RULES.map(([ruleId, maxScore]) => scored(ruleId, maxScore, 0, [finding]));
  }
  return BULLET_RULES.map(([ruleId, maxScore]) => withheld(ruleId, maxScore, "OPEN_DECISION"));
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

function contactInformation(document: ResumeDocument, candidateName: string | null): RuleResult {
  const text = document.blocks.map((block) => block.text).join("\n");
  let points = 0;
  const findings: EvaluationFinding[] = [];
  if (hasName(document, candidateName)) {
    points += 1;
  } else {
    findings.push(findingFor("contact-name", "relevantInformation", "A candidate name was not found."));
  }
  if (PHONE.test(text) && digitCount(text.match(PHONE)?.[0] ?? "") >= 7) {
    points += 1;
  } else {
    findings.push(findingFor("contact-phone", "relevantInformation", "A phone number was not found."));
  }
  if (EMAIL.test(text)) {
    points += 1;
  } else {
    findings.push(findingFor("contact-email", "relevantInformation", "An email address was not found."));
  }
  if (LINKEDIN.test(text)) {
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
  return scored("unique-skills", CRITERION_MAXIMA.uniqueSkills, uniqueSkillScore(skills.size), []);
}

function filenameRule(document: ResumeDocument, candidateName: string | null): RuleResult {
  const maxScore = CRITERION_MAXIMA.filename;
  const tokens = nameTokens(candidateName);
  if (tokens.length === 0) {
    return withheld("resume-filename", maxScore, "OPEN_DECISION");
  }
  const stem = filenameStem(document.filename);
  const parts = stem.toLowerCase().split(/[^a-z]+/u).filter((part) => part.length > 0);
  const present = tokens.filter((token) => parts.includes(token) || parts.join("").includes(tokens.join("")));
  if (present.length === 0) {
    return scored("resume-filename", maxScore, 0, [
      findingFor("resume-filename", "formatting", "The filename does not contain the candidate name."),
    ]);
  }
  const pattern = /^[A-Za-z]+_Resume$/iu.test(stem) || /^Resume_[A-Za-z]+$/iu.test(stem) || /^[A-Za-z]+_[A-Za-z]+$/iu.test(stem);
  if (pattern && tokens.every((token) => parts.includes(token) || parts.join("").includes(tokens.join("")))) {
    return scored("resume-filename", maxScore, maxScore, []);
  }
  return withheld("resume-filename", maxScore, "UNRESOLVED_BAND");
}

function eligibleBullets(document: ResumeDocument): ResumeBlock[] {
  const sections = new Map(document.sections.map((section) => [section.id, section]));
  return document.blocks.filter((block) => block.type === "bullet" && isBulletSection(sections.get(block.sectionId)));
}

function isBulletSection(section: ResumeSection | undefined): boolean {
  return section !== undefined && BULLET_SECTIONS.has(section.kind);
}

function hasName(document: ResumeDocument, candidateName: string | null): boolean {
  const tokens = nameTokens(candidateName);
  if (tokens.length > 0) {
    const haystack = document.blocks.map((block) => block.text.toLowerCase()).join("\n");
    return tokens.every((token) => haystack.includes(token));
  }
  const first = document.blocks.find((block) => block.type !== "heading" && block.text.trim().length > 0);
  return first !== undefined && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/u.test(first.text.trim());
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

function splitSkills(text: string): string[] {
  return text.split(/[\n,;•●·]|(?:\s+-\s+)/u).map((part) => part.replace(/^[-*]\s+/u, "").trim()).filter((part) => part.length > 0);
}

function normalizeSkill(skill: string): string | null {
  if (EMAIL.test(skill) || PHONE.test(skill) || LINKEDIN.test(skill)) return null;
  if (/^\d+$/u.test(skill)) return null;
  const words = skill.split(/\s+/u).filter((word) => word.length > 0);
  if (skill.includes(".") && words.length >= 4) return null;
  const lower = skill.toLowerCase().trim();
  if (lower === "react" || lower === "react.js" || lower === "reactjs") return "react";
  return lower.replace(/\s+/gu, " ");
}

const PHONE = /(?:\+?\d[\d\s().-]{6,}\d)/u;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const LINKEDIN = /linkedin\.com\/(?:in|pub)\/[A-Za-z0-9_-]+/iu;

function digitCount(value: string): number {
  return value.replace(/\D/gu, "").length;
}

function scored(ruleId: string, maxScore: number, score: number, findings: EvaluationFinding[]): RuleResult {
  return { ruleId, maxScore, score, status: "scored", findings, version: RUBRIC_VERSION };
}

function withheld(ruleId: string, maxScore: number, reasonCode: RuleWithholdReasonCode): RuleResult {
  return { ruleId, maxScore, score: null, status: "withheld", reasonCode, findings: [], version: RUBRIC_VERSION };
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

