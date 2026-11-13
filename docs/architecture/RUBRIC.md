# VerveCV scoring rubric

Status: Provisional. Category weights are locked. Several criteria are not scorable until [ADR 0001](../adr/0001-open-product-decisions.md) is accepted.
Rubric version: `rubric-2026-11-12-provisional`
Date: 2026-11-12
Sources: implementation brief; `Resume AI Evaluator- Updated (3).pdf` (25 pages).

This document records the rubric. It does not implement it. A later phase may code a criterion only when this file marks that criterion **specified**. A **withheld** criterion contributes neither points nor a guessed zero. A **conditional** criterion scores only the cases that are specified and returns withheld on an unresolved case.

## 1. Locked weights

| Category | Maximum |
|---|---:|
| A. Bullet quality | 35 |
| B. Formatting | 15 |
| C. Grammar and readability | 20 |
| D. Relevant information | 30 |
| **Total** | **100** |

| Category | Criterion | Maximum | Authority |
|---|---|---:|---|
| A | Bullet length | 7 | Conditional |
| A | Action verbs | 10 | Conditional |
| A | Quantified metrics | 6 | Conditional |
| A | Impact-based metrics | 6 | Conditional |
| A | Minimum bullets per role | 6 | Conditional |
| B | Section ordering | 4 | Withheld |
| B | Reverse chronology | 3 | Withheld |
| B | Resume filename | 2 | Conditional |
| B | Formatting consistency | 6 | Withheld |
| C | Grammar and spelling | 10 | Conditional |
| C | Readability | 7 | Withheld |
| C | Punctuation | 3 | Conditional |
| D | Required sections | 4 | Conditional |
| D | Contact information | 4 | Specified |
| D | Experience entry details | 4 | Conditional |
| D | Education details | 3 | Withheld |
| D | Technical-to-soft skills ratio | 3 | Conditional |
| D | Minimum unique skills | 5 | Conditional |
| D | Industry keyword matching | 7 | Conditional |

Withheld maxima today: section ordering 4, reverse chronology 3, formatting consistency 6, readability 7, and education details 3. That is 23 points. The other criteria still contain unresolved cases, so a live result can withhold more.

The implementation brief allows a displayed subtotal out of 93 when readability is the only withhold and every other unresolved item is disclosed on that result. The denominator on a real result is 100 minus the maxima of criteria withheld on that result. It is never rescaled to 100. `score_status` stays `PROVISIONAL` until every criterion and penalty can be computed under an accepted rule set. `FINAL` is unavailable while this version is provisional.

## 2. Aggregation

```text
Base score   = sum of scores for criteria that were scored
Penalties    = sum of approved penalty deductions
Final score  = clamp(base score - penalties, 0, 100)
```

Optional job-description matching is stored separately and is not part of the base score.

Invariants, to be tested when the engine exists:

- No criterion score exceeds its maximum.
- A penalty cannot increase the score.
- The final score is between 0 and 100 inclusive.
- The same input, parser version, and rubric version produce the same output.
- A withheld criterion is disclosed and is omitted from both the numerator and the denominator.

Percentage bands in the source are whole numbers. How fractional percentages are rounded or assigned at gaps is ADR 0001, item A1. Until that item is accepted, a ratio that does not fall on a named band, including a fractional gap such as 64.1% to 64.9% quantified coverage, makes that criterion withheld for that document.

Where a band is written as a closed whole-number range, the named endpoints belong to that band. 100% is its own band wherever the table says 100%. “Less than N%” excludes N%.

Round half up, where the keyword rule requires it, means 0.5 and above rounds away from zero for these non-negative scores. Banker's rounding is not used. Example from the source: 6.42 rounds to 6.

## 3. Bullet quality (35)

### 3.1 Unlock

All five bullet-quality criteria score 0 when fewer than five eligible bullets exist. Eligible bullets are taken only from Work Experience, Leadership Experience, and Projects.

The definition of an eligible bullet is open (ADR 0001, decision 3). The unconfirmed working reading is: any recognized bullet in those sections, regardless of length. Short bullets are not dropped from the length denominator under that reading.

### 3.2 Bullet length — 7

A bullet meets the requirement when it contains at least 12 words. The tokenizer is open (ADR 0001, item A2).

| Percentage meeting the requirement | Score |
|---|---:|
| 100% | 7 |
| 95–99% | 6 |
| 85–94% | 5 |
| 70–84% | 4 |
| 55–69% | 3 |
| 40–54% | 2 |
| 25–39% | 1 |
| Less than 25% | 0 |

### 3.3 Action verbs — 10

The bullet must begin with an appropriate action verb or an approved equivalent construction. Inflections count once a dictionary says so. A verb that only appears later in the bullet does not count. The lexicon is open (ADR 0001, item A3).

| Coverage | Score |
|---|---:|
| 100% | 10 |
| 90–99% | 9 |
| 80–89% | 8 |
| 60–79% | 6 |
| 40–59% | 4 |
| 25–39% | 2 |
| Less than 25% | 0 |

The table has no scores of 1, 3, 5, or 7. Those values are not inserted.

### 3.4 Quantified metrics — 6

| Quantified bullet coverage | Score |
|---|---:|
| 65% or higher | 6 |
| 55–64% | 5 |
| 45–54% | 4 |
| 35–44% | 3 |
| 25–34% | 2 |
| 15–24% | 1 |
| Less than 15% | 0 |

Meaningful numerical achievements count. Dates, phone numbers, software versions, and unrelated numbers do not. The recognizer is open (ADR 0001, item A4).

Once quantified coverage reaches 65%, missing-metric feedback is suppressed. Scoring still uses the table.

### 3.5 Impact-based metrics — 6

First classify quantified coverage:

| Quantified coverage | Category |
|---|---|
| 65% or higher | C1 |
| 45–64% | C2 |
| 25–44% | C3 |
| 10–24% | C4 |
| Less than 10% | Score 0 for any impact percentage |

The source labels the “less than 10%” row C4 in one place. C4 is 10–24%. The score for below 10% is 0. See ADR 0001, item A16.

Then classify the share of quantified bullets that show impact:

| Quantified category | Impact coverage of quantified bullets | Score |
|---|---|---:|
| C1 | 85% or more | 6 |
| C1 | 60–84% | 5 |
| C1 | 40–59% | 3 |
| C1 | 20–39% | 2 |
| C1 | Less than 20% | 0 |
| C2 | 85% or more | 5 |
| C2 | 60–84% | 3 |
| C2 | 40–59% | 2 |
| C2 | Less than 40% | 0 |
| C3 | 85% or more | 3 |
| C3 | 60–84% | 2 |
| C3 | Less than 60% | 0 |
| C4 | 85% or more | 2 |
| C4 | Less than 85% | 0 |

Impact is a measurable outcome such as revenue, cost, time, latency, growth, efficiency, or conversion. “Managed 50 client accounts.” is scale, not impact. “Reduced API response time by 30%.” is impact. Uncertain bullets produce a suggestion and are not forced into a failing class (ADR 0001, item A5).

The source text says impact flags disappear after the 65% quantified threshold. That display rule is not confirmed (ADR 0001, item A4). The score table still applies.

### 3.6 Minimum bullets per role — 6

Unique company count chooses the work-experience requirement. Multiple roles at one company are one unique company and are scored as separate roles. How two strings become one company, and which role is latest when dates are missing or tied, is open (ADR 0001, item A13).

| Unique companies | Requirement |
|---|---|
| 1–2 | Latest role at each company: 4 bullets. Earlier roles at that company: 2. |
| 3–4 | Latest role at each of the two most recent companies: 4. Every other role: 2. |
| More than 4 | Latest role at the most recent company: 4. Every other role: 2. |

Leadership entries and project entries each require at least one bullet.

Per-entry credit:

| Requirement | Bullets present | Entry credit |
|---|---|---|
| 4 | 4 or more | 6/6 |
| 4 | 3 | 4/6 |
| 4 | 2 | 2/6 |
| 4 | 1 | 1/6 |
| 4 | 0 | 0/6 |
| 2 | 2 or more | 3/3 |
| 2 | 1 | 1.5/3 |
| 2 | 0 | 0/3 |
| Leadership or project | 1 or more | 3/3 |
| Leadership or project | 0 | 0/3 |

Convert each entry credit to a percentage of its own maximum, average those percentages across applicable entries, and convert:

| Average completion | Score |
|---|---:|
| 100% | 6 |
| 90–99% | 5 |
| 75–89% | 4 |
| 60–74% | 3 |
| 45–59% | 2 |
| 35–44% | 1 |
| Below 35% | 0 |

Entries that do not exist are not inserted as zeros. An existing entry with zero bullets is scored. Decimal entry credits such as 1.5/3 = 50% are kept as exact ratios until the average is converted. Boundary tests must include 35%, 75%, 90%, and 100%, and must include an average that uses a 1.5/3 entry.

The five-bullet unlock in section 3.1 also applies here: fewer than five eligible bullets scores 0 for this criterion.

### 3.7 Bullet-quality completion messages

The source defines completion copy for the dashboard:

| Condition in the source copy | Message intent |
|---|---|
| Every eligible bullet has at least 12 words | Length is complete |
| Every eligible bullet starts with an action verb | Action verbs are complete |
| At least 65% of eligible bullets are quantified | Metrics are complete |
| Quantified bullets show impact | Impact is complete; the percentage is not stated |
| Role and project bullet counts meet section 3.6 | Coverage is complete |

Confetti runs only after all five are complete, and only if item A5 defines the impact condition. It respects `prefers-reduced-motion`. No third-party animation URL is loaded.

## 4. Formatting (15)

### 4.1 Section ordering — 4 — withheld

The acceptable orders are listed in ADR 0001, decision 7. “Others” is undefined. Partial credit is undefined. The extracted source table shows 4 on the first fresher order only. This criterion stays withheld.

The product still needs a reorder preview: suggested order, a user-selected format, manual reordering, and a preview. The preview does not modify the stored file. Building the preview does not require awarding the four points.

### 4.2 Reverse chronology — 3 — withheld

| Result | Score |
|---|---:|
| Reverse-chronological order, most recent first | 3 |
| No clear chronological order | 0 |

Checked sections: Work Experience, Leadership Experience, and Projects. Affected entries are highlighted. There is no partial-credit row.

Aggregation across the three sections, and the treatment of “Present”, missing dates, and ties, is open (ADR 0001, item A6). Those documents withhold this criterion. A fully dated document with one unambiguous order can be scored only after A6 says how the sections combine. Until then the criterion stays withheld in authoritative results, because a binary 3 would hide that ambiguity.

### 4.3 Filename — 2 — conditional

| Case | Score |
|---|---:|
| Filename matches an approved pattern in ADR 0001, decision 6 | 2 |
| Filename does not contain the candidate’s name | 0 |
| Name is present and no pattern matches | Withheld |

The extension is preserved. Generated suggestions are sanitized. The UI can offer the approved patterns. Selecting one previews a new filename and does not rename the stored object in place.

### 4.4 Formatting consistency — 6 — withheld

Source bands:

| Inconsistencies | Score |
|---|---:|
| 0 | 6 |
| 1–2 places | 5 |
| 2–3 | 3 |
| 4–5 | 2 |
| 6 or more | 0 |

Exactly two is in both the 5-point row and the 3-point row (ADR 0001, decision 2). The counting unit is also undefined (item A11). The criterion stays withheld.

When a future parser runs, it may report observed differences as informational findings. Those findings do not change the score until the criterion is approved. Properties that the parser cannot read are not reported as inconsistencies.

Groups named by the source: job titles, company names, employment dates, section headings, bullets, degree titles, institution names, education dates, project and leadership titles, project and leadership dates, skills, summary and contact information, certification names, certification dates.

Properties named by the source: font family, font size, bold, italic, underline, capitalization, date format, spacing, and skill separators.

## 5. Grammar, spelling, and punctuation (20)

### 5.1 Grammar and spelling — 10 — conditional

| Distinct errors | Score |
|---|---:|
| 0 | 10 |
| 1 | 9 |
| 2 | 8 |
| 3 | 7 |
| 4 | 6 |
| 5 | 5 |
| 6 | 3 |
| 7 | 1 |
| 8 or more | 0 |

The drop from 5 errors (5 points) to 6 errors (3 points) to 7 errors (1 point) is intentional.

In-scope detections once the rules exist: spelling, repeated words, common subject-verb agreement, common verb-form errors, clear article errors, common preposition errors, and basic sentence construction.

Specified constraints:

- Count each distinct error once. What “distinct” means is open (ADR 0001, item A9).
- Do not penalize an acceptable resume fragment.
- Do not penalize a proper noun or a technical term merely because it is absent from the dictionary.
- User ignored terms remove that term from the penalty. The finding can remain visible as ignored.
- Suggestions appear only at high confidence. Uncertain findings are suggestions with no score effect.
- Return UTF-16 offsets.
- Do not also count a punctuation error in this criterion (item A9).

No language-model grammar call and no LanguageTool service are used. Phase 5 measured `nspell@2.1.5` with `dictionary-en@4.0.0` at 622,389 unpacked bytes. The same measurement found 45 of 62 resume technical terms unknown to that dictionary. The pair is not installed. An empty or unapproved dictionary means this criterion is withheld. Repeated-word, agreement, article, preposition, and sentence rules are not scored while distinctness and punctuation ownership remain open (ADR 0001, item A9).

The source’s “AI generate” control is not a Version 1 feature.

### 5.2 Readability — 7 — withheld

No scoring method is approved (ADR 0001, decision 1). The seven points stay out of the numerator and, while withheld, out of the denominator.

### 5.3 Punctuation — 3 — conditional

| Errors | Score |
|---|---:|
| 0 | 3 |
| 1 | 2 |
| 2–3 | 1 |
| 4 or more | 0 |

Check repeated punctuation, incorrect spacing around punctuation, apostrophes, separators, and obvious punctuation inconsistencies. A resume that consistently omits terminal periods on bullets is not penalized for that omission. The same issue is not counted here and in grammar. Precedence is open (ADR 0001, item A9), so authoritative punctuation scoring waits on that item.

## 6. Relevant information (30)

### 6.1 Required sections — 4 — conditional

The user selects Fresher or Experienced. Inferring the type is not approved (ADR 0001, item A15). With no selection, this criterion is withheld.

| Type | Required | Score |
|---|---|---:|
| Fresher | Education, Skills, and at least one of Work Experience, Leadership Experience, or Projects | 4 if all are present, otherwise 0 |
| Experienced | Work Experience, Education, and Skills | 4 if all are present, otherwise 0 |

There is no partial credit in the source.

### 6.2 Contact information — 4 — specified

One point each, using format checks only. No network lookup.

| Present and well formed | Points |
|---|---:|
| Candidate name | 1 |
| Phone number | 1 |
| Email address | 1 |
| LinkedIn profile | 1 |

“Well formed” means a basic syntactic check: a non-empty name, a plausible phone pattern, an email shape, and a LinkedIn URL shape. It does not mean the address is professional. Professionalism is a penalty (section 7) and is only partly specified.

### 6.3 Entry details — 4 — conditional

Required fields from the source:

| Entry | Fields |
|---|---|
| Work experience | Company, job title, dates, location |
| Leadership | Organisation, role, dates |
| Projects | Organisation, role, dates |

Specified deduction: minus 1 point for each missing date or location entry, with a floor of 0. The unit of “entry”, the effect of a missing company, title, or role, and the meaning of project organisation and role are open (ADR 0001, decisions 5 and item A14). Authoritative points wait on those decisions. Highlighting a visibly missing date or location may ship as a non-scoring finding.

### 6.4 Education details — 3 — withheld

Fields named by the source: institution, degree, location. Partial credit is undefined (ADR 0001, decision 4). No score is awarded.

### 6.5 Technical-to-soft skills ratio — 3 — conditional

Only the Skills section counts.

| Condition | Score |
|---|---:|
| No soft skills | 0 |
| Ratio below 1:1 | 0 |
| Ratio from 1:1 up to but not including 1.5:1 | 1 |
| Ratio at least 1.5:1, and at least 3 technical skills and 2 soft skills | 3 |
| Ratio at least 1.5:1, without those minimum counts | 1 |

Ratio is technical skills divided by soft skills. Zero soft skills scores 0 and is not treated as a division error.

Which skill strings are technical or soft requires a versioned classification list. Until that list is approved, this criterion is specified in formula and withheld in authoritative scoring. The formula must not be replaced with a guessed classification.

The source’s button that adds skills is not built.

### 6.6 Minimum unique skills — 5 — conditional

| Unique skills in the Skills section | Score |
|---|---:|
| 10 or more | 5 |
| 8–9 | 4 |
| 5–7 | 3 |
| 1–4 | 1 |
| 0 | 0 |

Counting rules that are specified:

- Skills outside the Skills section do not count.
- A skill counts once.
- The source example `React`, `React.js`, and `ReactJS` is one skill.
- Duplicates, sentences, numbers, and contact details do not count.

A general alias dictionary beyond that example is not supplied. Merging only the documented React aliases is allowed. Further aliases need a dictionary version. Inventing aliases would change this score, so unknown variants stay distinct until the dictionary lists them. That behavior must be disclosed.

### 6.7 Industry keyword matching — 7 — conditional

This is not job-description matching.

| Entry | Keywords required |
|---|---:|
| Work experience | 8 |
| Leadership | 2 |
| Projects | 2 |

Each relevant keyword counts once per entry.

```text
completion = min(matched / required, 1)
score      = roundHalfUp(average(completion) * 7)
```

Source example: completions 75%, 100%, and 100% average to 91.7%, times 7 is 6.42, which rounds to 6. A score above 7 is invalid. The older “+1 per keyword” column is not a second allocation of points (ADR 0001, item A12).

Dictionaries are versioned. An unknown job title yields an uncertainty finding and this criterion is withheld for that document (decision 9). Zero applicable entries make the average undefined (item A12); the criterion is withheld in that case.

## 7. Penalties

Penalties apply after the base score. Overlapping findings are deduplicated before the deduction. The final score is clamped to 0..100.

| Penalty | Rule | Authority |
|---|---|---|
| Short resume | Below 240 words: −15. 240–299 words: −10. 300 or more: no short-resume penalty. | Conditional on the tokenizer (A2). No upper-length penalty is added. |
| Personal pronouns | −1 per occurrence, cap −8, whole-word matches | Conditional (A10) |
| Unprofessional email or LinkedIn | −1 per distinct issue, cap −2 | Conditional (A10) |
| Inappropriate language | −3 per matched dictionary word, exact boundaries | Withheld until a word list exists (A10). No cap is stated, so none is added. |
| Unnecessary personal information | −2 per item | Withheld until patterns exist (A10). No cap is stated. |
| Unnecessary special characters | −1 per occurrence of `#`, `=`, `^`, `!`, cap −5, excluding legitimate uses such as `C#` | Conditional (A10) |
| Duplication | Not specified | Not applied (decision 8) |

Pronoun examples in the PDF are `I`, `me`, `my`, and `we`. The implementation brief also lists `our`. Both are recorded. Matches inside other words do not count.

Email and LinkedIn penalties exist in the source, including addresses that contain numbers and LinkedIn URLs that contain “too many” numbers. Legitimate digits are possible. No authoritative deduction is applied until item A10 defines the detector. A non-scoring suggestion may quote the source guidance: prefer a name-based email and a name-based LinkedIn URL.

## 8. Optional job-description matching

Version identifier when implemented: `jd-match-v1`, separate from the rubric version.

Inputs: normalized skills, keyword aliases, role terminology, and phrases. The match is lexical and deterministic.

Outputs: matched skills, missing skills, relevant keywords, missing keywords, and coverage. The result is not an ATS acceptance probability and is not described as semantic AI analysis.

The match report does not change `base_score`, `penalty_total`, or `final_score`.

## 9. Boundary tests for the scoring phase

These cases are the minimum set for the first scoring pull request. They test specified arithmetic. They do not close open decisions.

- Fewer than five eligible bullets zeros every bullet-quality criterion, including a resume with four long, quantified bullets.
- Length bands at 25%, 40%, 55%, 70%, 85%, 95%, and 100%, once a tokenizer exists.
- Action-verb bands at 25%, 40%, 60%, 80%, 90%, and 100%, including a verb that is not in the first position.
- Metric bands at 15%, 25%, 35%, 45%, 55%, and 65%, including a date and a version number that must not count once the recognizer exists.
- Impact matrix corners: C1 at 85%, 60%, 40%, 20%, and below 20%; C4 at 85% and below 85%; quantified coverage below 10% scores 0.
- Per-role credits of 6/6, 4/6, 2/6, 1/6, 3/3, 1.5/3, and 0/3, then averages at 35%, 45%, 60%, 75%, 90%, and 100%.
- One-company and five-company requirement selection, with two roles at the same company.
- Keyword example 6/8, 8/8, 2/2 rounds to 6, and a result above 7 is impossible.
- Skills ratio: no soft skills; 1:1; 1.5:1 with fewer than three technical skills; 1.5:1 with three technical and two soft.
- Unique skills at 0, 1, 4, 5, 7, 8, 9, and 10, plus the React alias example.
- Required sections: experienced resume missing Skills scores 0; fresher with Education, Skills, and Projects scores 4.
- Contact: each of the four fields adds one point.
- Word-count penalties at 239, 240, 299, and 300 words, once the tokenizer exists.
- Pronoun cap at 8, special-character cap at 5, email cap at 2, and `C#` not counted, once those detectors exist.
- Clamp: penalties larger than the base score produce 0; a base of 100 with no penalties stays 100.
- Job-description output present and absent leaves the base score unchanged.
- A withheld readability result displays a denominator of at most 93 and does not multiply the subtotal by 100/93.

## 10. What this version must not do

- Change a category weight.
- Emit `FINAL` while any decision in ADR 0001 that affects the document is open.
- Treat a browser score as the stored official score.
- Fill a withheld criterion with zero in order to look complete. Zero is a real score only when a specified rule produces zero.
