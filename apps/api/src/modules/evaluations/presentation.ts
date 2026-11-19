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

const UNAVAILABLE_EXPLANATIONS: Record<string, string> = {
  "action-verbs": "Action-verb scoring is not available yet. The approved verb list is still undecided.",
  "bullet-length": "Bullet-length scoring is not available yet. The measurement rules are still undecided.",
  "education-details": "Education details are not available yet. Partial credit has not been approved.",
  "entry-details": "Role and project details are not available yet. Partial credit has not been approved.",
  "formatting-consistency": "Formatting consistency is not available yet. The counting rules are still undecided.",
  "grammar-and-spelling": "Spelling and grammar notes may appear as suggestions. Their points are not available yet.",
  "impact-metrics": "Impact scoring is not available yet. The classifier is still undecided.",
  "industry-keywords": "Industry keyword scoring is not available yet. The role dictionaries are still undecided.",
  "minimum-bullets-per-role": "Bullets-per-role scoring is not available yet. The role recognizer is still undecided.",
  punctuation: "Punctuation notes may appear as suggestions. Their points are not available yet.",
  "quantified-metrics": "Quantified-metric scoring is not available yet. The recognizer is still undecided.",
  readability: "Readability is not available yet because no scoring method has been approved.",
  "reverse-chronology": "Date order is not available yet. How dates combine across sections is still undecided.",
  "section-ordering": "Section order is not available yet. The acceptable orders are still undecided.",
  "skills-ratio": "The technical-to-soft skills ratio is not available yet. The classification list has not been approved.",
  "unique-skills": "Unique-skill scoring is not available for this skill count. The approved band does not name it.",
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
      explanation: "The description was received. Comparison is not available yet and does not change this score.",
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
    return "The filename contains the candidate name, but it does not match an approved pattern, so these points are not available.";
  }
  if (criterion.ruleId === "resume-filename" && criterion.reasonCode === "OPEN_DECISION") {
    return "Filename scoring is not available because no candidate name could be compared.";
  }
  if (criterion.ruleId === "required-sections" && criterion.reasonCode === "MISSING_CANDIDATE_TYPE") {
    return "Required sections are not available until Fresher or Experienced is selected.";
  }
  if (criterion.reasonCode === "DICTIONARY_UNAVAILABLE") {
    return "Spelling could not be checked because the dictionary is unavailable, so these points are not available.";
  }
  return UNAVAILABLE_EXPLANATIONS[criterion.ruleId] ?? "This check is not available yet and is not included in the score.";
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
