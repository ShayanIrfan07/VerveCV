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

export interface FindingSource {
  id: string;
  text: string;
  page?: number;
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
  sourceBlocks,
  onHighlight,
}: {
  evaluation: ScoreView;
  findings: ScoreFinding[];
  activeHighlight: EvidenceLocator | null;
  previewUnavailableReason?: string | null;
  sourceBlocks?: readonly FindingSource[];
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
        sourceBlocks={sourceBlocks}
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
  sourceBlocks,
  onHighlight,
}: {
  evaluation: ScoreView;
  findings: ScoreFinding[];
  activeHighlight: EvidenceLocator | null;
  previewUnavailableReason?: string | null;
  sourceBlocks?: readonly FindingSource[];
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
            const checks = checksForCategory(category, evaluation);
            if (checks.length === 0) {
              return null;
            }
            return <CategoryCoverage checks={checks} key={category.title} title={category.title} />;
          })}
        </ul>
        <p className="mt-4 text-xs leading-5 text-[#64748B]">Coverage represents completed checks, not resume quality or earned points.</p>
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
        {issues.length > 0 ? (
          <IssueGroups
            activeHighlight={activeHighlight}
            findings={issues}
            onHighlight={onHighlight}
            sourceBlocks={sourceBlocks}
          />
        ) : null}
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

type CoverageCheck = {
  label: string;
  status: "evaluated" | "attention" | "unavailable";
};

function checksForCategory(category: { title: string; labels: string[] }, evaluation: ScoreView): CoverageCheck[] {
  const checks: CoverageCheck[] = [];
  for (const label of category.labels) {
    const area = evaluation.areas.find((item) => item.label === label);
    const pending = evaluation.unavailable.find((item) => item.label === label);
    if (area) {
      checks.push({ label, status: area.state === "passed" ? "evaluated" : "attention" });
    } else if (pending) {
      checks.push({ label, status: "unavailable" });
    }
  }
  return checks;
}

function CategoryCoverage({ title, checks }: { title: string; checks: readonly CoverageCheck[] }) {
  const evaluated = checks.filter((check) => check.status !== "unavailable").length;
  const pending = evaluated === 0;
  return (
    <li data-testid={`coverage-${title.toLowerCase().replace(/[^a-z]+/gu, "-")}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-[#334155]">{title}</p>
        <p className={`text-xs font-semibold ${pending ? "text-[#64748B]" : "text-[#7C3AED]"}`}>
          {pending ? "Incomplete" : `${evaluated} of ${checks.length} evaluated`}
        </p>
      </div>
      {pending ? (
        <p className="mt-2 rounded-lg bg-[#F1F5F9] px-2.5 py-2 text-xs leading-5 text-[#64748B]">Additional checks pending</p>
      ) : (
        <>
          <div aria-hidden="true" className="mt-2 flex gap-1">
            {checks.map((check) => (
              <span
                className={`h-1.5 flex-1 rounded-full ${check.status === "unavailable" ? "bg-[#E2E8F0]" : "bg-[#7C3AED]"}`}
                key={check.label}
              />
            ))}
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-[#334155]">View individual checks</summary>
            <ul className="mt-2 grid gap-2 rounded-lg bg-[#F8F7FF] p-3">
              {checks.map((check) => (
                <li className="flex items-start justify-between gap-3 text-sm" key={check.label}>
                  <span className="flex items-start gap-2 text-[#334155]">
                    <CoverageIcon status={check.status} />
                    <span>{check.label}</span>
                  </span>
                  <span className={`shrink-0 text-right text-xs font-semibold ${coverageTone(check.status)}`}>
                    {check.status === "attention" ? "Needs attention" : coverageLabel(check.status)}
                    {check.status === "attention" ? <span className="sr-only">Evaluated with confirmed improvement opportunities</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </li>
  );
}

function coverageLabel(status: CoverageCheck["status"]): string {
  if (status === "evaluated") {
    return "Evaluated";
  }
  if (status === "attention") {
    return "Evaluated with confirmed improvement opportunities";
  }
  return "Unavailable";
}

function coverageTone(status: CoverageCheck["status"]): string {
  if (status === "evaluated") {
    return "text-[#059669]";
  }
  if (status === "attention") {
    return "text-[#B45309]";
  }
  return "text-[#64748B]";
}

function CoverageIcon({ status }: { status: CoverageCheck["status"] }) {
  if (status === "unavailable") {
    return (
      <svg aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[#94A3B8]" fill="none" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  const attention = status === "attention";
  return (
    <svg aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${attention ? "text-[#D97706]" : "text-[#059669]"}`} fill="none" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      {attention ? <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.4" /> : <path d="M5 8.2 7 10.2 11 6" stroke="currentColor" strokeWidth="1.4" />}
    </svg>
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

const ISSUE_GUIDES: Record<string, { title: string; explanation: string; placeholder: string }> = {
  "This bullet is shorter than the length check allows.": {
    title: "Improve bullet length",
    explanation: "State the action, the scope, and the result in the same bullet.",
    placeholder: "[specific scope or result]",
  },
  "Start this bullet with an action verb.": {
    title: "Use stronger action verbs",
    explanation: "Start the bullet with the action, then the work it describes.",
    placeholder: "[Action verb]",
  },
  "This bullet does not include a measurable quantity.": {
    title: "Add measurable quantities",
    explanation: "Include relevant quantities, percentages, durations or scale where accurate.",
    placeholder: "[quantity, percentage, duration, or scale]",
  },
  "This bullet does not state a measurable outcome.": {
    title: "Demonstrate measurable impact",
    explanation: "Describe a verified improvement in cost, time, quality, performance, or another outcome you can confirm.",
    placeholder: "[verified improvement in time, cost, quality, or performance]",
  },
  "This role has fewer bullets than the check allows.": {
    title: "Improve employment bullet distribution",
    explanation: "Add bullets that describe the work done in this role.",
    placeholder: "[responsibility or result for this role]",
  },
};

function IssueGroups({
  findings,
  sourceBlocks,
  activeHighlight,
  onHighlight,
}: {
  findings: readonly ScoreFinding[];
  sourceBlocks?: readonly FindingSource[];
  activeHighlight: EvidenceLocator | null;
  onHighlight: (locator: EvidenceLocator | null) => void;
}) {
  const groups = groupIssues(findings, sourceBlocks);
  return (
    <ul className="mt-3 grid gap-3">
      {groups.map((group, index) => (
        <li className="rounded-[10px] border border-[#FDE68A] bg-[#FFFBEB]" key={group.title}>
          <details open={index === 0}>
            <summary className="cursor-pointer list-none p-3.5 [&::-webkit-details-marker]:hidden">
              <span className="flex items-start justify-between gap-3">
                <span>
                  <span className="block text-sm font-semibold text-[#B45309]">{group.title}</span>
                  <span className="mt-1 block text-xs text-[#B45309]">{attentionCount(group.items.length, group.noun)}</span>
                </span>
                <span aria-hidden="true" className="text-[#B45309]">⌄</span>
              </span>
            </summary>
            <div className="grid gap-3 border-t border-[#FDE68A] px-3.5 py-3">
              <p className="text-[13px] leading-5 text-[#B45309]">{group.explanation}</p>
              <ul className="grid gap-2">
                {group.items.map((item) => {
                  const selected = sameLocator(activeHighlight, item.locator);
                  return (
                    <li key={item.key}>
                      <button
                        className={`w-full rounded-lg bg-white p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-bright ${selected ? "ring-2 ring-[#F59E0B]" : ""}`}
                        onClick={() => onHighlight(item.locator)}
                        onFocus={() => onHighlight(item.locator)}
                        onMouseEnter={() => onHighlight(item.locator)}
                        onMouseLeave={() => onHighlight(null)}
                        type="button"
                      >
                        <span className="block text-xs text-[#64748B]">
                          Original bullet{typeof item.page === "number" ? ` · Page ${item.page}` : ""}
                        </span>
                        <span className="mt-1 block text-sm leading-5 text-[#17172B]">
                          {item.text ?? "Original text is not available for this result."}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {group.structure ? (
                <div>
                  <p className="text-xs font-semibold tracking-wide text-[#059669]">SUGGESTED STRUCTURE</p>
                  <p className="mt-1 text-sm leading-5 text-[#334155]">{group.structure}</p>
                  <p className="mt-1 text-xs leading-5 text-[#64748B]">Replace placeholders with verified information.</p>
                </div>
              ) : null}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

interface IssueItem {
  key: string;
  text: string | null;
  page?: number;
  locator: EvidenceLocator | null;
}

interface IssueGroup {
  title: string;
  explanation: string;
  noun: string;
  structure: string | null;
  items: IssueItem[];
}

export function groupIssues(findings: readonly ScoreFinding[], sourceBlocks?: readonly FindingSource[]): IssueGroup[] {
  const groups: IssueGroup[] = [];
  for (const finding of findings) {
    const guide = ISSUE_GUIDES[finding.message];
    const title = guide?.title ?? finding.message;
    let group = groups.find((item) => item.title === title);
    if (!group) {
      group = {
        title,
        explanation: guide?.explanation ?? finding.message,
        noun: guide ? "bullet" : "item",
        structure: null,
        items: [],
      };
      groups.push(group);
    }
    const source = sourceFor(finding, sourceBlocks);
    const blockId = source.locator?.blockId;
    if (blockId && group.items.some((item) => item.locator?.blockId === blockId)) {
      continue;
    }
    group.items.push({
      key: finding.id ?? `${title}-${group.items.length}`,
      text: source.text,
      ...(source.page === undefined ? {} : { page: source.page }),
      locator: source.locator ? { ...source.locator, tone: "issue" } : null,
    });
    if (guide && group.structure === null) {
      const base = source.text?.replace(/[.]+$/u, "").trim();
      if (!base) {
        group.structure = `${guide.placeholder}.`;
      } else if (guide.placeholder.startsWith("[Action verb]")) {
        group.structure = `${guide.placeholder} ${base}.`;
      } else {
        group.structure = `${base} ${guide.placeholder}.`;
      }
    }
  }
  return groups;
}

function sourceFor(
  finding: ScoreFinding,
  sourceBlocks: readonly FindingSource[] | undefined,
): { text: string | null; page?: number; locator: EvidenceLocator | null } {
  const locator = primaryLocator(finding.evidence);
  const block = locator ? sourceBlocks?.find((item) => item.id === locator.blockId) : undefined;
  const page = typeof locator?.page === "number" ? locator.page : block?.page;
  if (!block) {
    return { text: null, ...(page === undefined ? {} : { page }), locator };
  }
  const text = block.text.trim();
  return { text: text.length > 0 ? text : null, ...(page === undefined ? {} : { page }), locator };
}

function attentionCount(count: number, noun: string): string {
  const label = count === 1 ? noun : `${noun}s`;
  return `${count} ${label} ${count === 1 ? "needs" : "need"} attention`;
}

function sameLocator(active: EvidenceLocator | null, locator: EvidenceLocator | null): boolean {
  return active !== null && locator !== null && active.blockId === locator.blockId && active.startOffset === locator.startOffset && active.endOffset === locator.endOffset;
}

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
