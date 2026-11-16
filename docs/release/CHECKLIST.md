# Version 1 production checklist

Branch: `feature/release-readiness`  
Phase 8 (`feature/pro-subscriptions`) is intentionally skipped until ADR 0001 decisions 10 (pricing/quotas) and 11 (payment provider) are approved.

Re-run the automated gate with:

```bash
corepack pnpm release:check
```

Machine-readable probe output is written to [`measurements.json`](./measurements.json).

## Automated gates

Latest local `pnpm release:check` on Node `v24.18.0` (win32/x64), 2026-11-16:

| Gate | Command | Result |
|---|---|---|
| Lint | `pnpm lint` | Pass |
| Typecheck | `pnpm typecheck` | Pass |
| Migration check | `pnpm db:check` | Pass (also enforced in CI) |
| Unit/integration tests | `pnpm test` | Pass (122 tests; includes retention lease/backoff/privacy) |
| Build | `pnpm build` | Pass |
| Footprint ≤ 100 MiB | `pnpm size:check` | Pass — **69.31 / 100.00 MiB** |
| API latency probe | part of `release:check` | `/api/v1/health/live` × 50 — p50 **0.144 ms**, p95 **0.508 ms** |
| API RSS after probe | part of `release:check` | **~205 MiB** process RSS (workstation Node; not a host SLA) |

## Security checks

| Check | Evidence |
|---|---|
| API CSP denies third-party scripts / Lottie CDN | `apps/api/src/app.test.ts` |
| Web CSP allows same-origin + R2 + blob workers only | `apps/web/index.html` |
| Auth/session/CSRF Origin enforcement | `apps/api/src/auth.test.ts` |
| DB auth/connection failures → 503 without secret leakage | `apps/api/src/auth.test.ts` |
| Upload magic/size/DOC rejection | `apps/api/src/uploads.test.ts` |
| Retention PII scrubbing + dead-letter alerts | `apps/api/src/retention.test.ts` |
| No Pro activation from client input | Billing routes remain unregistered |

## Accessibility and viewport

Latest local `pnpm test:e2e` (desktop/tablet/mobile): **6 passed**.

| Check | Command / evidence |
|---|---|
| Account form labels + keyboard focus | `pnpm test:e2e` → `release.accessibility.spec.ts` |
| Sample PDF preview layout / no horizontal overflow | `pnpm test:e2e` → `preview.viewports.spec.ts` |

Install browsers once with `corepack pnpm exec playwright install chromium` before `test:e2e`.

## Retention verification

| Check | Evidence |
|---|---|
| Lease fencing / crash recovery | `retention.test.ts` |
| Exponential backoff + permanent failure alerts | `retention.test.ts` |
| Operator requeue dry-run / bulk confirmation | retention requeue CLI tests |
| Production scheduler caveat (sleeping free hosts) | README + `STAGING.md` |

## Staging and rollback

- Staging procedure: [`STAGING.md`](./STAGING.md)
- Rollback procedure: [`ROLLBACK.md`](./ROLLBACK.md)

## Release blockers (do not claim FINAL score or Pro)

From [`docs/adr/0001-open-product-decisions.md`](../adr/0001-open-product-decisions.md):

- Readability and other open scoring items keep results **provisional** (not rescaled to 100).
- Free/Pro prices and quotas unset (decision 10).
- Payment provider unset; checkout/webhook unregistered (decision 11).
- Production host/plan unset (decision 13); document provider backup retention before claiming it (A8).
- Operational TTLs/rate limits remain configurable defaults until A7.

## Sign-off

| Item | Owner | Date |
|---|---|---|
| `pnpm release:check` green on release SHA | | |
| Staging smoke checklist complete | | |
| Open ADR limitations disclosed in product UI/docs | | |
| Rollback owner identified | | |
