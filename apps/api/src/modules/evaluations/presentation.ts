export interface PublicEvidence {
  blockId: string;
  startOffset?: number;
  endOffset?: number;
  page?: number;
}

export interface PublicArea {
  label: string;
  state: "passed" | "review";
}

export interface PublicUnavailable {
  label: string;
  explanation: string;
}

export interface PublicEvaluation {
  id: string;
  resumeId: string;
  resumeVersionId: string;
  originalFilename: string;
  mimeType: string;
  status: "provisional" | "complete";
  score: number | null;
  notice: string;
  areas: PublicArea[];
  unavailable: PublicUnavailable[];
  createdAt: string;
}

export interface PublicFinding {
  id: string;
  kind: "issue" | "note";
  message: string;
  suggestion: string | null;
  evidence: PublicEvidence[];
}

export interface PublicHistoryItem {
  id: string;
  resumeId: string;
  resumeVersionId: string;
  originalFilename: string;
  mimeType: string;
  status: "provisional" | "complete";
  score: number | null;
  createdAt: string;
}

interface StoredCriterion {
  ruleId: string;
  maxScore: number;
  status: string;
  score: number | null;
  reasonCode?: string;
}

interface StoredFinding {
  id: string;
  ruleId: string;
  message: string;
  suggestion: string | null;
  evidence: unknown;
}

const LABELS: Record<string, string> = {
  "action-verbs": "Action verbs",
  "bullet-length": "Bullet length",
  "contact-information": "Contact information",
  "education-details": "Education details",
  "entry-details": "Entry details",
  "formatting-consistency": "Formatting consistency",
  "grammar-and-spelling": "Grammar and spelling",
  "impact-metrics": "Impact metrics",
  "industry-keywords": "Industry keywords",
  "minimum-bullets-per-role": "Bullets per role",
  punctuation: "Punctuation",
  "quantified-metrics": "Quantified metrics",
  readability: "Readability",
  "required-sections": "Required sections",
  "resume-filename": "Resume filename",
  "reverse-chronology": "Reverse chronology",
  "section-ordering": "Section order",
  "skills-ratio": "Skills ratio",
  "unique-skills": "Unique skills",
};

const CHECK_UNAVAILABLE = "This check is not yet available.";
const CRITERION_UNEVALUATED = "This criterion has not been evaluated.";
const SUGGESTIONS_UNEVALUATED = "Suggestions may appear below. This criterion has not been evaluated.";

const UNAVAILABLE_EXPLANATIONS: Record<string, string> = {
  "action-verbs": CHECK_UNAVAILABLE,
  "bullet-length": CHECK_UNAVAILABLE,
  "education-details": CRITERION_UNEVALUATED,
  "entry-details": CRITERION_UNEVALUATED,
  "formatting-consistency": SUGGESTIONS_UNEVALUATED,
  "grammar-and-spelling": SUGGESTIONS_UNEVALUATED,
  "impact-metrics": CHECK_UNAVAILABLE,
  "industry-keywords": CHECK_UNAVAILABLE,
  "minimum-bullets-per-role": CHECK_UNAVAILABLE,
  punctuation: SUGGESTIONS_UNEVALUATED,
  "quantified-metrics": CHECK_UNAVAILABLE,
  readability: CHECK_UNAVAILABLE,
  "reverse-chronology": CHECK_UNAVAILABLE,
  "section-ordering": CHECK_UNAVAILABLE,
  "skills-ratio": CHECK_UNAVAILABLE,
  "unique-skills": CRITERION_UNEVALUATED,
};

const PROVISIONAL_NOTICE = "This result is provisional and is not a complete 100-point score.";
const COMPLETE_NOTICE = "This is the complete score.";

export function presentEvaluation(input: {
  id: string;
  resumeId: string;
  resumeVersionId: string;
  originalFilename: string;
  mimeType: string;
  scoreStatus: string;
  baseScore: number | null;
  finalScore: number | null;
  criteria: unknown;
  jdMatch: unknown;
  createdAt: string;
}): PublicEvaluation {
  const status = publicStatus(input.scoreStatus, input.finalScore);
  const criteria = storedCriteria(input.criteria);
  const unavailable = criteria.filter((criterion) => criterion.status !== "scored").map(unavailableCheck);
  if (input.jdMatch !== null && input.jdMatch !== undefined) {
    unavailable.push({
      label: "Job description comparison",
      explanation: "Job description comparison is not available yet and does not change this score.",
    });
  }
  return {
    id: input.id,
    resumeId: input.resumeId,
    resumeVersionId: input.resumeVersionId,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    status,
    score: status === "complete" ? input.finalScore : input.baseScore,
    notice: status === "complete" ? COMPLETE_NOTICE : PROVISIONAL_NOTICE,
    areas: criteria.filter((criterion) => criterion.status === "scored").map(areaOf),
    unavailable,
    createdAt: input.createdAt,
  };
}

export function presentFindings(criteria: unknown, findings: StoredFinding[]): PublicFinding[] {
  const scored = storedCriteria(criteria).filter((criterion) => criterion.status === "scored");
  const visible: PublicFinding[] = [];
  for (const finding of findings) {
    const kind = findingKind(finding.ruleId, scored);
    if (kind === null) {
      continue;
    }
    visible.push({
      id: finding.id,
      kind,
      message: finding.message,
      suggestion: finding.suggestion,
      evidence: publicEvidence(finding.evidence),
    });
  }
  return visible.sort((left, right) => kindOrder(left.kind) - kindOrder(right.kind));
}

export function presentHistoryItem(input: {
  id: string;
  resumeId: string;
  resumeVersionId: string;
  originalFilename: string;
  mimeType: string;
  scoreStatus: string;
  baseScore: number | null;
  finalScore: number | null;
  createdAt: string;
}): PublicHistoryItem {
  const status = publicStatus(input.scoreStatus, input.finalScore);
  return {
    id: input.id,
    resumeId: input.resumeId,
    resumeVersionId: input.resumeVersionId,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    status,
    score: status === "complete" ? input.finalScore : input.baseScore,
    createdAt: input.createdAt,
  };
}

function publicStatus(scoreStatus: string, finalScore: number | null): "provisional" | "complete" {
  if (scoreStatus === "FINAL" && finalScore !== null) {
    return "complete";
  }
  return "provisional";
}

function areaOf(criterion: StoredCriterion): PublicArea {
  const passed = criterion.score !== null && criterion.score === criterion.maxScore;
  return {
    label: labelFor(criterion.ruleId),
    state: passed ? "passed" : "review",
  };
}

function unavailableCheck(criterion: StoredCriterion): PublicUnavailable {
  return {
    label: labelFor(criterion.ruleId),
    explanation: explanationFor(criterion),
  };
}

function labelFor(ruleId: string): string {
  return LABELS[ruleId] ?? "Additional check";
}

function explanationFor(criterion: StoredCriterion): string {
  if (criterion.ruleId === "resume-filename" && criterion.reasonCode === "UNRESOLVED_BAND") {
    return "The filename includes a name, but this criterion has not been evaluated.";
  }
  if (criterion.ruleId === "resume-filename" && criterion.reasonCode === "OPEN_DECISION") {
    return CHECK_UNAVAILABLE;
  }
  if (criterion.ruleId === "required-sections" && criterion.reasonCode === "MISSING_CANDIDATE_TYPE") {
    return "Select Fresher or Experienced before this check can run.";
  }
  if (criterion.reasonCode === "DICTIONARY_UNAVAILABLE") {
    return "Spelling could not be checked, so this criterion has not been evaluated.";
  }
  return UNAVAILABLE_EXPLANATIONS[criterion.ruleId] ?? CHECK_UNAVAILABLE;
}

function findingKind(ruleId: string, scored: readonly StoredCriterion[]): "issue" | "note" | null {
  const owner = scored.find((criterion) => findingBelongsTo(ruleId, criterion.ruleId));
  if (owner && owner.score !== null && owner.score < owner.maxScore) {
    return "issue";
  }
  if (ruleId.startsWith("grammar-") || ruleId.startsWith("punctuation-") || ruleId.startsWith("formatting-")) {
    return "note";
  }
  if (owner) {
    return "note";
  }
  return null;
}

function findingBelongsTo(findingRuleId: string, criterionRuleId: string): boolean {
  if (findingRuleId === criterionRuleId) {
    return true;
  }
  if (criterionRuleId === "contact-information") {
    return findingRuleId.startsWith("contact-");
  }
  if (criterionRuleId === "grammar-and-spelling") {
    return findingRuleId.startsWith("grammar-");
  }
  if (criterionRuleId === "punctuation") {
    return findingRuleId.startsWith("punctuation-");
  }
  return false;
}

function kindOrder(kind: "issue" | "note"): number {
  return kind === "issue" ? 0 : 1;
}

function storedCriteria(value: unknown): StoredCriterion[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "criteria" in value
      ? (value as { criteria?: unknown }).criteria
      : [];
  if (!Array.isArray(list)) {
    return [];
  }
  const criteria: StoredCriterion[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.ruleId !== "string" || typeof record.maxScore !== "number" || typeof record.status !== "string") {
      continue;
    }
    criteria.push({
      ruleId: record.ruleId,
      maxScore: record.maxScore,
      status: record.status,
      score: typeof record.score === "number" ? record.score : null,
      reasonCode: typeof record.reasonCode === "string" ? record.reasonCode : undefined,
    });
  }
  return criteria;
}

function publicEvidence(value: unknown): PublicEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const evidence: PublicEvidence[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.blockId !== "string" || record.blockId.length === 0) {
      continue;
    }
    const locator: PublicEvidence = { blockId: record.blockId };
    if (typeof record.startOffset === "number") {
      locator.startOffset = record.startOffset;
    }
    if (typeof record.endOffset === "number") {
      locator.endOffset = record.endOffset;
    }
    if (typeof record.page === "number") {
      locator.page = record.page;
    }
    evidence.push(locator);
  }
  return evidence;
}
