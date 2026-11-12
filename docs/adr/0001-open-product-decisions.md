# ADR 0001: Open product decisions

Status: Open. None of the items below is decided by this record.
Date: 2026-11-12
Related: [RUBRIC](../architecture/RUBRIC.md), [HLD](../architecture/HLD.md), [SECURITY](../architecture/SECURITY.md)

This record lists product decisions that Version 1 must not invent. Scoring code may implement a criterion only where [RUBRIC.md](../architecture/RUBRIC.md) marks the rule as specified. A later ADR, accepted by the product owner, closes an item. Until then the evaluation status stays `PROVISIONAL` whenever that item would change a number.

Source documents:

- Locked implementation brief (this repository’s Phase 0 request).
- `Resume AI Evaluator- Updated (3).pdf`, 25 pages, reviewed 2026-11-12. The PDF is not committed in the repository. Page 25 contains the heading “Duplication-” and no rule text.

## Decisions required by the brief

### 1. Readability methodology (7 points)

The source PDF says the team is unsure how to score or highlight readability. No formula is approved.

Do not award, withhold-and-redistribute, or rescale these seven points. Keep readability visible as withheld. Candidate signals listed for a future decision, none of which is a rubric, include very long sentences, jargon density, repeated wording, and difficult constructions.

Question: which deterministic signals, thresholds, and highlights are approved for the seven points?

### 2. Formatting consistency at exactly two issues

The source assigns 5 points to “1–2 places” and 3 points to “2–3 formatting inconsistencies”. A count of exactly two matches both rows.

Do not pick 5 or 3. A result whose count is exactly two marks this criterion unresolved.

Question: which score applies at exactly two, and which row boundaries are inclusive?

### 3. Eligible bullet

Bullet-quality scoring unlocks at five bullets drawn from Work Experience, Leadership Experience, and Projects. The length rule separately talks about bullets of at least 12 words. The source does not say whether a bullet under 12 words is excluded from the percentage denominator.

The implementation brief’s provisional reading, not yet confirmed, is: an eligible bullet is a recognized bullet in one of those three sections, of any length. Short bullets stay in the denominator.

Question: confirm that provisional reading, or define eligibility differently?

### 4. Education partial credit (3 points)

The source lists institution, degree, and location, with a maximum of 3. It does not say what full credit requires or how partial entries score.

Do not invent a partial-credit formula, including a silent “all three fields present = 3, otherwise 0” rule.

Question: how are missing institution, degree, and location converted into a score from 0 to 3?

### 5. Missing company, title, or role

The source requires, for each work role: company, job title, dates, and location. Leadership requires organisation, role, and dates. Projects require organisation, role, and dates. The only numeric deduction in the source is: deduct 1 point for each missing date or location entry, with a floor of 0, from a maximum of 4.

The deduction’s unit is also unclear: one point per missing field, or one point per entry that lacks the field. “Across all applicable sections” does not say whether a project location counts, because location is not in the project field list.

Do not invent deductions for a missing company, title, or role.

Question: what is the starting score, the unit of the date/location deduction, and the effect of a missing company, title, role, or project organisation?

### 6. Filename partial credit (2 points)

Approved patterns, extension preserved:

```text
Firstname_Resume
Resume_FirstName
Lastname_Resume
Resume_Lastname
FirstnameLastName_Resume
Resume_FirstNameLastName
FirstName_JobTitle
```

The source scores 2 when the filename follows a pattern and 0 when it does not contain the candidate’s name. It does not score the case where the name is present and the pattern does not match.

Do not award 1 point, or any other middle score, for that case.

Question: what score is awarded when the name is present and no pattern matches?

### 7. Meaning of “Others” in section order

Acceptable orders in the source:

| Candidate | Order |
|---|---|
| Fresher | Professional Summary, Education, Work Experience, Others |
| Fresher | Education, Work Experience |
| Fresher | Work Experience, Others |
| Experienced | Professional Summary, Work Experience, Others |
| Experienced | Work Experience, Others |

The extracted table prints the score 4 on the first row only. The source does not define “Others”, does not say whether every listed order scores 4, and does not say what any other order scores. Partial credit is not defined.

Do not add template orders that are not in this list.

Question: what does “Others” include, which listed orders score 4, and what does a non-matching order score?

### 8. Duplication penalty

The source has a “Duplication-” heading and no detection rule or deduction. The penalty is not implemented and is disclosed as not applied. It must not move the score.

Question: what is a duplicate, and how many points does it deduct?

### 9. Industry keyword dictionaries for unrecognized roles

The keyword formula is specified in the rubric. The dictionaries are not. For an unknown job title the result reports uncertainty and does not invent a confident keyword list.

Question: which role dictionaries are approved, and what should the score be when a title has no dictionary?

### 10. Free and Pro pricing and quotas

No price, billing period, evaluation quota, or upload quota is approved. The schema may store plan codes `FREE` and `PRO` and may store counters. It must not contain a made-up price or limit.

While limits are unset, the product must not describe the plan as unlimited and must not block users with a made-up number. The temporary behavior needs an explicit choice.

Question: what are the Free and Pro prices, periods, evaluation quotas, and upload quotas, and what should the Free plan do before those numbers exist?

### 11. Payment provider

No provider, webhook secret, or checkout vendor is approved. Billing routes stay unregistered. Pro cannot become active from client input.

Question: which provider, if any, should Version 1 use?

### 12. Email verification

The user table has `email_verified_at`. No verification method is approved.

Question: is verification required, and is it a mail link, a one-time code, or deferred?

### 13. Production hosting

The design target is Cloudflare Pages, one Node.js API, Neon PostgreSQL, and private Cloudflare R2. Render’s free web service is acceptable for development or a small beta, with sleep after inactivity and an ephemeral disk. The production host, region, and instance size are not chosen. The database driver assumption (pooled TCP via `postgres`) must be revisited if the API moves to a serverless isolate.

Question: which production hosts and plans are approved?

## Additional ambiguities found during review

These were not in the brief’s numbered list. They are blocking where a score would otherwise be guessed.

### A1. Percentage arithmetic

Bands are written as whole-number percents. The source does not say whether a ratio is compared exactly, floored, or rounded before the lookup. Some bands also leave a fractional gap. Example: quantified coverage “45–64%” and “65% or more” does not name 64.1% through 64.9%.

Question: which rounding rule and which inclusive bounds apply before a band is chosen?

### A2. Word-count tokenization

The length rule needs a 12-word threshold and “robust” counting for punctuation, hyphenated terms, and technical tokens. The source does not define a token.

Examples that need a ruling: `end-to-end`, `Node.js`, `CI/CD`, `C#`, `10%`, a phone number, a date.

Question: what is the authoritative word-count algorithm?

### A3. Action-verb lexicon

The bands are specified. Credit applies only when the bullet begins with an action verb or an approved equivalent construction, including inflections. No verb list is supplied. A verb later in the sentence does not count.

Question: which dictionary version, which inflections, and which leading constructions are approved?

### A4. Quantified-metric recognizer

The bands and the 65% feedback-suppression rule for missing metrics are specified. Dates, phone numbers, software versions, and unrelated numbers do not count. A full recognizer is not specified.

The source also says impact feedback disappears once 65% of bullets are quantified. The implementation brief states that suppression for missing-metric feedback only. Hiding impact feedback at the same threshold would change the product.

Question: which number patterns count as metrics, and does the 65% threshold hide impact feedback or only missing-metric feedback?

### A5. Impact classifier and the confetti condition

Impact examples are outcome metrics such as cost, revenue, time, latency, growth, efficiency, and conversion. Scale examples such as “Managed 50 client accounts.” are not impact. The source asks for conservative patterns. An uncertain bullet should produce a suggestion and no invented deduction.

The confetti copy says quantified bullets “show results”, without a percentage. The other four completion messages are specific: all bullets meet length, all bullets start with an action verb, at least 65% contain metrics, and role bullet counts meet the requirements.

Question: which cue list defines impact, and which impact condition turns on confetti?

### A6. Reverse chronology across sections

The table is binary: correct reverse chronology scores 3, and no clear chronological order scores 0. The check covers Work Experience, Leadership Experience, and Projects. The source does not say whether one bad section zeros the criterion. Ongoing roles (“Present”), missing dates, and date ties are not defined. The brief requires conservative handling of those cases and forbids a guessed failure.

Question: how are the three sections combined, and how are missing, tied, and current dates treated?

### A7. Unspecified security and resource numbers

The following controls are required, and no number is approved. Phase 2 and Phase 7 must not freeze a number inside the product rules.

| Setting | Why it exists |
|---|---|
| Argon2id memory, iterations, parallelism | Password hashing; confirm against OWASP at implementation |
| Session and refresh lifetimes | Session management |
| Signed URL TTL | Private R2 access |
| Login, register, refresh, upload, and evaluate rate limits | Abuse control |
| PDF page cap | Parser exhaustion |
| DOCX entry cap and uncompressed byte cap | Zip bombs |
| Parse timeout and parse concurrency | Resource exhaustion |
| Job attempt bound and lease length | Crash recovery |

Question: which values are approved for each row?

### A8. Provider backup retention

Application deletion at 90 days does not, by itself, delete Neon point-in-time-recovery history or R2 noncurrent versions.

Question: what backup retention will the product disclose, based on the actual Neon and R2 settings?

### A9. Grammar distinctness and punctuation overlap

Grammar scores count “each distinct error once”. The source does not say whether the same misspelling in three bullets is one error or three. Punctuation errors must not also count as grammar errors. Assignment precedence is not specified. Consistently omitted bullet periods are not punctuation errors.

Question: what makes two grammar findings the same error, and which criterion owns a punctuation finding?

### A10. Personal pronouns, email, LinkedIn, and banned words

Specified deductions:

| Issue | Deduction |
|---|---|
| Personal pronoun | −1 each, cap −8 |
| Unprofessional email or LinkedIn issue | −1 per distinct issue, cap −2 |
| Inappropriate word | −3 per matched word, no cap stated |
| Unnecessary personal item | −2 per item, no cap stated |
| Unnecessary `#`, `=`, `^`, `!` | −1 each, cap −5 |

Open edges:

- The PDF feedback names `I`, `me`, `my`, and `we`. The implementation brief also names `our`. Other forms (`us`, `ours`, `mine`) are not listed.
- Email: the source flags numbers and also “inappropriate” addresses (nicknames, informal words) without a detector.
- LinkedIn: “too many numbers” has no threshold. Legitimate addresses can contain digits.
- No inappropriate-word list is supplied. Matching must use exact boundaries once a list exists.
- Unnecessary personal information is illustrated by age, marital status, and irrelevant personal details. A detector needs an approved pattern list so professional context is not penalized.
- `#` must not penalize `C#`. The character list is not extended.

Question: which pronoun list, email rules, LinkedIn digit threshold, banned-word list, and personal-information patterns are approved?

### A11. Formatting-inconsistency unit

Decision 2 covers the overlapping band. Separately, the source does not define what one “place” or “inconsistency” is: one property, one pair of elements, or one category (titles, dates, separators, and so on). Properties the parser did not extract are not inconsistencies.

Question: what is the counting unit, and which properties are in scope for PDF versus DOCX?

### A12. Keyword score with no entries, and the “Points” column

If a resume has no work, leadership, or project entries, the average-completion formula divides by zero. No fallback score is specified.

The source table header “Points” (“+1 per relevant industry keyword, max 8”) conflicts in wording with the later formula and the worked example. The worked example and the implementation brief agree: score is average completion times 7, rounded half up, and the score cannot exceed 7. Per-entry keyword counts are inputs to that formula, not extra points. This reading is recorded in the rubric. Confirmation is requested so the old column is not implemented as a second score.

Question: confirm the formula reading, and what score applies when there are zero entries?

### A13. Company identity and “most recent”

Unique-company categories depend on company identity and on which role is latest. The source does not define legal-suffix aliases (`Google` and `Google LLC`) or ties and missing dates.

Question: how are company names matched, and which role is latest when dates are missing or equal?

### A14. Project field names

Projects are required to have organisation, role, and dates. Many project entries have a project name and no organisation or role. The source still lists those three fields.

Question: what is a project organisation and role, and is a project name a substitute for either?

### A15. Candidate type selection

Fresher and Experienced change required sections and acceptable section order. The brief says the user can select the type. It does not say whether the product may infer the type.

Question: is the user selection mandatory before those criteria score?

### A16. Below-10% impact row label

Quantified coverage below 10% scores 0 for impact, at any impact percentage. One source row labels that case C4, while C4 is defined as 10–24%. The score is 0 either way. The label should be corrected in the rubric copy so implementers do not treat “below 10%” as C4. No product choice is required unless the owner disagrees that the score is 0.

### A17. Visual source

The PDF refers to a Figma reorder popup and to a third-party Lottie confetti URL. No Figma file was in the materials reviewed. The Lottie URL must not be loaded (privacy, availability, and content security policy).

Question: where is the approved visual design, and is a local reduced-motion animation an acceptable substitute for the Lottie file?

## Working interpretations that still need confirmation

These are recorded so later phases do not treat them as silent inventions. They are not approved by this ADR.

| Topic | Working reading | Item |
|---|---|---|
| Eligible bullet | Any recognized bullet in the three sections, any length | 3 |
| Keyword formula | Average completion × 7, round half up; the “Points” column is not a second score | A12 |
| Impact below 10% quantified | Score 0; ignore the stray C4 label | A16 |
| Unresolved criterion | Return withheld, disclose it, do not rescale the subtotal | 1 |

## Acceptance

A decision is closed only when the product owner accepts a replacement ADR that states the rule, including boundary examples. Implementation then updates the rubric version.
