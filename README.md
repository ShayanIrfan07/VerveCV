# VerveCV

Make every bullet count.

VerveCV is a multi-user, rule-based resume evaluator, not an AI-assisted platform. Version 1 is fully rule-based and evaluates PDF and DOCX resumes against a deterministic, versioned 100-point rubric, with no retrieval-augmented generation (RAG), large language model (LLM), embeddings service, or external AI or grammar API.

Phase 0 records the architecture and the open scoring decisions. Phase 1 provides the workspace shell, Phase 2 adds PostgreSQL migrations and cookie-based authentication, Phase 3 adds browser-side PDF/DOCX preview and server-side upload verification, and Phase 4 scores only the rubric rules that are already specified. Phase 5 adds deterministic grammar, spelling (`nspell@2.1.5` + `dictionary-en@4.0.0` with a versioned technical-term allowlist), and punctuation checks with UTF-16 evidence locators; while ADR 0001 item A9 (distinct-error counting and grammar-vs-punctuation precedence) remains open, validated findings are surfaced as informational suggestions and the grammar and punctuation scores stay withheld. Phase 6 shows that provisional score and a history of earlier scores after the server re-reads a verified resume. Phase 7 enforces 90-day and user-requested physical deletion of stored R2 resume bytes and derived evaluations/findings using PostgreSQL-leased tasks, bounded exponential backoff with jitter, dead-letter alerting and operator requeue tooling, and production-safe upload and evaluation rate limits. Phase 8 (Pro subscriptions) stays blocked until ADR 0001 pricing, quotas, and a payment provider are approved. Phase 9 records the Version 1 release checklist, staging and rollback runbooks, and the `pnpm release:check` gate. A result stays provisional: withheld criteria stay out of the denominator, and the score is not rescaled to 100. Penalties that the rubric cannot yet compute are reported as not evaluated rather than as a zero deduction.

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
corepack pnpm release:check
corepack pnpm test:e2e
```

`pnpm release:check` runs lint, typecheck, `db:check`, tests, build, `size:check`, then an API memory/latency probe and writes `docs/release/measurements.json`. Playwright browsers are required only for `pnpm test:e2e` (`corepack pnpm exec playwright install chromium`).

The API listens on `0.0.0.0:$PORT` (`PORT` defaults to 3000). `GET /api/v1/health/live` reports that the process is up. `GET /api/v1/health/ready` checks the database when `DATABASE_URL` is set.

`COOKIE_SECRET` must be at least 32 characters before the API process will start. Registration creates a Free subscription and does not start a session. Login sets signed `HttpOnly`, `SameSite=Lax` session and refresh cookies (`Secure` when `NODE_ENV=production`). Mutating `/api/v1` requests must send an `Origin` listed in `ALLOWED_ORIGINS`.

The browser dev server proxies `/api` to `http://localhost:3000`. A local preview uses PDF.js and Mammoth in a worker. Storing a file requires private R2 credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) and `SIGNED_URL_TTL_SECONDS` (`1..3600`). Server-side parsing also requires `PDF_PAGE_CAP`, `DOCX_ENTRY_CAP`, `DOCX_UNCOMPRESSED_BYTES`, `PARSE_TIMEOUT_MS`, and `PARSE_CONCURRENCY` (bounded by `PARSE_MAX_QUEUE` and `PARSE_QUEUE_TIMEOUT_MS`). Until those are set, the API leaves the upload pending and the preview stays a browser reading. The upload limit defaults to 5 MiB.

### Session invalidation vs. logout-all-devices

- **`POST /api/v1/auth/logout` (single-device logout)**: Revokes the caller's current session and its entire refresh-token rotation lineage (ancestors and descendants created by token rotation on that device/client) inside a database transaction, and clears the browser cookies. Independent login sessions on other devices keep their own root session IDs and remain active.
- **Logout-all-devices (not exposed as a separate endpoint in Phase 2/3)**: Would revoke every active `sessions` row for `user_id` across all login roots/devices (for example upon password reset or explicit account-wide sign-out in a later phase).

### Deletion, 90-day retention, and operator recovery

- **`DELETE /api/v1/resumes/:resumeId` and 90-day expiry**: Immediately revokes read, listing, download-URL (`view-url`), verification, and evaluation access, scrubs `resumes.title` and `resume_versions.original_filename`, enqueues idempotent `retention_tasks`, and triggers an immediate bounded retention pass.
- **Periodic worker, lease renewal, and fencing**: When `NODE_ENV=production` and both `DATABASE_URL` and R2 credentials are configured, `attachRetentionRuntime` automatically starts an immediate startup pass plus a 5-minute periodic scheduler (`RETENTION_POLL_MS=300000` default) even if `RETENTION_POLL_MS` is unset. Tasks are claimed via `FOR UPDATE SKIP LOCKED` with expiring `lease_owner` / `lease_until` leases (`RETENTION_LEASE_MS`, default 60s), periodic heartbeat lease renewal (`leaseMs / 3`) during long R2 deletes, an `AbortSignal` delete timeout (`min(30s, 0.8 * leaseMs)`), and `(lease_owner, attempts)` write fencing so a stale worker can never overwrite a reclaimed task.
- **Behavior when the API is stopped or suspended**: Because the scheduler runs inside the API process, physical R2/database sweeps pause while the process is stopped or spun down on a sleeping free-tier host (such as Render Free after 15 minutes of inactivity). On the very next process start or wake-up, `attachRetentionRuntime` immediately executes a catch-up retention pass (`runOnStart: true`) that enqueues any versions whose `expires_at` passed while offline and reclaims any expired `running` leases. Strict wall-clock SLA enforcement without wake-up delay requires an always-on instance or a scheduled cron trigger.
- **Dead-letter alerting and operator requeue**: Transient R2 failures reschedule tasks in `retryable_failure` using bounded exponential backoff with jitter up to `RETENTION_MAX_ATTEMPTS` (default 8), after which tasks enter `state = "failed"` and emit structured `retention.permanent_failure` and periodic `retention.dead_letter_backlog` error logs. Once an operator resolves the underlying R2 outage or credential issue, permanently failed tasks can be safely requeued (`attempts` reset to `0`, `state = "pending"`, audited via `retention_task_requeued`) and processed immediately with:
  ```bash
  # Preview failed tasks without mutating DB state:
  corepack pnpm --filter @vervecv/api retention:requeue -- --dry-run

  # Targeted recovery of specific task ID(s):
  corepack pnpm --filter @vervecv/api retention:requeue -- --task-id <uuid>

  # Confirmed bulk recovery (optional --limit <1..1000> and --no-run):
  corepack pnpm --filter @vervecv/api retention:requeue -- --all
  ```
- **Privacy & backup boundary**: Completed purges delete the R2 object, `findings`, `evaluations`, and `evaluation_jobs`, replace `object_key` with `purged_<versionId>`, and scrub filenames, titles, candidate types, and SHA-256 hashes. The application does not claim that Neon point-in-time recovery or R2 noncurrent versions are removed.

### Operational defaults pending ADR 0001 approval

Session lifetime (`SESSION_TTL_SECONDS`, default 12 hours), authentication rate limits (`AUTH_RATE_LIMIT_*`), production upload/evaluation rate limits (`UPLOAD_RATE_LIMIT_*` and `EVALUATE_RATE_LIMIT_*`, defaulting to `10 / 60s` in `NODE_ENV=production` and optional in development), retention lease/backoff/poll settings (`RETENTION_*`), parse queue backpressure (`PARSE_MAX_QUEUE`, `PARSE_QUEUE_TIMEOUT_MS`), and pending upload bounds (`MAX_PENDING_UPLOADS_PER_USER`, `UPLOAD_INTENT_GRACE_SECONDS`) are configurable operational protections until ADR 0001 item A7 records owner-approved product values.

## Documents

- [High-level design](docs/architecture/HLD.md)
- [Low-level design](docs/architecture/LLD.md)
- [Scoring rubric](docs/architecture/RUBRIC.md)
- [Security architecture](docs/architecture/SECURITY.md)
- [Open product decisions](docs/adr/0001-open-product-decisions.md)
- [Release checklist](docs/release/CHECKLIST.md)
- [Staging deployment](docs/release/STAGING.md)
- [Rollback strategy](docs/release/ROLLBACK.md)

Authoritative scores stay provisional until the open decisions that affect scoring are approved. A provisional result is not rescaled to 100.
