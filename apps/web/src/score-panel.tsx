export interface EvidenceLocator {
  blockId: string;
  startOffset?: number;
  endOffset?: number;
  page?: number;
}

export interface AnalysisArea {
  label: string;
  state: "passed" | "review";
}

export interface UnavailableCheck {
  label: string;
  explanation: string;
}

export interface ScoreFinding {
  id?: string;
  kind: "issue" | "note";
  message: string;
  suggestion?: string | null;
  evidence: EvidenceLocator[];
}

export interface ScoreView {
  id: string;
  resumeId: string;
  resumeVersionId: string;
  originalFilename?: string;
  mimeType?: string;
  status: "provisional" | "complete";
  score: number | null;
  notice: string;
  areas: AnalysisArea[];
  unavailable: UnavailableCheck[];
  createdAt: string;
}

export interface HistoryItem {
  id: string;
  resumeId: string;
  resumeVersionId: string;
  originalFilename?: string;
  mimeType?: string;
  status: "provisional" | "complete";
  score: number | null;
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
  const passed = evaluation.areas.filter((area) => area.state === "passed");
  const issues = findings.filter((finding) => finding.kind === "issue");
  const notes = findings.filter((finding) => finding.kind === "note");
  const scoreText = evaluation.score === null ? "—" : String(evaluation.score);
  const allPassed = evaluation.areas.length > 0 && passed.length === evaluation.areas.length;
  const statusLabel = evaluation.status === "complete" ? "Complete" : "Provisional";

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
            <span className="block text-xl font-semibold text-primary" data-testid="analysis-score">
              {scoreText}
            </span>
            <span className="mt-0.5 block text-xs text-muted">{statusLabel}</span>
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">
            {passed.length} {passed.length === 1 ? "check" : "checks"} passed
          </p>
          <p className="mt-1 max-w-xl text-sm leading-6 text-muted">{evaluation.notice}</p>
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
        {evaluation.areas.map((area) => (
          <li key={area.label} className="flex items-center justify-between gap-4 py-3.5 text-sm">
            <span className="text-ink">{area.label}</span>
            <span className="shrink-0 font-medium text-primary">{area.state === "passed" ? "Passed" : "Review"}</span>
          </li>
        ))}
      </ul>

      <div className="border-t border-line" />
      <h3 className="mt-5 text-base font-semibold text-ink">Suggestions to review</h3>
      {issues.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted">
          No confirmed issues in the scored checks. Other checks are not yet available.
        </p>
      ) : null}
      {issues.length > 0 || notes.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {[...issues, ...notes].map((finding, index) => {
            const primary = primaryLocator(finding.evidence);
            const isSelected =
              primary !== null &&
              activeHighlight !== null &&
              activeHighlight.blockId === primary.blockId &&
              activeHighlight.startOffset === primary.startOffset &&
              activeHighlight.endOffset === primary.endOffset;
            return (
              <li key={finding.id ?? `${finding.kind}-${finding.message}-${index}`}>
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
          Checks not yet available ({evaluation.unavailable.length})
        </summary>
        <ul className="mt-3 grid gap-3">
          {evaluation.unavailable.map((check) => (
            <li key={check.label}>
              <p className="text-sm text-ink">{check.label}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted">{check.explanation}</p>
            </li>
          ))}
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
                  <span data-testid="history-score">{item.score ?? "—"}</span>
                  <span className="ml-2 text-xs font-normal text-muted">
                    {item.status === "complete" ? "Complete" : "Provisional"}
                  </span>
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

function primaryLocator(evidence: readonly EvidenceLocator[]): EvidenceLocator | null {
  for (const item of evidence) {
    if (typeof item.blockId === "string" && item.blockId.length > 0) {
      return item;
    }
  }
  return null;
}
