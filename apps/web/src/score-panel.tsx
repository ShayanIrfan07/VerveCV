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
  message: string;
  evidence: Array<{ blockId?: string }>;
}

export interface ScoreView {
  id: string;
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
  scoreStatus: string;
  baseScore: number | null;
  denominator: number;
  penaltyStatus: string;
  finalScore: number | null;
  createdAt: string;
}

export function ScorePanel({
  evaluation,
  findings,
  onHighlight,
}: {
  evaluation: ScoreView;
  findings: ScoreFinding[];
  onHighlight: (blockId: string | null) => void;
}) {
  const scored = evaluation.criteria.filter((criterion) => criterion.status === "scored");
  const withheld = evaluation.criteria.filter((criterion) => criterion.status === "withheld");
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <p className="text-sm font-medium uppercase tracking-wide text-slate-500">{evaluation.scoreStatus}</p>
      <h2 className="mt-2 text-2xl font-semibold text-slate-950">
        {evaluation.baseScore ?? "—"} <span className="text-base font-normal text-slate-600">of {evaluation.denominator}</span>
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
            {findings.map((finding) => (
              <li key={`${finding.ruleId}-${finding.message}`}>
                <button
                  className="w-full rounded-lg bg-slate-50 px-3 py-2 text-left text-sm text-slate-800"
                  onMouseEnter={() => onHighlight(finding.evidence[0]?.blockId ?? null)}
                  onMouseLeave={() => onHighlight(null)}
                  type="button"
                >
                  {finding.message}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="mt-4 text-xs text-slate-500">{evaluation.rubricVersion}</p>
    </section>
  );
}

export function HistoryList({ items, onOpen }: { items: HistoryItem[]; onOpen: (id: string) => void }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-950">Score history</h2>
      {items.length === 0 ? <p className="mt-2 text-sm text-slate-700">No scores yet.</p> : null}
      <ul className="mt-3 grid gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <button className="w-full rounded-lg bg-slate-50 px-3 py-2 text-left text-sm" onClick={() => onOpen(item.id)} type="button">
              {item.scoreStatus} {item.baseScore ?? "—"} of {item.denominator}
              {item.penaltyStatus === "not_evaluated" ? " · penalties not evaluated" : ""}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
