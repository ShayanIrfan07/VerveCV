# Rollback strategy

VerveCV Version 1 is a modular monolith. Roll back by redeploying a known-good git revision and, only when schema compatibility requires it, restoring the database from a Neon point-in-time recovery (PITR) or snapshot.

**Never automatically restore deleted personal data.** User-requested deletes and completed 90-day purges stay deleted unless a human operator explicitly approves a restore for a named object and records an audit note.

## Application rollback

1. Identify the last known-good commit on `main` (CI green: lint, typecheck, `db:check`, tests, build, `size:check`, `test:e2e`).
2. Redeploy that commit to the API host and the static web host.
3. Confirm `GET /api/v1/health/live` returns `200` and `GET /api/v1/health/ready` returns `200` with a configured database.
4. Confirm a signed-in smoke path: login, list resumes, open an existing evaluation.

Do not hot-patch production with uncommitted local files. Prefer a clean deploy of a tagged or SHA-pinned revision.

## Database rollback

- Forward-only Drizzle migrations are the default. Prefer shipping a new forward migration that restores compatibility over rewriting history.
- If a bad migration has already applied and forward repair is unsafe, restore Neon to a PITR timestamp taken before the bad deploy, then redeploy the matching application SHA.
- After any database restore, complete the Neon/R2 reconciliation procedure below before returning the environment to general traffic.

## Neon / R2 reconciliation after database PITR

A Neon restore rewinds rows. It does not rewind Cloudflare R2. Expect divergence until an operator reconciles both stores.

### 1. Freeze and redeploy

1. Pause application writes if possible (maintenance mode or scale to zero briefly).
2. Restore Neon to the approved PITR timestamp.
3. Redeploy the application SHA that matches that schema/data era.
4. Keep retention workers enabled so leases can be observed, but do not bulk-requeue failed tasks until classification finishes.

### 2. Inventory both sides

From PostgreSQL (read-only queries are preferred):

- Active versions: `resume_versions` where the parent resume is not deleted and `object_key` does not start with `purged_`.
- Soft-deleted / scrubbed versions: rows whose resume is deleted, filename/title scrubbed, or `object_key` like `purged_%`.
- Retention tasks: `retention_tasks.state` counts for `pending`, `running`, `retryable_failure`, `failed`, and `completed`, plus `attempts` / `lease_owner` / `lease_until` outliers.

From R2:

- List object keys under the resume prefix used by the environment.
- If object versioning / noncurrent retention is enabled (only after ADR 0001 decision 13 / A8 documents it), note whether noncurrent versions exist—but do not restore them yet.

### 3. Classify divergence

| Class | Meaning | Safe default |
|---|---|---|
| Missing object | DB points at an `object_key` that R2 no longer has | Leave missing. Do **not** auto-restore personal bytes. Mark the version unreadable / enqueue or keep a retention/investigation task. Restore from R2 versioning only with explicit human approval and an audit event. |
| Orphaned object | R2 object has no matching non-purged DB row | Quarantine in an operator list. Do **not** re-link to a user. Delete the orphan only after explicit approval and retention-policy review. |
| Deleted / purged state | DB shows user delete or `purged_` key, and R2 object is gone or intentionally retained as noncurrent | Leave deleted. Never undelete to satisfy reconciliation. |
| Retention-task inconsistency | Task `completed` but object still present; task `pending`/`failed` but object already gone; `running` lease older than `lease_until` | Repair task state to match observed storage after classification. Prefer completing/canceling tasks over recreating user-visible files. |

### 4. Repair retention-task consistency

For each inconsistent task, choose one explicit action and audit it (`audit_events` with no resume text, emails, or object payloads):

1. **Object gone + delete intended** → mark task `completed`, scrub remaining filename/hash fields if needed, ensure `object_key` is `purged_<versionId>`.
2. **Object present + delete intended** → leave or set task `pending`/`retryable_failure` and let the leased worker delete; do not skip fencing.
3. **Object missing + resume still active** → keep the resume inaccessible for download/evaluation; open an operator incident. Restore bytes only with named approval. Prefer asking the user to re-upload over undeleting.
4. **Orphan R2 object** → do not create a new DB row that reattaches personal data to an account. Delete or hold under operator control.

Use `retention:requeue --dry-run` before any bulk requeue. Bulk `--all` requires the CLI confirmation path already enforced by the tool.

### 5. Return to service

1. `health/live` and `health/ready` are 200.
2. Spot-check authentication, upload, evaluation, history, deletion, and one retention completion on staging-like data.
3. Record PITR timestamp, application SHA, divergence counts (missing / orphan / task repairs), and whether any personal-object restore was approved (default: none).

## Object storage rollback (without DB PITR)

- R2 object deletes performed by retention are not undone by an application-only rollback.
- If a retention bug deleted live objects, restore from R2 versioning / noncurrent object retention only when that provider setting is enabled, documented (ADR 0001 decision 13 / A8), and a human approves each restore. Until then, do not claim backup restoration in product copy.

## Feature flags and billing

- Version 1 does not enable Pro checkout. Phase 8 remains blocked on ADR 0001 decisions 10 and 11. Rolling back cannot activate Pro entitlements from client input.
- Operational env defaults (`SESSION_TTL_SECONDS`, rate limits, `RETENTION_*`) can be reverted by redeploying previous env values without a schema change.
- Deterministic rule-based scoring, Free-only launch, 90-day retention, and the 100 MiB footprint gate remain in force after rollback.

## Communication

Record the incident SHA, restore timestamp, divergence counts, and health-check evidence in the operator notes. Keep request IDs from failing responses; do not paste credentials, cookies, object bodies, or resume text into tickets.
