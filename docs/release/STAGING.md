# Staging deployment

Staging mirrors production topology at reduced cost: one Node.js API, one static web origin, Neon PostgreSQL, and private Cloudflare R2. Render’s free web service is acceptable for staging and will sleep after inactivity.

## Required secrets and config

Copy from `.env.example`. Staging must set:

| Variable | Notes |
|---|---|
| `COOKIE_SECRET` | ≥ 32 characters, unique per environment |
| `ALLOWED_ORIGINS` | Exact staging web origin(s), comma-separated |
| `DATABASE_URL` | Neon staging branch or database |
| `NODE_ENV` | `production` so retention scheduling and rate-limit defaults engage |
| R2 credentials + bucket | Private bucket; no public ACLs |
| Parse / signed-URL caps | `SIGNED_URL_TTL_SECONDS`, `PDF_PAGE_CAP`, `DOCX_ENTRY_CAP`, `DOCX_UNCOMPRESSED_BYTES`, `PARSE_TIMEOUT_MS`, `PARSE_CONCURRENCY` |

Unset parse/signed-URL values refuse server-side parsing and signed URLs by design. Do not invent product quotas while ADR 0001 decisions 10 and A7 remain open.

## Deploy shape

1. API: bind `0.0.0.0:$PORT`. Health: `/api/v1/health/live` and `/api/v1/health/ready`.
2. Web: static build from `apps/web` (`pnpm --filter @vervecv/web build`). Configure the CDN/host CSP to match `apps/web/index.html` (no third-party script hosts, no Lottie CDN).
3. Apply Drizzle migrations against the staging database before traffic.
4. Confirm retention: with `NODE_ENV=production`, database, and R2 configured, startup runs an immediate retention pass and a periodic scheduler (`RETENTION_POLL_MS`, default 5 minutes).

## Required staging sign-off capabilities

Each row is a separate release sign-off. Do not collapse them into a single “smoke passed” checkbox. Record owner, date, and evidence (request IDs or staging URLs—never passwords or resume bytes) in [`CHECKLIST.md`](./CHECKLIST.md).

| Capability | Pass criteria |
|---|---|
| Authentication | Register, login, logout, session restore after refresh; mutating requests without an allowed `Origin` fail; cookies are `HttpOnly` / `SameSite=Lax` (`Secure` when `NODE_ENV=production`). |
| PDF upload | Upload a valid PDF under the byte limit through intent → PUT → complete; reject oversize and bad magic; preview/verification path works with configured parse caps. |
| DOCX upload | Same as PDF for a valid DOCX; reject legacy DOC and corrupt archives per product rules. |
| Evaluation | Run evaluation on a verified resume; response stays provisional; withheld criteria are disclosed; no client-supplied score is accepted. |
| Score history | A second evaluation (or prior row) appears in history for the same user/resume path without exposing another user’s results. |
| Deletion | `DELETE /api/v1/resumes/:id` immediately revokes list/get/view-url/evaluate access and scrubs filename/title fields. |
| Retention completion | The enqueued retention task reaches `completed` (or an observed retry that later completes): R2 object removed, derived evaluation/finding rows gone, `object_key` scrubbed to `purged_<versionId>`, logs free of resume text/PII. |

## Mandatory Playwright gate before production

`pnpm test:e2e` is required in CI on this branch and must also be green against the release SHA before production sign-off. Staging UI sign-off above does not replace that automated E2E gate.

## Free-tier caveats

- Render free web services spin down after inactivity; retention sweeps resume on the next wake (`runOnStart: true`).
- Neon free databases have storage and expiry limits; treat them as finite.
- Do not describe Free plan capacity as unlimited while quotas are unset (ADR 0001 decision 10).
- Version 1 remains Free-only, deterministic/rule-based, 90-day retention, and inside the 100 MiB source + production-dependency footprint.
