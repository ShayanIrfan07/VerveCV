export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResumeSectionKind =
  | "PROFESSIONAL_SUMMARY"
  | "WORK_EXPERIENCE"
  | "LEADERSHIP_EXPERIENCE"
  | "PROJECTS"
  | "EDUCATION"
  | "SKILLS"
  | "CERTIFICATIONS"
  | "CONTACT"
  | "OTHER";

export interface ResumeSection {
  id: string;
  kind: ResumeSectionKind;
  heading: string;
  blockIds: string[];
}

export interface ResumeBlock {
  id: string;
  sectionId: string;
  type: string;
  text: string;
  startOffset: number;
  endOffset: number;
  page?: number;
  boxes?: BoundingBox[];
  paragraphId?: string;
  style?: Record<string, unknown>;
}

export interface ResumeDocument {
  id: string;
  version: number;
  filename: string;
  mimeType: string;
  sourceHash: string;
  parserVersion: string;
  sections: ResumeSection[];
  blocks: ResumeBlock[];
  metadata: Record<string, unknown>;
}

export interface EvidenceReference {
  blockId: string;
  startOffset: number;
  endOffset: number;
  page?: number;
}

export interface EvaluationFinding {
  id: string;
  ruleId: string;
  category: string;
  severity: "info" | "warning" | "error";
  message: string;
  suggestion?: string;
  confidence: "high" | "medium" | "low";
  evidence: EvidenceReference[];
  status: "active" | "ignored" | "resolved";
}

export type RuleWithholdReasonCode =
  | "RULE_UNSPECIFIED"
  | "OPEN_DECISION"
  | "DICTIONARY_UNAVAILABLE"
  | "MISSING_CANDIDATE_TYPE"
  | "NO_APPLICABLE_ENTRIES"
  | "UNRESOLVED_BAND";

export interface RuleResultBase {
  ruleId: string;
  maxScore: number;
  findings: EvaluationFinding[];
  version: string;
}

export interface ScoredRuleResult extends RuleResultBase {
  status: "scored";
  score: number;
}

export interface WithheldRuleResult extends RuleResultBase {
  status: "withheld";
  score: null;
  reasonCode: RuleWithholdReasonCode;
}

export type RuleResult = ScoredRuleResult | WithheldRuleResult;

export type ScoreStatus = "PREVIEW_ONLY" | "PROVISIONAL" | "FINAL";
