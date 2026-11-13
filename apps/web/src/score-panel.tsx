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
}: {
  evaluation: ScoreView;
  findings: ScoreFinding[];
  activeHighlight: EvidenceLocator | null;
  previewUnavailableReason?: string | null;
  onHighlight: (locator: EvidenceLocator | null) => void;
}) {
  const scored = evaluation.criteria.filter((criterion) => criterion.status === "scored");
  const withheld = evaluation.criteria.filter((criterion) => criterion.status === "withheld");

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          {evaluation.scoreStatus}
        </p>
        {evaluation.originalFilename ? (
          <p className="text-xs text-slate-500">{evaluation.originalFilename}</p>
        ) : null}
      </div>
      <h2 className="mt-2 text-2xl font-semibold text-slate-950">
        {evaluation.baseScore ?? "—"}{" "}
        <span className="text-base font-normal text-slate-600">of {evaluation.denominator}</span>
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-700">
        Withheld criteria stay out of the denominator. This score is not rescaled to 100.
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-700">
        {evaluation.penaltyTotal === null
          ? "Penalties have not been evaluated, so no final score is published."
          : `Penalties ${evaluation.penaltyTotal}. Final score ${evaluation.finalScore ?? "unpublished"}.`}
      </p>
      {evaluation.jdMatch?.status === "not_implemented" ? (
        <p className="mt-2 text-sm text-slate-700">Job-description matching has not been run.</p>
      ) : null}
      {previewUnavailableReason ? (
        <p
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          data-testid="preview-unavailable-notice"
        >
          {previewUnavailableReason}
        </p>
      ) : null}

      <h3 className="mt-4 text-sm font-semibold text-slate-950">Scored</h3>
      <ul className="mt-2 grid gap-1 text-sm text-slate-700">
        {scored.map((criterion) => (
          <li key={criterion.ruleId}>
            {criterion.ruleId}: {criterion.score}/{criterion.maxScore}
          </li>
        ))}
      </ul>

      <h3 className="mt-4 text-sm font-semibold text-slate-950">Withheld</h3>
      <ul className="mt-2 grid gap-1 text-sm text-slate-700">
        {withheld.map((criterion) => (
          <li key={criterion.ruleId}>
            {criterion.ruleId}: {criterion.reasonCode ?? "withheld"}
          </li>
        ))}
      </ul>

      {findings.length > 0 ? (
        <>
          <h3 className="mt-4 text-sm font-semibold text-slate-950">Findings</h3>
          <ul className="mt-2 grid gap-1">
            {findings.map((finding, index) => {
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
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm text-slate-800 ${
                      isSelected ? "bg-amber-200" : "bg-slate-50"
                    }`}
                    onClick={() => onHighlight(primary)}
                    onFocus={() => onHighlight(primary)}
                    onMouseEnter={() => onHighlight(primary)}
                    onMouseLeave={() => onHighlight(null)}
                    type="button"
                  >
                    <span>{finding.message}</span>
                    {finding.suggestion ? (
                      <span className="mt-0.5 block text-xs text-slate-600">
                        Suggestion: {finding.suggestion}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <p className="mt-4 text-xs text-slate-500">{evaluation.rubricVersion}</p>
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
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-950">Score history</h2>
      {items.length === 0 ? <p className="mt-2 text-sm text-slate-700">No scores yet.</p> : null}
      <ul className="mt-3 grid gap-2">
        {items.map((item) => {
          const active = activeEvaluationId === item.id;
          return (
            <li key={item.id}>
              <button
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                  active ? "bg-amber-100 font-medium text-slate-950" : "bg-slate-50 text-slate-800"
                }`}
                onClick={() => onOpen(item)}
                type="button"
              >
                <span>
                  {item.scoreStatus} {item.baseScore ?? "—"} of {item.denominator}
                  {item.penaltyStatus === "not_evaluated" ? " · penalties not evaluated" : ""}
                </span>
                {item.originalFilename ? (
                  <span className="mt-0.5 block text-xs font-normal text-slate-500">
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
          className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700"
          onClick={onLoadMore}
          type="button"
        >
          Load older scores
        </button>
      ) : null}
    </section>
  );
}

function primaryLocator(evidence: readonly EvidenceLocator[]): EvidenceLocator | null {
  for (const item of evidence) {
    if (typeof item.blockId === "string" && item.blockId.length > 0) {
      return item;
    }
  }
  return null;
}
