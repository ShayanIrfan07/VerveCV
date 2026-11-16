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

### Stopping retention execution vs inspecting task records

These are different operator actions. Do not conflate them.

| Action | Purpose | Allowed during PITR reconciliation? |
|---|---|---|
| **Stop retention execution** | Prevent `runRetentionPass`, the periodic scheduler (`RETENTION_POLL_MS` / `attachRetentionRuntime` `scheduled` mode), lease claims, R2 deletes, and mutating `retention:requeue` (anything that advances or requeues work) | **Required** from before PITR through inventory, classification, and recorded repair decisions |
| **Inspect existing task records and leases** | Read-only review of `retention_tasks` rows (`state`, `attempts`, `lease_owner`, `lease_until`, `next_attempt_at`, `last_error_code`, `completed_at`) and related resume/version keys | **Allowed and expected** while execution is paused; inspection does not delete objects or claim leases |

Practical ways to stop execution (choose one and record it):

1. Redeploy/run the API so `attachRetentionRuntime` stays in `mode: "disabled"` (no `db`+`storage` pair for the worker—typically by omitting R2/storage credentials on a maintenance process while still allowing Neon SQL access), **or**
2. Keep API processes that would schedule retention fully stopped, and perform inventory only through the Neon SQL console / a read-only DB session.

While execution is paused:

- Do **not** run `retention:requeue` except `--dry-run` listing.
- Do **not** rely on production `NODE_ENV=production` startup catch-up passes.
- Do **read** `retention_tasks` and lease columns freely; stale `running` + expired `lease_until` rows are inventory signals, not a reason to start a worker yet.

### 1. Pause retention execution, then PITR, then redeploy (still paused)

1. Pause application writes if possible (maintenance mode or scale to zero briefly).
2. **Stop retention execution** using one of the methods above. Confirm no scheduler tick or retention pass is running before continuing.
3. Restore Neon to the approved PITR timestamp.
4. Redeploy the application SHA that matches that schema/data era **with retention execution still stopped**.
5. Keep retention execution paused for all of inventory (§2), classification (§3), and recorded repair decisions (§4). Do not resume workers “so leases can be observed”—leases are observed by **inspecting** rows, not by running the worker.

### 2. Inventory both sides (execution still paused)

From PostgreSQL (read-only queries are preferred):

- Active versions: `resume_versions` where the parent resume is not deleted and `object_key` does not start with `purged_`.
- Soft-deleted / scrubbed versions: rows whose resume is deleted, filename/title scrubbed, or `object_key` like `purged_%`.
- Retention task **inspection** (not execution): `retention_tasks.state` counts for `pending`, `running`, `retryable_failure`, `failed`, and `completed`, plus `attempts` / `lease_owner` / `lease_until` / `next_attempt_at` outliers. Treat this as a snapshot of records and leases only.

From R2:

- List object keys under the resume prefix used by the environment.
- If object versioning / noncurrent retention is enabled (only after ADR 0001 decision 13 / A8 documents it), note whether noncurrent versions exist—but do not restore them yet.

### 3. Classify divergence (execution still paused)

| Class | Meaning | Safe default |
|---|---|---|
| Missing object | DB points at an `object_key` that R2 no longer has | Leave missing. Do **not** auto-restore personal bytes. Mark the version unreadable / leave or plan a retention/investigation task **without starting the worker yet**. Restore from R2 versioning only with explicit human approval and an audit event. |
| Orphaned object | R2 object has no matching non-purged DB row | Quarantine in an operator list. Do **not** re-link to a user. Delete the orphan only after explicit approval and retention-policy review. |
| Deleted / purged state | DB shows user delete or `purged_` key, and R2 object is gone or intentionally retained as noncurrent | Leave deleted. Never undelete to satisfy reconciliation. |
| Retention-task inconsistency | Task `completed` but object still present; task `pending`/`failed` but object already gone; `running` lease older than `lease_until` | Plan repairs to match observed storage. Prefer completing/canceling task **rows** (with audit) over recreating user-visible files. Do not start leased deletes until §5. |

### 4. Record reconciliation decisions (execution still paused)

For each inconsistent item, choose one explicit action, write it down, and audit planned or applied row repairs (`audit_events` with no resume text, emails, or object payloads):

1. **Object gone + delete intended** → mark task `completed`, scrub remaining filename/hash fields if needed, ensure `object_key` is `purged_<versionId>`.
2. **Object present + delete intended** → leave or set task `pending`/`retryable_failure` for later worker execution; do not skip fencing when execution eventually resumes.
3. **Object missing + resume still active** → keep the resume inaccessible for download/evaluation; open an operator incident. Restore bytes only with named approval. Prefer asking the user to re-upload over undeleting.
4. **Orphan R2 object** → do not create a new DB row that reattaches personal data to an account. Delete or hold under operator control.

Use `retention:requeue --dry-run` only to preview IDs. Do **not** run mutating requeue or start the scheduler until §5 validation passes.

### 5. Validate restored state, then resume retention execution

Only after inventory, classification, and reconciliation decisions are recorded:

1. `health/live` and `health/ready` are 200 on the restored SHA.
2. Spot-check authentication, upload, evaluation, history, and deletion **without** relying on background retention yet.
3. Confirm divergence counts and decision log are filed (PITR timestamp, application SHA, missing / orphan / task repairs, personal-object restores—default none).
4. **Then** re-enable retention execution (restore R2/storage credentials / normal `attachRetentionRuntime` scheduled mode, or bring the retention-capable API back).
5. Allow a single controlled catch-up pass; use `retention:requeue` only for tasks explicitly approved in §4 (dry-run first; bulk `--all` requires the CLI confirmation path).
6. Confirm at least one intended retention completion (or that no pending deletes remain that should have run).

## Object storage rollback (without DB PITR)

- R2 object deletes performed by retention are not undone by an application-only rollback.
- If a retention bug deleted live objects, restore from R2 versioning / noncurrent object retention only when that provider setting is enabled, documented (ADR 0001 decision 13 / A8), and a human approves each restore. Until then, do not claim backup restoration in product copy.
- Stop retention execution before any bulk storage repair, inspect task/lease rows read-only, and resume execution only after decisions are recorded.

## Feature flags and billing

- Version 1 does not enable Pro checkout. Phase 8 remains blocked on ADR 0001 decisions 10 and 11. Rolling back cannot activate Pro entitlements from client input.
- Operational env defaults (`SESSION_TTL_SECONDS`, rate limits, `RETENTION_*`) can be reverted by redeploying previous env values without a schema change.
- Deterministic rule-based scoring, Free-only launch, 90-day retention, and the 100 MiB footprint gate remain in force after rollback.

## Communication

Record the incident SHA, restore timestamp, when retention execution was paused and resumed, divergence counts, and health-check evidence in the operator notes. Keep request IDs from failing responses; do not paste credentials, cookies, object bodies, or resume text into tickets.
