import { useState } from "react";

export interface EvidenceLocator {
  blockId: string;
  startOffset?: number;
  endOffset?: number;
  page?: number;
  tone?: "issue" | "note";
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
}: {
  evaluation: ScoreView;
  findings: ScoreFinding[];
  activeHighlight: EvidenceLocator | null;
  previewUnavailableReason?: string | null;
  onHighlight: (locator: EvidenceLocator | null) => void;
  onPreview?: () => void;
}) {
  return (
    <div className="grid min-w-0 content-start gap-4 text-ink">
      <EvaluationOverview evaluation={evaluation} />
      <EvaluationInsights
        activeHighlight={activeHighlight}
        evaluation={evaluation}
        findings={findings}
        onHighlight={onHighlight}
        previewUnavailableReason={previewUnavailableReason}
      />
    </div>
  );
}

export function EvaluationOverview({ evaluation }: { evaluation: ScoreView }) {
  const scoreText = evaluation.score === null ? "—" : String(evaluation.score);
  const statusLabel = evaluation.score === null ? "Score unavailable" : evaluation.status === "complete" ? "Complete" : "Provisional";

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-[#F0EBFF] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-bold tracking-wide text-[#6D28D9]">EVALUATION OVERVIEW</p>
        <h3 className="mt-2 text-xl font-semibold text-[#17172B]">Your improvement plan is ready.</h3>
        <p className="mt-1 text-sm leading-6 text-[#6B5C85]">
          Review your available feedback and focus on areas that need improvement.
        </p>
        {evaluation.score === null ? (
          <p className="mt-1 text-sm leading-6 text-[#6B5C85]">
            Some evaluation criteria are not yet available. Review your available feedback.
          </p>
        ) : null}
        <p className="mt-1 text-sm leading-6 text-[#64748B]">{evaluation.notice}</p>
        {evaluation.originalFilename ? (
          <p className="mt-1 max-w-full truncate text-sm text-[#64748B]">{evaluation.originalFilename}</p>
        ) : null}
        {evaluation.status !== "complete" ? (
          <p className="mt-3 inline-flex rounded-md bg-[#FFFBEB] px-2 py-1 text-xs font-semibold text-[#B45309]">
            Partial evaluation
          </p>
        ) : null}
      </div>
      <div className="grid h-[104px] w-[104px] shrink-0 place-items-center rounded-full border-8 border-[#DDD6FE] bg-white text-center">
        <span>
          <span className="block text-3xl font-semibold leading-none text-primary" data-testid="analysis-score">
            {scoreText}
          </span>
          <span className="mt-1 block text-xs text-[#64748B]">{statusLabel}</span>
        </span>
      </div>
    </div>
  );
}

export function EvaluationInsights({
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
  const passed = evaluation.areas.filter((area) => area.state === "passed");
  const issues = findings.filter((finding) => finding.kind === "issue");
  const notes = findings.filter((finding) => finding.kind === "note");
  const [openFindingId, setOpenFindingId] = useState<string | null>(null);

  return (
    <div className="grid min-w-0 content-start gap-4">
      {previewUnavailableReason ? (
        <p
          className="mt-4 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-danger"
          data-testid="preview-unavailable-notice"
        >
          {previewUnavailableReason}
        </p>
      ) : null}

      <section className="rounded-xl border border-[#E2E8F0] bg-card p-4" data-testid="resume-health">
        <h3 className="text-base font-semibold text-[#17172B]">Resume health</h3>
        <ul className="mt-4 grid gap-4">
          {HEALTH_CATEGORIES.map((category) => {
            const matched = evaluation.areas.filter((area) => category.labels.includes(area.label));
            const pending = evaluation.unavailable.filter((check) => category.labels.includes(check.label));
            const status = healthStatus(matched, pending);
            const muted = status === "Not fully evaluated" || status === "No public result";
            return (
              <li key={category.title}>
                <p className="text-sm font-medium text-[#334155]">{category.title}</p>
                {muted ? (
                  <p className="mt-2 rounded-lg bg-[#F1F5F9] px-2.5 py-2 text-xs leading-5 text-[#64748B]">{status}</p>
                ) : (
                  <p className={`mt-1.5 text-xs leading-5 ${status === "Strong" ? "text-[#059669]" : "text-[#D97706]"}`}>{status}</p>
                )}
              </li>
            );
          })}
        </ul>
        {evaluation.unavailable.length > 0 ? (
          <details className="mt-4 border-t border-[#E2E8F0] pt-3">
            <summary className="cursor-pointer text-xs font-medium text-[#334155]">
              Checks not yet available ({evaluation.unavailable.length})
            </summary>
            <ul className="mt-3 grid gap-3">
              {evaluation.unavailable.map((check) => (
                <li key={check.label}>
                  <p className="text-sm text-[#17172B]">{check.label}</p>
                  <p className="mt-0.5 text-xs leading-5 text-[#64748B]">{friendlyUnavailableExplanation(check.explanation)}</p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="rounded-xl border border-[#E2E8F0] bg-card p-4" data-testid="scored-findings">
        <h3 className="text-base font-semibold text-[#17172B]">Areas to improve</h3>
        {issues.length === 0 ? (
          <p className="mt-3 text-[13px] leading-5 text-[#64748B]">
            {evaluation.unavailable.length > 0
              ? "No confirmed issues in the scored checks. Other checks are not yet available."
              : "No confirmed issues in the scored checks."}
          </p>
        ) : null}
        {issues.length > 0 ? <FindingCards activeHighlight={activeHighlight} findings={issues} onHighlight={onHighlight} openFindingId={openFindingId} setOpenFindingId={setOpenFindingId} /> : null}
      </section>

      {notes.length > 0 ? (
        <section className="rounded-xl border border-[#E2E8F0] bg-card p-4" data-testid="writing-suggestions">
          <h3 className="text-base font-semibold text-[#17172B]">Writing suggestions</h3>
          <p className="mt-1 text-[13px] leading-5 text-[#64748B]">These notes are not part of the score.</p>
          <FindingCards activeHighlight={activeHighlight} findings={notes} onHighlight={onHighlight} openFindingId={openFindingId} setOpenFindingId={setOpenFindingId} />
        </section>
      ) : null}

      {passed.length > 0 ? (
        <section className="rounded-xl bg-[#ECFDF5] p-4">
          <h3 className="flex items-center gap-2 text-base font-semibold text-[#047857]">
            <CheckCircleIcon />
            What&apos;s working well
          </h3>
          <ul className="mt-3 grid gap-2">
            {passed.map((area) => (
              <li className="flex items-start gap-2 text-sm leading-5 text-[#334155]" key={area.label}>
                <CheckIcon />
                <span>{area.label}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const HEALTH_CATEGORIES: Array<{ title: string; labels: string[] }> = [
  {
    title: "Bullet points",
    labels: ["Action verbs", "Bullet length", "Impact metrics", "Quantified metrics", "Bullets per role"],
  },
  {
    title: "Format & structure",
    labels: ["Formatting consistency", "Required sections", "Readability", "Section order", "Reverse chronology", "Entry details", "Resume filename"],
  },
  {
    title: "Grammar & writing",
    labels: ["Grammar and spelling", "Punctuation"],
  },
  {
    title: "Information & skills",
    labels: ["Contact information", "Unique skills", "Skills ratio", "Industry keywords", "Education details", "Job description comparison", "Additional check"],
  },
];

function FindingCards({
  findings,
  activeHighlight,
  openFindingId,
  setOpenFindingId,
  onHighlight,
}: {
  findings: readonly ScoreFinding[];
  activeHighlight: EvidenceLocator | null;
  openFindingId: string | null;
  setOpenFindingId: (id: string | null) => void;
  onHighlight: (locator: EvidenceLocator | null) => void;
}) {
  return (
    <ul className="mt-3 grid gap-3">
      {findings.map((finding, index) => {
        const findingId = finding.id ?? `${finding.kind}-${finding.message}-${index}`;
        const primary = primaryLocator(finding.evidence);
        const located = primary ? { ...primary, tone: finding.kind } : null;
        const isSelected =
          primary !== null &&
          activeHighlight !== null &&
          activeHighlight.blockId === primary.blockId &&
          activeHighlight.startOffset === primary.startOffset &&
          activeHighlight.endOffset === primary.endOffset;
        const open = openFindingId === findingId;
        const issue = finding.kind === "issue";
        return (
          <li
            className={`rounded-[10px] border p-3.5 ${issue ? "border-[#FDE68A] bg-[#FFFBEB]" : "border-[#DDD6FE] bg-[#F5F3FF]"}`}
            key={findingId}
          >
            <button
              aria-expanded={open}
              className="w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright"
              onClick={() => {
                onHighlight(located);
                setOpenFindingId(open ? null : findingId);
              }}
              onFocus={() => onHighlight(located)}
              onMouseEnter={() => onHighlight(located)}
              onMouseLeave={() => onHighlight(null)}
              type="button"
            >
              <span className="flex items-start gap-2">
                <FindingIcon issue={issue} />
                <span className="min-w-0">
                  <span className={`block text-sm font-semibold leading-5 ${issue ? "text-[#B45309]" : "text-[#7C3AED]"} ${isSelected ? "underline" : ""}`}>
                    {finding.message}
                  </span>
                  {typeof primary?.page === "number" ? (
                    <span className={`mt-1 block text-xs ${issue ? "text-[#B45309]" : "text-[#7C3AED]"}`}>Page {primary.page}</span>
                  ) : null}
                </span>
              </span>
            </button>
            {open && finding.suggestion ? (
              <div className="mt-3 rounded-lg bg-[#ECFDF5] p-3">
                <p className="text-xs font-semibold text-[#047857]">Suggested approach</p>
                <p className="mt-1 text-[13px] leading-5 text-[#334155]">{finding.suggestion}</p>
                <p className="mt-1 text-xs leading-5 text-[#64748B]">Use this only when it matches the resume. Do not add figures that are not already true.</p>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const INTERNAL_UNAVAILABLE = /undecided|recognizer|partial credit|verb list|classifier|dictionar|counting rules|measurement rules|scoring method/i;

export function friendlyUnavailableExplanation(explanation: string): string {
  if (INTERNAL_UNAVAILABLE.test(explanation)) {
    return "This check is not yet available.";
  }
  return explanation;
}

function healthStatus(areas: readonly AnalysisArea[], unavailable: readonly UnavailableCheck[]): string {
  if (areas.length === 0) {
    return unavailable.length > 0 ? "Not fully evaluated" : "No public result";
  }
  if (areas.some((area) => area.state === "review") && unavailable.length === 0) {
    return "Needs improvement";
  }
  if (unavailable.length > 0) {
    return "Not fully evaluated";
  }
  return "Strong";
}

function FindingIcon({ issue }: { issue: boolean }) {
  return (
    <svg aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${issue ? "text-[#B45309]" : "text-[#7C3AED]"}`} fill="none" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="11" fill="currentColor" r="0.8" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 text-[#059669]" fill="none" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 8.2 7 10.2 11 6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[#059669]" fill="none" viewBox="0 0 16 16">
      <path d="M3.5 8.2 6.4 11 12.5 5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function HistoryList({
  items,
  activeEvaluationId,
  hasMore = false,
  title = "My resumes",
  onOpen,
  onDelete,
  onLoadMore,
}: {
  items: HistoryItem[];
  activeEvaluationId?: string | null;
  hasMore?: boolean;
  title?: string;
  onOpen: (item: HistoryItem) => void;
  onDelete?: (item: HistoryItem) => void;
  onLoadMore?: () => void;
}) {
  const countLabel = hasMore ? null : `${items.length} ${items.length === 1 ? "resume" : "resumes"}`;
  return (
    <section className="rounded-xl border border-line bg-card p-6 text-ink">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {countLabel ? <p className="text-sm text-muted">{countLabel}</p> : null}
      </div>
      {items.length === 0 ? <p className="mt-2 text-sm text-muted">No scores yet.</p> : null}
      <ul className="mt-3 grid gap-2">
        {items.map((item) => {
          const active = activeEvaluationId === item.id;
          const filename = item.originalFilename ?? "Resume";
          return (
            <li className="flex items-center gap-2 rounded-xl border border-[#E2E8F0] bg-white p-2" key={item.id}>
              <button
                className={`min-w-0 flex-1 rounded-lg px-3 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright ${
                  active ? "bg-panel font-medium text-primary-bright" : "text-ink"
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
                <span className="mt-0.5 block truncate text-xs font-normal text-muted">{filename}</span>
                <span className="mt-0.5 block text-xs font-normal text-muted">Scored {scoredOn(item.createdAt)}</span>
              </button>
              {onDelete ? (
                <button
                  aria-label={`Delete ${filename}`}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[#DC2626] hover:bg-[#FEE2E2] hover:text-[#B91C1C] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78BFA]"
                  onClick={() => onDelete(item)}
                  type="button"
                >
                  <TrashIcon />
                </button>
              ) : null}
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

function scoredOn(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "date unavailable";
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 20 20">
      <path d="M4.5 6.5h11" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 6.2V4.8h4v1.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.2 6.5 6.8 16h6.4l.6-9.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
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
