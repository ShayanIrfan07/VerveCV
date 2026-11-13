# VerveCV

Make every bullet count.

VerveCV is a multi-user, rule-based resume evaluator, not an AI-assisted platform. Version 1 is fully rule-based and evaluates PDF and DOCX resumes against a deterministic, versioned 100-point rubric, with no retrieval-augmented generation (RAG), large language model (LLM), embeddings service, or external AI or grammar API.

Phase 0 records the architecture and the open scoring decisions. Phase 1 provides the workspace shell, Phase 2 adds PostgreSQL migrations and cookie-based authentication, Phase 3 adds browser-side PDF/DOCX preview and server-side upload verification, and Phase 4 scores only the rubric rules that are already specified. Phase 5 measured the English spelling candidate and left it uninstalled, so grammar and spelling stays withheld. A result stays provisional: withheld criteria stay out of the denominator, and the score is not rescaled to 100. Penalties that the rubric cannot yet compute are reported as not evaluated rather than as a zero deduction.

## Development

Node.js 22 or newer runs locally. Continuous integration uses Node.js 26, the current Active LTS. pnpm is invoked through Corepack because a global `pnpm` shim may require an administrator install.

```bash
corepack pnpm install
corepack pnpm dev:api
corepack pnpm dev:web
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm db:check
corepack pnpm test
corepack pnpm build
corepack pnpm size:check
```

The API listens on `0.0.0.0:$PORT` (`PORT` defaults to 3000). `GET /api/v1/health/live` reports that the process is up. `GET /api/v1/health/ready` checks the database when `DATABASE_URL` is set.

`COOKIE_SECRET` must be at least 32 characters before the API process will start. Registration creates a Free subscription and does not start a session. Login sets signed `HttpOnly`, `SameSite=Lax` session and refresh cookies (`Secure` when `NODE_ENV=production`). Mutating `/api/v1` requests must send an `Origin` listed in `ALLOWED_ORIGINS`.

The browser dev server proxies `/api` to `http://localhost:3000`. A local preview uses PDF.js and Mammoth in a worker. Storing a file requires private R2 credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) and `SIGNED_URL_TTL_SECONDS` (`1..3600`). Server-side parsing also requires `PDF_PAGE_CAP`, `DOCX_ENTRY_CAP`, `DOCX_UNCOMPRESSED_BYTES`, `PARSE_TIMEOUT_MS`, and `PARSE_CONCURRENCY` (bounded by `PARSE_MAX_QUEUE` and `PARSE_QUEUE_TIMEOUT_MS`). Until those are set, the API leaves the upload pending and the preview stays a browser reading. The upload limit defaults to 5 MiB.

### Session invalidation vs. logout-all-devices

- **`POST /api/v1/auth/logout` (single-device logout)**: Revokes the caller's current session and its entire refresh-token rotation lineage (ancestors and descendants created by token rotation on that device/client) inside a database transaction, and clears the browser cookies. Independent login sessions on other devices keep their own root session IDs and remain active.
- **Logout-all-devices (not exposed as a separate endpoint in Phase 2/3)**: Would revoke every active `sessions` row for `user_id` across all login roots/devices (for example upon password reset or explicit account-wide sign-out in a later phase).

### Deletion lifecycle status (release-blocking dependency for Phase 7)

`DELETE /api/v1/resumes/:resumeId` performs **logical soft-deletion only** in Phase 3: it immediately revokes read, listing, download-URL (`view-url`), and verification access by setting `resumes.deleted_at` and `resume_versions.deletion_state = "delete_requested"`, and enqueues `pending` rows in `retention_tasks`. **Physical deletion is not yet complete**: retryable R2 object deletion, 90-day expiry sweeps, and derived evaluation/finding purges are a **release-blocking dependency assigned to Phase 7 (`feature/retention-and-hardening`)**.

### Operational defaults pending ADR 0001 approval

Session lifetime (`SESSION_TTL_SECONDS`, default 12 hours), authentication rate limits (`AUTH_RATE_LIMIT_*`), parse queue backpressure (`PARSE_MAX_QUEUE`, `PARSE_QUEUE_TIMEOUT_MS`), and pending upload bounds (`MAX_PENDING_UPLOADS_PER_USER`, `UPLOAD_INTENT_GRACE_SECONDS`) are configurable operational protections until ADR 0001 item A7 records owner-approved product values.

## Documents

- [High-level design](docs/architecture/HLD.md)
- [Low-level design](docs/architecture/LLD.md)
- [Scoring rubric](docs/architecture/RUBRIC.md)
- [Security architecture](docs/architecture/SECURITY.md)
- [Open product decisions](docs/adr/0001-open-product-decisions.md)

Authoritative scores stay provisional until the open decisions that affect scoring are approved. A provisional result is not rescaled to 100.
