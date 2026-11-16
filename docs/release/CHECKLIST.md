# Version 1 production checklist

Branch: `feature/release-readiness`  
Phase 8 (`feature/pro-subscriptions`) is intentionally skipped until ADR 0001 decisions 10 (pricing/quotas) and 11 (payment provider) are approved.

Version 1 constraints that remain binding: deterministic rule-based scoring (no LLM/RAG), Free-only launch, 90-day retention with physical delete, and ≤ 100 MiB tracked source + production dependencies.

Re-run the automated gate with:

```bash
corepack pnpm release:check
```

Machine-local probe output is written to `docs/release/measurements.local.json` (gitignored). It must not overwrite the tracked example at [`measurements.example.json`](./measurements.example.json).

## Automated gates

| Gate | Command | Role |
|---|---|---|
| Lint | `pnpm lint` | Required (CI + `release:check`) |
| Typecheck | `pnpm typecheck` | Required (CI + `release:check`) |
| Migration check | `pnpm db:check` | Required (CI + `release:check`) |
| Unit/integration tests | `pnpm test` | Required (CI + `release:check`; includes retention lease/backoff/privacy) |
| Build | `pnpm build` | Required (CI + `release:check`) |
| Footprint ≤ 100 MiB | `pnpm size:check` | Required (CI + `release:check`) |
| Playwright E2E | `pnpm test:e2e` | Required in CI and as a mandatory pre-production gate |
| In-process health/live inject probe | part of `release:check` | Optional sanity only — **not** production API performance |

### In-process probe disclaimer

The `release:check` latency/RSS numbers come from Fastify `inject` against `GET /api/v1/health/live` with `db=null`. That path is in-process only. It does **not** represent production API latency and excludes Neon/database, upload, evaluation, parsing, and Cloudflare R2. Do not paste those milliseconds into capacity or SLO claims.

Record the release SHA’s CI URL (or local command transcripts) in sign-off instead of treating workstation probe JSON as a performance baseline.

## Security checks

| Check | Evidence |
|---|---|
| API CSP denies third-party scripts / Lottie CDN | `apps/api/src/app.test.ts` |
| Web CSP allows same-origin + R2 + blob workers only | `apps/web/index.html` |
| Auth/session/CSRF Origin enforcement | `apps/api/src/auth.test.ts` |
| DB auth/connection failures → 503 without secret leakage | `apps/api/src/auth.test.ts` |
| Upload magic/size/DOC rejection | `apps/api/src/uploads.test.ts` |
| Retention PII scrubbing + dead-letter alerts | `apps/api/src/retention.test.ts` |
| No Pro activation from client input | Billing routes remain unregistered (Free-only) |

## Accessibility and viewport (Playwright)

| Check | Command / evidence |
|---|---|
| Account form labels + keyboard focus | `pnpm test:e2e` → `release.accessibility.spec.ts` |
| Sample PDF preview layout / no horizontal overflow | `pnpm test:e2e` → `preview.viewports.spec.ts` |

CI installs Chromium and runs `pnpm test:e2e`. Locally: `corepack pnpm exec playwright install chromium` once, then `corepack pnpm test:e2e`.

## Retention verification (automated)

| Check | Evidence |
|---|---|
| Lease fencing / crash recovery | `retention.test.ts` |
| Exponential backoff + permanent failure alerts | `retention.test.ts` |
| Operator requeue dry-run / bulk confirmation | retention requeue CLI tests |
| Production scheduler caveat (sleeping free hosts) | README + `STAGING.md` |

## Staging sign-off (required, separate rows)

Complete each capability on staging with its own owner, date, and evidence. Criteria are defined in [`STAGING.md`](./STAGING.md).

| Capability | Owner | Date | Evidence (request ID / notes) |
|---|---|---|---|
| Authentication | | | |
| PDF upload | | | |
| DOCX upload | | | |
| Evaluation | | | |
| Score history | | | |
| Deletion | | | |
| Retention completion | | | |

## Staging and rollback runbooks

- Staging procedure: [`STAGING.md`](./STAGING.md)
- Rollback + Neon/R2 PITR reconciliation: [`ROLLBACK.md`](./ROLLBACK.md)

## Release blockers (do not claim FINAL score or Pro)

From [`docs/adr/0001-open-product-decisions.md`](../adr/0001-open-product-decisions.md):

- Readability and other open scoring items keep results **provisional** (not rescaled to 100).
- Free/Pro prices and quotas unset (decision 10) → Free-only launch.
- Payment provider unset; checkout/webhook unregistered (decision 11).
- Production host/plan unset (decision 13); document provider backup retention before claiming it (A8).
- Operational TTLs/rate limits remain configurable defaults until A7.

## Final sign-off

| Item | Owner | Date |
|---|---|---|
| CI green on release SHA (including `test:e2e`) | | |
| All seven staging capability rows above complete | | |
| Open ADR limitations disclosed in product UI/docs | | |
| Rollback owner identified; PITR reconciliation procedure reviewed | | |
| No merge/deploy without explicit approval | | |
