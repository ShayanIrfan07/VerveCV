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

## Staging smoke checklist

- [ ] `health/live` → 200
- [ ] `health/ready` → 200
- [ ] Register + login + logout; cookies are `HttpOnly` / `SameSite=Lax` (`Secure` in production)
- [ ] Upload PDF/DOCX under the byte limit; reject oversize and bad magic
- [ ] Evaluate a verified resume; provisional score discloses withheld criteria
- [ ] Delete a resume; access revoked immediately; retention task completes or retries without leaking PII in logs
- [ ] Cross-origin mutation without an allowed `Origin` is rejected
- [ ] Footprint: `pnpm size:check` still passes on the deployed revision

## Free-tier caveats

- Render free web services spin down after inactivity; retention sweeps resume on the next wake (`runOnStart: true`).
- Neon free databases have storage and expiry limits; treat them as finite.
- Do not describe Free plan capacity as unlimited while quotas are unset (ADR 0001 decision 10).
