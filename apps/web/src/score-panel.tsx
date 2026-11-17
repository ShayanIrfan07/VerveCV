export interface EvidenceLocator {
  blockId: string;
  startOffset?: number;
  endOffset?: number;
  page?: number;
}

export interface ScoreCriterion {
  ruleId: string;
  maxScore: number;
  status: "scored" | "withheld";
  score: number | null;
  reasonCode?: string;
}

export interface ScoreFinding {
  id?: string;
  ruleId: string;
  category?: string;
  severity?: string;
  message: string;
  suggestion?: string | null;
  confidence?: string;
  evidence: EvidenceLocator[];
}

export interface ScoreView {
  id: string;
  resumeId: string;
  resumeVersionId: string;
  originalFilename?: string;
  mimeType?: string;
  scoreStatus: string;
  baseScore: number | null;
  denominator: number;
  penaltyTotal: number | null;
  penaltyStatus: string;
  finalScore: number | null;
  rubricVersion: string;
  criteria: ScoreCriterion[];
  jdMatch: { status?: string; appliedToScore?: boolean } | null;
  createdAt: string;
}

export interface HistoryItem {
  id: string;
  resumeId: string;
  resumeVersionId: string;
  originalFilename?: string;
  mimeType?: string;
  scoreStatus: string;
  baseScore: number | null;
  denominator: number;
  penaltyStatus: string;
  finalScore: number | null;
  createdAt: string;
}

export interface HistoryPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export function ScorePanel({
  evaluation,
  findings,
  activeHighlight,
  previewUnavailableReason,
  onHighlight,
  onPreview,
}: {
  evaluation: ScoreView;
  findings: ScoreFinding[];
  activeHighlight: EvidenceLocator | null;
  previewUnavailableReason?: string | null;
  onHighlight: (locator: EvidenceLocator | null) => void;
  onPreview?: () => void;
}) {
  const scored = evaluation.criteria.filter((criterion) => criterion.status === "scored");
  const withheld = evaluation.criteria.filter((criterion) => criterion.status === "withheld");
  const passed = scored.filter((criterion) => criterion.score === criterion.maxScore);
  const deductions = findings.filter((finding) =>
    scored.some(
      (criterion) =>
        criterion.score !== null &&
        criterion.score < criterion.maxScore &&
        findingBelongsTo(finding.ruleId, criterion.ruleId),
    ),
  );
  const notes = findings.filter((finding) => {
    if (deductions.includes(finding)) {
      return false;
    }
    if (finding.ruleId.startsWith("grammar-") || finding.ruleId.startsWith("punctuation-")) {
      return true;
    }
    return scored.some((criterion) => findingBelongsTo(finding.ruleId, criterion.ruleId));
  });
  const scoreText = `${evaluation.baseScore ?? "—"}/${evaluation.denominator}`;
  const allPassed = scored.length > 0 && passed.length === scored.length;

  return (
    <section className="rounded-2xl border border-line bg-card p-5 text-ink sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">Resume analysis</h2>
        <button
          className="shrink-0 rounded-full border border-line bg-panel px-3 py-1 text-xs text-ink hover:border-primary-bright hover:text-primary-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright"
          onClick={onPreview}
          type="button"
        >
          Preview
        </button>
      </div>
      {evaluation.originalFilename ? (
        <p className="mt-2 max-w-full truncate text-sm text-muted">{evaluation.originalFilename}</p>
      ) : null}

      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="grid h-28 w-28 shrink-0 place-items-center rounded-full border border-primary text-center">
          <span>
            <span className="block text-xl font-semibold text-primary">{scoreText}</span>
            <span className="mt-0.5 block text-xs text-muted">Evaluated</span>
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">
            {passed.length} {passed.length === 1 ? "check" : "checks"} passed
          </p>
          <p className="mt-1 max-w-xl text-sm leading-6 text-muted">
            {allPassed
              ? "Your resume has passed the currently available checks. Full analysis is still being developed."
              : "Some available checks are incomplete. Full analysis is still being developed."}
          </p>
        </div>
      </div>

      {previewUnavailableReason ? (
        <p
          className="mt-4 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-danger"
          data-testid="preview-unavailable-notice"
        >
          {previewUnavailableReason}
        </p>
      ) : null}

      <div className="mt-6 border-t border-line" />
      <ul className="divide-y divide-line">
        {scored.map((criterion) => (
          <li key={criterion.ruleId} className="flex items-center justify-between gap-4 py-3.5 text-sm">
            <span className="text-ink">{criterionLabel(criterion.ruleId)}</span>
            <span className="shrink-0 font-medium text-primary">
              {criterion.score}/{criterion.maxScore}
            </span>
          </li>
        ))}
      </ul>

      <div className="border-t border-line" />
      <h3 className="mt-5 text-base font-semibold text-ink">Suggestions to review</h3>
      {deductions.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted">
          No confirmed issues in the scored checks. Other checks are not yet available.
        </p>
      ) : null}
      {deductions.length > 0 || notes.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {[...deductions, ...notes].map((finding, index) => {
            const primary = primaryLocator(finding.evidence);
            const isSelected =
              primary !== null &&
              activeHighlight !== null &&
              activeHighlight.blockId === primary.blockId &&
              activeHighlight.startOffset === primary.startOffset &&
              activeHighlight.endOffset === primary.endOffset;
            return (
              <li key={finding.id ?? `${finding.ruleId}-${finding.message}-${index}`}>
                <button
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright ${
                    isSelected ? "bg-panel text-primary-bright" : "bg-panel/70"
                  }`}
                  onClick={() => onHighlight(primary)}
                  onFocus={() => onHighlight(primary)}
                  onMouseEnter={() => onHighlight(primary)}
                  onMouseLeave={() => onHighlight(null)}
                  type="button"
                >
                  <span>{finding.message}</span>
                  {finding.suggestion ? (
                    <span className="mt-0.5 block text-xs text-muted">Suggestion: {finding.suggestion}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <details className="mt-5 border-t border-line pt-4">
        <summary className="cursor-pointer text-sm font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright">
          Checks not yet available ({withheld.length})
        </summary>
        <ul className="mt-3 grid gap-3">
          {withheld.map((criterion) => (
            <li key={criterion.ruleId}>
              <p className="text-sm text-ink">{criterionLabel(criterion.ruleId)}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted">{withheldExplanation(criterion)}</p>
            </li>
          ))}
          {evaluation.jdMatch?.status === "not_implemented" ? (
            <li>
              <p className="text-sm text-ink">Job description comparison</p>
              <p className="mt-0.5 text-xs leading-5 text-muted">
                The description was received. Comparison is not available yet and does not change this score.
              </p>
            </li>
          ) : null}
        </ul>
      </details>
    </section>
  );
}

export function HistoryList({
  items,
  activeEvaluationId,
  hasMore = false,
  onOpen,
  onLoadMore,
}: {
  items: HistoryItem[];
  activeEvaluationId?: string | null;
  hasMore?: boolean;
  onOpen: (item: HistoryItem) => void;
  onLoadMore?: () => void;
}) {
  return (
    <section className="rounded-2xl border border-line bg-card p-5 text-ink">
      <h2 className="text-lg font-semibold text-ink">Score history</h2>
      {items.length === 0 ? <p className="mt-2 text-sm text-muted">No scores yet.</p> : null}
      <ul className="mt-3 grid gap-2">
        {items.map((item) => {
          const active = activeEvaluationId === item.id;
          return (
            <li key={item.id}>
              <button
                className={`w-full rounded-lg px-3 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright ${
                  active ? "bg-panel font-medium text-primary-bright" : "bg-panel/60 text-ink"
                }`}
                onClick={() => onOpen(item)}
                type="button"
              >
                <span>
                  {item.baseScore ?? "—"}/{item.denominator}
                </span>
                {item.originalFilename ? (
                  <span className="mt-0.5 block truncate text-xs font-normal text-muted">
                    {item.originalFilename}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && onLoadMore ? (
        <button
          className="mt-3 rounded-lg border border-primary-muted bg-panel px-3 py-1.5 text-xs text-ink hover:border-primary-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright"
          onClick={onLoadMore}
          type="button"
        >
          Load older scores
        </button>
      ) : null}
    </section>
  );
}

const CRITERION_LABELS: Record<string, string> = {
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

const WITHHELD_EXPLANATIONS: Record<string, string> = {
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

function criterionLabel(ruleId: string): string {
  return CRITERION_LABELS[ruleId] ?? ruleId;
}

function withheldExplanation(criterion: ScoreCriterion): string {
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
  return WITHHELD_EXPLANATIONS[criterion.ruleId] ?? "This check is not available yet and is not included in the score.";
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

function primaryLocator(evidence: readonly EvidenceLocator[]): EvidenceLocator | null {
  for (const item of evidence) {
    if (typeof item.blockId === "string" && item.blockId.length > 0) {
      return item;
    }
  }
  return null;
}
