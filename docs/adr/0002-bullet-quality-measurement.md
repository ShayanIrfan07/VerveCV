# ADR 0002: Bullet-quality measurement

Status: Accepted by the product owner for Phase 5A.
Date: 2026-11-26
Related: [ADR 0001](0001-open-product-decisions.md), [RUBRIC](../architecture/RUBRIC.md)

This record closes ADR 0001 items 3, A2, A3, A4, A5, and A13 for new evaluations. Stored evaluation rows are not rewritten. The rubric id stays `rubric-2026-11-12-provisional`. Category weights stay 35, 15, 20, and 30. The existing band tables are unchanged.

## Accepted rules

Eligible bullets remain recognized bullets in Work Experience, Leadership, and Projects, at any length. Fewer than five eligible bullets scores 0 on all five bullet checks.

Length uses the existing tokenizer (`tokenizer-2026-11-20-proposed-v1`). A bullet of at least 12 tokens meets the length numerator. Confirmed extraction duplicates are removed. Identical bullets with different paragraph identities both count. `evaluate()` applies `bulletLengthScore` to that percentage.

Action verbs use lexicon `action-verbs-2026-11-26-v1`. The owner’s starter list is stored as lemmas, plus regular inflections and the irregular forms `led`/`lead` and `built`/`build`. Only the first token counts. `evaluate()` applies `actionVerbScore`.

Quantities use recognizer `quantities-2026-11-26-v1`. One qualifying bullet counts once. Percentages, counts, currency, durations, ranges, multipliers, and stated volumes count. Years, dates, phone numbers, IP addresses, ports, and named software or protocol versions do not. At the existing top band, missing-quantity findings are omitted. `evaluate()` applies `quantifiedMetricScore`.

Impact uses classifier `impact-2026-11-26-v1`. A bullet needs a quantity and a matching direction: a reduction cue with a cost, time, error, or risk noun; a growth cue with a revenue, retention, or throughput noun; or an improvement cue with a performance, quality, or reliability noun. Scale without that pairing is quantified and not impact. `evaluate()` applies `impactScore`.

Bullets per role use `roles-2026-11-26-v2` and the existing entry parser. The employer is the non-title text on the header, including a title phrase that shares the line in either order, compared after case and whitespace folding. No company directory and no legal-suffix aliases are used. `Google` and `Google LLC` stay different employers. A later header that contains a title and a date, and no employer of its own, reuses the employer already read in that section. A date-only line stays with the current header, including a date painted on the same baseline. A second unlabeled organization line, such as a bare location, still withholds the check. Missing dates, tied recency at a requirement boundary, client-labeled lines, or an ambiguous entry parse withhold the criterion. A withheld check adds neither points nor zero. `evaluate()` applies `minimumBulletsScore` when the average is inside a named band. Version v1 did not separate a title from an employer on the same line and did not reuse an earlier employer line. Stored evaluations are not recalculated.

## Conflicts left unchanged

ADR 0001 item A1 still withholds a percentage that sits between two named whole-number rows. This phase does not adopt the half-up rounding proposal.

The length helper in `bullets.ts` still reports `appliedToScore: false`. The score is applied only inside `evaluate()`.
