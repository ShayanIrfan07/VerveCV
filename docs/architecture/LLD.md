# VerveCV low-level design

Status: Phase 0 logical design. Schema and routes here are the contract for later phases. They are not implemented on this branch.
Date: 2026-11-12
Related: [HLD](HLD.md), [RUBRIC](RUBRIC.md), [Security](SECURITY.md), [ADR 0001](../adr/0001-open-product-decisions.md)

## 1. Repository layout

```text
vervecv/
  apps/web/                 React, Vite, Tailwind, workers
  apps/api/                 Fastify modules
  packages/contracts/       Shared API types and error shape
  packages/evaluation/      Pure scoring and normalization
  database/migrations/      Drizzle Kit SQL
  scripts/check-size.mjs    Production footprint gate (Phase 1)
  docs/architecture/
  docs/adr/
```

`apps/web` feature folders, when the UI phases start: `auth`, `upload`, `resume-viewer`, `evaluation`, `dashboard`, `history`.

`apps/api` modules: `auth`, `users`, `resumes`, `uploads`, `evaluations`, `jobs`, `subscriptions`, `retention`. Infrastructure folders: `db`, `storage`.

The evaluation package folders are `model`, `normalize`, `rules` (`bullets`, `formatting`, `grammar`, `relevance`, `penalties`), `dictionaries`, `scoring`, and `evidence`.

One pnpm lockfile covers the workspace. Application code and the size-gate script arrive in Phase 1, on `feature/project-bootstrap`.

## 2. Runtime and libraries

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript, strict | Shared by the browser and the API |
| UI | React, Vite, Tailwind | Approved stack; Tailwind stays a dev dependency |
| HTTP server | Fastify | Approved stack; JSON Schema via the Ajv Fastify already uses |
| HTTP client | Global `fetch` | No Axios |
| Database | Neon PostgreSQL, Drizzle ORM, Drizzle Kit | Approved stack |
| SQL driver | `postgres` (postgres.js) | Long-running API plus Neon’s pooled connection string |
| Passwords | `@node-rs/argon2` | Argon2id prebuilds, no compile toolchain |
| Object storage | Cloudflare R2 via `aws4fetch` | S3-compatible signing at about 0.06 MiB |
| PDF | PDF.js in a worker, lazy-loaded | Approved parser |
| DOCX | Mammoth in a worker, lazy-loaded | Approved parser |
| Logging | Pino through Fastify | Approved stack |
| Tests | Vitest, Playwright, both dev-only | Approved stack |

TypeBox is not added. Hand-written JSON Schemas and TypeScript interfaces are enough until real duplication shows up. Prisma is not added.

## 3. Canonical model

These types live in `packages/evaluation` and are re-exported from `packages/contracts` when the API returns them. Phase 0 defines them here; the package is created in Phase 1.

Offsets are UTF-16 code units, the same index space as JavaScript strings (`String.length` and `String.prototype.slice`). Browser highlights and server findings use that unit everywhere. Surrogate pairs count as two units. UTF-8 byte offsets and Unicode code-point offsets are not used.

```typescript
interface BoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResumeDocument {
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

interface ResumeSection {
  id: string;
  kind: ResumeSectionKind;
  heading: string;
  blockIds: string[];
}

type ResumeSectionKind =
  | "PROFESSIONAL_SUMMARY"
  | "WORK_EXPERIENCE"
  | "LEADERSHIP_EXPERIENCE"
  | "PROJECTS"
  | "EDUCATION"
  | "SKILLS"
  | "CERTIFICATIONS"
  | "CONTACT"
  | "OTHER";

interface ResumeBlock {
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

interface EvidenceReference {
  blockId: string;
  startOffset: number;
  endOffset: number;
  page?: number;
}

interface EvaluationFinding {
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

type RuleWithholdReasonCode =
  | "RULE_UNSPECIFIED"
  | "OPEN_DECISION"
  | "DICTIONARY_UNAVAILABLE"
  | "MISSING_CANDIDATE_TYPE"
  | "NO_APPLICABLE_ENTRIES"
  | "UNRESOLVED_BAND";

interface RuleResultBase {
  ruleId: string;
  maxScore: number;
  findings: EvaluationFinding[];
  version: string;
}

interface ScoredRuleResult extends RuleResultBase {
  status: "scored";
  score: number;
}

interface WithheldRuleResult extends RuleResultBase {
  status: "withheld";
  score: null;
  reasonCode: RuleWithholdReasonCode;
}

type RuleResult = ScoredRuleResult | WithheldRuleResult;
```

`ResumeSection` and `BoundingBox` are structural types required to carry the rubric’s sections and the brief’s coordinates. They do not add scoring rules.

PDF boxes are PDF user-space rectangles: origin at the bottom left of the page, unit is the PDF point (1/72 inch), taken from PDF.js text-item transforms. A box is stored only when extraction measured it. DOCX blocks do not receive fabricated pages or boxes. A DOCX block uses `paragraphId` and UTF-16 offsets.

`style` contains only properties the parser actually read (font family, size, bold, italic, underline, when present). Missing properties are omitted. The formatter must not treat a missing property as a confirmed inconsistency.

Section kind `OTHER` means the heading was not confidently classified. The word “Others” in the section-order templates is a different, still undefined concept (ADR 0001, decision 7). The parser must not invent a section that the document does not support.

`EvidenceReference` stores locators, not a second copy of the resume. A UI excerpt is taken from the extracted document at display time, or from a short snippet that is deleted with the evaluation. Findings are personal data and follow the 90-day retention rule.

## 4. Evaluation package contract

Every scoring function is a pure function:

```text
evaluate(document, options) -> EvaluationResult
```

`options` carries the rubric version, the candidate type selected by the user, an optional job description, and the user’s ignored terms. It does not carry a database handle or a clock that changes the score. Timestamps of the run are added by the API, outside the pure function.

Identical document, options, rubric version, and parser version produce identical results. No rule returns more than its maximum. Penalties are zero or negative contributions. The final score is clamped to 0..100 inclusive. Job-description output is attached as `jdMatch` and is ignored by the base-score sum.

Suggested rubric version string until the open decisions are closed: `rubric-2026-11-12-provisional`. Any change to a weight, band, penalty, or dictionary that changes a score requires a new version string.

Rules that hit an unresolved case return a withheld result (`status: "withheld"`, `score: null`, and a `reasonCode` from `RuleWithholdReasonCode`) rather than a guessed number. Scored rules return `status: "scored"` with a numeric `score` in `0..maxScore`. The aggregator excludes withheld maxima from the displayed denominator and sets `score_status` to `PROVISIONAL`.

## 5. Module boundaries

| Module | Owns | Does not own |
|---|---|---|
| Auth | Register, login, logout, refresh, session revoke, password hashing | Resume data |
| Users | Profile, `/me` | Passwords in logs |
| Resumes | Metadata, versions, ownership, delete | Bytes in Postgres |
| Uploads | Intent, magic bytes, size, signed URL, completion check | Scoring |
| Evaluations | Job enqueue, authoritative recompute, findings | Client-supplied scores |
| Jobs | Lease, attempt count, idempotency, crash recovery | A Redis queue |
| Subscriptions | Plan code, entitlement checks, usage counters | Prices and payment capture |
| Retention | Expiry, retryable delete jobs, audit of the delete | A claim about provider backups |
| Evaluation package | Rules and findings | HTTP and SQL |

Controllers validate and authorize. They call module services. Services call the evaluation package with plain data.

## 6. HTTP API

Prefix: `/api/v1`.

Error body, used for every error response:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "requestId": "request-id"
  }
}
```

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Create a user |
| POST | `/auth/login` | Create a session |
| POST | `/auth/refresh` | Rotate the refresh token |
| POST | `/auth/logout` | Revoke the caller’s session family (single-device lineage; distinct from account-wide logout-all-devices) |
| GET | `/me` | Current user |
| POST | `/resumes/upload-intents` | Reserve a version and a signed upload |
| POST | `/resumes/:resumeId/versions/:versionId/complete-upload` | Verify the stored object |
| GET | `/resumes` | List the caller’s resumes |
| GET | `/resumes/:id` | One resume, owned by the caller |
| GET | `/resumes/:id/versions/:versionId/view-url` | Short-lived download URL |
| DELETE | `/resumes/:id` | User-requested deletion |
| POST | `/evaluations` | Queue an authoritative evaluation |
| GET | `/evaluations/:id` | Score, findings, status |
| GET | `/evaluation-jobs/:id` | Job status |
| POST | `/ignored-terms` | Add a spelling ignore |
| DELETE | `/ignored-terms/:id` | Remove it |
| GET | `/usage` | Counters for the current period |
| GET | `/health/live` | Process is up |
| GET | `/health/ready` | Database connectivity |

`POST /evaluations` accepts `resumeVersionId`, `candidateType` (`FRESHER` or `EXPERIENCED`), `jobDescription` (string or null), and `idempotencyKey`. It does not accept a score.

Billing routes `POST /billing/checkout` and `POST /billing/webhook` are specified and stay unregistered until a payment provider is approved.

Status codes used by later phases: 202 when a job is queued, 401 and 403 for auth failures, 404 when the caller must not learn that another user’s id exists (see Security), 413 above the upload limit, 415 for an unsupported type, 422 when the file cannot be parsed, 429 for rate or quota limits.

The default upload limit is 5 MiB and it is configuration, separate from the 100 MiB dependency budget.

## 7. Database logical model

Primary keys are UUIDs generated in PostgreSQL with `gen_random_uuid()`. Timestamps are `timestamptz` stored in UTC. Foreign keys and ownership indexes are required. Score columns, when not null, are constrained to their legal ranges. Usage counters cannot go negative.

Email is stored in a normalized lowercase form with a unique constraint. The application normalizes before insert.

### users

`id`, `email`, `password_hash`, `display_name`, `email_verified_at`, `created_at`, `updated_at`, `deleted_at`

### sessions

`id`, `user_id`, `refresh_token_hash`, `expires_at`, `revoked_at`, `rotated_from_id`, `created_at`

The raw refresh token is never stored.

### plans

`code`, `active`, `created_at`

Seed codes are `FREE` and `PRO`. No price column is added until pricing is approved.

### subscriptions

`id`, `user_id`, `plan_code`, `provider`, `provider_customer_id`, `provider_subscription_id`, `status`, `current_period_start`, `current_period_end`, `created_at`, `updated_at`

A user starts on `FREE`. `PRO` is not written by client input. It is written only from a verified billing event after Phase 8 is approved.

### usage_counters

`user_id`, `period_start`, `evaluations_used`, `upload_bytes_used`, `updated_at`

Updates that reserve quota run in the same transaction as the job insert. Numeric limits are configuration. No limit number is seeded, because none has been approved. Behavior while limits are unset is ADR 0001, decision 10.

### resumes

`id`, `user_id`, `title`, `candidate_type`, `created_at`, `updated_at`, `deleted_at`

### resume_versions

`id`, `resume_id`, `version_number`, `original_filename`, `mime_type`, `size_bytes`, `sha256`, `object_key`, `parser_version`, `expires_at`, `deletion_state`, `created_at`

`expires_at` is `created_at` plus 90 days. `object_key` is an opaque random key, not a filename and not a user id path that a browser can guess.

### evaluation_jobs

`id`, `user_id`, `resume_version_id`, `status`, `attempts`, `lease_owner`, `lease_until`, `error_code`, `idempotency_key`, `created_at`, `started_at`, `finished_at`

`idempotency_key` is unique per user. Status values: `queued`, `running`, `succeeded`, `failed`. A crashed worker’s lease expires and another worker may retry up to a configured attempt bound. The attempt bound number is an operational setting still to be approved (ADR 0001, additional item A7).

### evaluations

`id`, `user_id`, `resume_version_id`, `job_id`, `rubric_version`, `parser_version`, `base_score`, `penalty_total`, `final_score`, `score_status`, `categories_json`, `jd_match_json`, `created_at`

`score_status` is `PREVIEW_ONLY`, `PROVISIONAL`, or `FINAL`. `final_score` is null when the result is preview-only. When it is present it is between 0 and 100.

### findings

`id`, `evaluation_id`, `rule_id`, `category`, `severity`, `message`, `suggestion`, `evidence_json`, `confidence`, `created_at`

### ignored_terms

`id`, `user_id`, `normalized_term`, `created_at`

Unique on (`user_id`, `normalized_term`).

### audit_events

`id`, `user_id`, `event_type`, `target_id`, `safe_metadata`, `created_at`

`safe_metadata` excludes resume text, contact details, passwords, tokens, and signed URLs.

### retention_tasks

`id`, `resume_version_id`, `state`, `attempts`, `next_attempt_at`, `last_error_code`, `completed_at`

States: `pending`, `running`, `succeeded`, `retryable_failure`. Object deletion and row deletion are idempotent. A missing object on a retry is success for that step.

## 8. Upload and verification sequence

1. The client asks for an upload intent with filename, claimed type, and byte length.
2. The API checks the extension, the claimed MIME type, and the 5 MiB default limit. Allowed types are `application/pdf` and `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Legacy `.doc` is rejected with 415.
3. The API inserts a `resume_versions` row and returns a short-lived signed `PUT` URL. The TTL number is not specified yet (ADR 0001, additional item A7).
4. The browser uploads the bytes directly to R2 and extracts them locally for preview.
5. `complete-upload` asks the API to `HEAD` or `GET` the object, check the actual size, the magic bytes, and the SHA-256.
6. PDF magic is `%PDF-`. DOCX magic is a ZIP local header (`PK\x03\x04`) and the archive must contain `[Content_Types].xml`.
7. The API enforces a PDF page limit, a DOCX entry limit, a DOCX uncompressed-size limit, and a parse timeout. Those numbers are required and not yet chosen.
8. Password-protected, corrupt, and image-only files (no extractable text) return 422 and are not scored. Image content is not OCR-processed in Version 1.
9. A file with some extractable text can be scored. The result discloses that non-text content was not read. No minimum-character threshold is invented here.
10. The evaluation worker re-extracts from the stored bytes and runs the pure evaluator. The client’s extracted JSON is ignored for the official score.

DOCX HTML from Mammoth is sanitized before any browser render. ZIP decompression uses a streaming limit so a zip bomb cannot expand without bound. Mammoth’s bundled `jszip` does not replace those limits on the server.

## 9. Highlighting

PDF highlights use stored user-space boxes. DOCX highlights use paragraph id and UTF-16 offsets inside `ResumeBlock.text`. The UI does not draw a fake page rectangle for DOCX.

Hover behavior from the product specification (highlight the bullet, the section, the filename, or the contact row) is a presentation requirement for Phase 6. Sample design ids BD0, BD1, BD2, FD1, FD2, FD3, and RD1 are references only. The PDF mentions a Figma reorder popup and does not include a Figma URL, so pixel layouts are not specified.

The source specification’s “AI generate” controls, including skill-adding buttons, are not built. A later phase may show a deterministic suggestion when a rule can produce one without inventing resume content. Generating skills or sentences is out of scope.

Confetti, when all five bullet-quality completion conditions are met, must respect `prefers-reduced-motion`. The Lottie URL in the source PDF is not loaded. The numeric meaning of the impact completion condition is still open, so the animation waits for that decision.

Section reorder, experience reorder, and filename suggestions preview a proposed change. They do not rewrite the stored original. A re-evaluation uploads a new `resume_versions` row.

## 10. Configuration

Secrets come from the environment: database URL, R2 credentials, cookie secret, and, later, billing secrets. They are never prefixed into the Vite client bundle.

Non-secret configuration includes the upload byte limit (default 5 MiB), retention days (90), and the unset quota, rate-limit, parse-limit, and token-lifetime values. Unset security and quota numbers stay unset until ADR 0001 records an approved value. Phase 2 and Phase 7 must not fill them with a silent default and then describe that default as a product rule.

## 11. Version 1 non-goals

Legacy DOC conversion, OCR, collaborative editing, public resume links, an AI writing aid, Pro checkout, and any score that depends on an unresolved rule. The dashboard still has a place to show that a criterion was withheld.
