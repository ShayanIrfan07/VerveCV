# Rollback strategy

VerveCV Version 1 is a modular monolith. Roll back by redeploying a known-good git revision and, only when schema compatibility requires it, restoring the database from a Neon point-in-time recovery (PITR) or snapshot.

## Application rollback

1. Identify the last known-good commit on `main` (CI green: lint, typecheck, `db:check`, tests, build, `size:check`).
2. Redeploy that commit to the API host and the static web host.
3. Confirm `GET /api/v1/health/live` returns `200` and `GET /api/v1/health/ready` returns `200` with a configured database.
4. Confirm a signed-in smoke path: login, list resumes, open an existing evaluation.

Do not hot-patch production with uncommitted local files. Prefer a clean deploy of a tagged or SHA-pinned revision.

## Database rollback

- Forward-only Drizzle migrations are the default. Prefer shipping a new forward migration that restores compatibility over rewriting history.
- If a bad migration has already applied and forward repair is unsafe, restore Neon to a PITR timestamp taken before the bad deploy, then redeploy the matching application SHA.
- After a database restore, run one retention catch-up pass (API startup with `attachRetentionRuntime`, or an operator `retention:requeue` after storage issues are fixed) so expired or deleted versions are not left indefinitely.

## Object storage rollback

- R2 object deletes performed by retention are not undone by an application rollback.
- If a retention bug deleted live objects, restore from R2 versioning / noncurrent object retention only when that provider setting is enabled and documented. Until ADR 0001 decision 13 / item A8 records those settings, do not claim backup restoration in product copy.

## Feature flags and billing

- Version 1 does not enable Pro checkout. Phase 8 remains blocked on ADR 0001 decisions 10 and 11. Rolling back cannot activate Pro entitlements from client input.
- Operational env defaults (`SESSION_TTL_SECONDS`, rate limits, `RETENTION_*`) can be reverted by redeploying previous env values without a schema change.

## Communication

Record the incident SHA, restore timestamp, and health-check evidence in the operator notes. Keep request IDs from failing responses; do not paste credentials, cookies, or resume text into tickets.
