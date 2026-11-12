# VerveCV high-level design

Status: Phase 0 architecture record. No application code is included.
Date: 2026-11-12
Product: VerveCV — “Make every bullet count.”
Release: Version 1, rule-based resume evaluation.

## 1. Purpose

VerveCV lets a signed-in user upload a PDF or DOCX resume, preview deterministic feedback in the browser, and receive an authoritative score from the API. The score uses a fixed 100-point rubric. Version 1 does not use a language model, retrieval-augmented generation, embeddings, a vector database, or an external AI or grammar API.

The original product specification reviewed for this design is the 25-page document `Resume AI Evaluator- Updated (3).pdf`. That file is not stored in this repository. Where that PDF and the locked implementation brief disagree, both wordings are recorded in [RUBRIC.md](RUBRIC.md) and [ADR 0001](../adr/0001-open-product-decisions.md). Missing rules are left open.

## 2. Confirmed product decisions

| Requirement | Decision |
|---|---|
| Overall score | 100 points |
| Evaluation method | Deterministic rules |
| AI, RAG, LLM, external AI API | Excluded from Version 1 |
| Grammar | Common grammar, spelling, and punctuation |
| Job description | Optional, and it does not change the base score |
| Resume retention | 90 days for the application data |
| Plans | Free and Pro |
| PDF and DOCX | Supported |
| Legacy DOC | Excluded from Version 1 |
| Extraction | Browser-first, with mandatory server verification |
| Source plus production dependencies | At most 104,857,600 bytes |
| Workflow | Feature branches and pull requests |

Category weights are part of the product contract. They are restated in [RUBRIC.md](RUBRIC.md) and must not be edited without a new rubric version.

## 3. System context

```text
User
  |
  v
React + TypeScript (Vite)
  |
  +-- PDF.js worker
  +-- Mammoth DOCX worker
  |
  v
Normalized resume (untrusted when it comes from the browser)
  |
  v
Shared evaluation package (preview)
  |
  v
Fastify API  ---- PostgreSQL (Neon)
     |      \
     |       \-- Cloudflare R2 (private)
     v
Server re-extraction and authoritative evaluation
```

The browser may show a preview as soon as local extraction finishes. A preview score is labeled as a preview. The API recomputes the score from the stored file before it saves an official result or applies subscription entitlements. If the server cannot verify the file, the saved status is `PREVIEW_ONLY`. The API rejects any client-supplied final score.

## 4. Architecture principles

1. One modular Fastify process contains the backend modules.
2. Deterministic scoring lives in a shared TypeScript package with no database, browser, or network access.
3. Original resume bytes live in private object storage. PostgreSQL stores metadata, scores, and findings.
4. Browser output is untrusted input.
5. Document processing has explicit concurrency and size limits.
6. Business rules stay testable without the HTTP server.
7. Hosting stays small: one frontend, one API, one Postgres database, one private bucket.
8. Redis, BullMQ, Elasticsearch, Kubernetes, and extra microservices are out of the Version 1 design.

Background work, when it is required, uses PostgreSQL-backed jobs with leases and retries.

## 5. Components

| Component | Responsibility |
|---|---|
| `apps/web` | Landing, authentication UI, upload, preview, dashboard, history |
| Browser workers | PDF.js text and positions; Mammoth DOCX structure |
| `packages/contracts` | Shared request and response types |
| `packages/evaluation` | Normalization helpers, rubric, findings, penalties |
| `apps/api` | Auth, uploads, verification, jobs, entitlements, retention |
| Neon PostgreSQL | System of record for accounts and evaluation metadata |
| Cloudflare R2 | Private original files, opaque keys, signed URLs |

React Router is not part of the Phase 1 bootstrap. It is introduced only when a later phase has real multi-page navigation, and only after its installed size is measured.

The server verifies a document by reading the stored object and extracting it again. The server does not trust browser JSON as the official document. Server-side PDF and DOCX extraction reuse the same parsers where that is practical, subject to the size budget and to the sandbox limits in [SECURITY.md](SECURITY.md). A narrow OOXML reader may be added later if Mammoth cannot expose a formatting property the rubric needs. LibreOffice and a Java conversion service are excluded.

## 6. Authoritative scoring path

```text
Base score = sum of category scores that are actually scored
Penalties  = specified penalties whose detectors are approved
Final      = clamp(base score - penalties, 0, 100)
```

Optional job-description matching is a separate result. It is stored beside the score and does not modify the base score.

`score_status` has three values:

| Status | Meaning |
|---|---|
| `PREVIEW_ONLY` | The original file was not verified by the server |
| `PROVISIONAL` | The file was verified, and at least one criterion or penalty is withheld or unresolved |
| `FINAL` | Every rubric criterion and penalty has an approved rule and was computed |

Version 1 cannot emit `FINAL` while the blocking decisions in ADR 0001 are open. Readability is a standing seven-point withhold. The UI may show a provisional subtotal whose denominator is 100 minus the maxima of withheld criteria. The brief allows a subtotal out of 93 when readability is the only withhold, if every other unresolved criterion is disclosed on that result. The subtotal is never rescaled to 100.

Category maxima remain 35, 15, 20, and 30 even while individual criteria are withheld.

## 7. Data stores

PostgreSQL holds users, sessions, plans, subscriptions, usage counters, resumes, resume versions, evaluation jobs, evaluations, findings, ignored terms, audit events, and retention tasks. The logical model is in [LLD.md](LLD.md).

R2 holds the original upload at an opaque key. The database stores the key, the SHA-256, the size, and the expiry. Resume binaries are not stored in PostgreSQL.

Derived personal data, including extracted text, previews, findings, and evidence locators, follows the same 90-day application retention period as the original file. Users can request deletion sooner. Deletion is idempotent and retryable. Backup and point-in-time-recovery retention of Neon and R2 is a provider property. The application must not claim that a delete removes those copies until the provider configuration says so.

## 8. Deployment design target

The brief names a design target and also leaves the final production host open (ADR 0001, decision 13).

| Piece | Design target | Constraint |
|---|---|---|
| Frontend | Cloudflare Pages | Static Vite build |
| API | One long-running Node.js service | Bind `0.0.0.0:$PORT` if the host is Render |
| Database | Neon PostgreSQL, pooled connection | Postgres is not exposed to the browser |
| Object storage | Private Cloudflare R2 | Signed upload and download URLs |
| Dev or small beta | Render free web service is allowed | Free instances spin down after 15 minutes; the filesystem is ephemeral |

The API process is the authority for scoring and deletion. Render’s free filesystem must not be used as resume storage.

Recommended runtime: Node.js 26.x Active LTS. On 2026-11-12 the Active LTS security release is 26.13.1. Node.js 24 is Maintenance LTS through 2028-04-30, and Node.js 22 is Maintenance LTS through 2027-04-30. Node.js 20 is end of life. This workstation currently has Node.js v24.18.0, which is older than the 2026-11-11 security release 24.22.3. Phase 1 should pin the API and CI image to current Node.js 26 Active LTS and should confirm that the chosen host provides that image. That pin is still a supported LTS, which is what the stack requires.

## 9. Dependency footprint

Limit: 104,857,600 bytes (100 MiB) for tracked source, production dependencies, production dictionaries, and production native binaries. Development dependencies, git history, test fixtures, caches, and build artifacts are outside this particular limit. Frontend bundle size, API artifact size, compressed deploy size, runtime disk, and peak memory are reported separately and do not relax the 100 MiB limit.

All footprint numbers in this Phase 0 document are **provisional estimates**, not verified measurements. Because Phase 0 contains no lockfile, installed `node_modules`, or application source code, the actual footprint must be verified in Phase 1 (and enforced in CI thereafter) by running `scripts/check-size.mjs` against the real installed production dependencies and tracked source files.

### 9.1 How this provisional estimate was made

On 2026-11-12 the npm registry `dist.unpackedSize` field was read for each package version below. Transitive `dependencies` were walked and resolved to the registry `latest` version at query time. That is not a lockfile resolution, and registry metadata can differ from files materialized on disk by `pnpm install`. `optionalDependencies` were not walked, except the single Linux argon2 binary measured on its own, and Phase 1+ tracked source files do not exist yet on this branch. Group totals were added without cross-group deduplication, so a shared transitive package would be counted twice. Treat this figure strictly as a provisional planning estimate, not a passing `scripts/check-size.mjs` run; Phase 1 implements that script and verifies the actual source-plus-production-dependency total.

### 9.2 Proposed production set

Frontend production tree, unpacked sum **53,783,631 bytes (51.29 MiB)**, 28 packages:

| Package | Unpacked size |
|---|---:|
| `pdfjs-dist@6.5.438` | 35.87 MiB |
| `react-dom@19.3.1` | 7.69 MiB |
| `pako@3.0.3` (via Mammoth) | 2.38 MiB |
| `mammoth@1.13.0` | 1.59 MiB |
| `underscore@1.13.8` (via Mammoth) | 0.87 MiB |
| `jszip@3.10.2` (via Mammoth) | 0.66 MiB |

API production tree, unpacked sum **20,345,999 bytes (19.40 MiB)**, 61 packages. Largest members: `drizzle-orm@0.45.4` 10.03 MiB, `fastify@5.12.8` 2.88 MiB, `ajv@8.20.0` 0.99 MiB, `pino@10.4.0` 0.67 MiB, `postgres@4.1.1` 0.30 MiB, `aws4fetch@1.0.20` 0.06 MiB.

Spelling candidate, not yet accepted: `nspell@2.1.5` plus `dictionary-en@4.0.0`, unpacked sum **622,389 bytes (0.59 MiB)**. Phase 5 still has to measure false positives on technical terms before this pair is installed.

Argon2 native binary for the production OS: `@node-rs/argon2-linux-x64-gnu@2.2.2`, **728,614 bytes (0.69 MiB)**. The Windows x64 binary is 0.58 MiB. The size gate must count the binary that production ships, not every platform package. `@node-rs/argon2@2.2.2` itself is 0.04 MiB and lists 13 platform packages as optional dependencies.

### 9.3 Provisional budget summary

| Group | Bytes |
|---|---:|
| Tracked source files | Measured in Phase 1 (no application source in Phase 0) |
| Frontend production tree (provisional) | 53,783,631 |
| API production tree (provisional) | 20,345,999 |
| Spelling candidate (provisional) | 622,389 |
| One Linux argon2 binary (provisional) | 728,614 |
| **Provisional dependency sum** | **75,480,633** |
| Limit (source + production dependencies) | 104,857,600 |
| Estimated headroom before source files | 29,376,967 (28.02 MiB) |

The proposed stack fits the 100 MiB budget under this provisional estimate, subject to verification against actual installed production dependencies and tracked source files in Phase 1, with these binding choices:

- Sign R2 requests with `aws4fetch`. The `@aws-sdk/client-s3@3.1167.0` tree measured **8.27 MiB** and is the heavier alternative.
- Use `postgres` (postgres.js) with Neon’s pooled connection string. The API design target is one long-running Node process. `@neondatabase/serverless` (0.42 MiB) stays out unless the API host cannot open a pooled TCP connection. Hosting is still an open decision, and a move to a serverless isolate would force a driver change.
- Use `@node-rs/argon2` prebuilds. The `argon2` package needs a native compile toolchain on the server.
- Keep TypeBox, Zod, Axios, React Router, Tailwind’s runtime, Playwright, and Vitest out of production dependencies. Fastify already depends on Ajv, so request validation uses Fastify JSON Schema. Tailwind and the test runners stay development dependencies.
- Keep PDF.js and Mammoth lazy-loaded. `react-dom`’s unpacked size includes development and profiling builds; those files are not stripped out of `node_modules` to pass the gate. The user-facing download size is the separate bundle metric.

`pdfjs-dist` is 34% of the whole budget. Phase 1 must list its largest internal files before the dependency is locked. If the package grows past the remaining headroom, the alternative is an owner-approved subset of the PDF.js distribution, or a different extractor. Security checks are not removed to save space.

Playwright browser downloads live in a cache outside this metric. They must remain development-only.

### 9.4 Largest packages in the estimate

These twenty are the largest members of the estimate above. Phase 1 replaces this list with the installed-tree report.

| Rank | Package | MiB |
|---:|---|---:|
| 1 | pdfjs-dist@6.5.438 | 35.87 |
| 2 | drizzle-orm@0.45.4 | 10.03 |
| 3 | react-dom@19.3.1 | 7.69 |
| 4 | fastify@5.12.8 | 2.88 |
| 5 | pako@3.0.3 | 2.38 |
| 6 | mammoth@1.13.0 | 1.59 |
| 7 | ajv@8.20.0 | 0.99 |
| 8 | underscore@1.13.8 | 0.87 |
| 9 | @node-rs/argon2-linux-x64-gnu@2.2.2 | 0.69 |
| 10 | pino@10.4.0 | 0.67 |
| 11 | jszip@3.10.2 | 0.66 |
| 12 | fast-json-stringify@7.3.5 | 0.56 |
| 13 | dictionary-en@4.0.0 | 0.55 |
| 14 | find-my-way@9.10.0 | 0.48 |
| 15 | @xmldom/xmldom@0.9.12 | 0.42 |
| 16 | event-target-shim@6.0.2 | 0.37 |
| 17 | ip-address@10.7.6 | 0.35 |
| 18 | fast-uri@4.2.3 | 0.32 |
| 19 | xmlbuilder@15.1.1 | 0.31 |
| 20 | postgres@4.1.1 | 0.30 |

## 10. Cost constraints

Version 1 avoids paid AI APIs, a vector database, a self-hosted model, a Python service, Redis, Elasticsearch, Kubernetes, and a document conversion server. Browser extraction is the primary parse. The API re-parses for authority, with a concurrency limit, so a popular file does not require a queue cluster.

No price, quota, or provider cost is assumed. Free tiers are treated as limited: Render free services sleep, Neon free databases have expiry and storage limits that must be read from the current Neon plan, and Cloudflare free allowances are not treated as unlimited production capacity.

## 11. Delivery phases

Each phase is a separate branch and pull request. This branch is `feature/architecture-and-rubric`.

| Phase | Branch | Outcome |
|---|---|---|
| 0 | `feature/architecture-and-rubric` | This design set |
| 1 | `feature/project-bootstrap` | pnpm workspace, web, API, health, CI, size gate |
| 2 | `feature/auth-and-database` | Drizzle schema, sessions, Free plan shell |
| 3 | `feature/resume-upload-and-parsing` | Upload, workers, verification, preview |
| 4 | `feature/rule-based-scoring` | Rules that are fully specified |
| 5 | `feature/grammar-and-spelling` | Dictionary size check, then grammar rules |
| 6 | `feature/evaluation-dashboard` | Score UI and history |
| 7 | `feature/retention-and-hardening` | Jobs, 90-day deletion, rate limits |
| 8 | `feature/pro-subscriptions` | Starts only after pricing, quotas, and a provider are approved |
| 9 | `feature/release-readiness` | Release checklist |

## 12. Phase 0 boundary

Phase 0 documents the system. It does not add a package manager workspace, a database migration, an endpoint, or a scoring function. Commands such as `pnpm test` do not exist yet and were not treated as successful.
