# VerveCV security architecture

Status: Phase 0 design. Controls described here are requirements for later phases. They are not implemented on this branch.
Date: 2026-11-12
Related: [HLD](HLD.md), [LLD](LLD.md), [ADR 0001](../adr/0001-open-product-decisions.md)

## 1. Assets

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Password | `users.password_hash` only | Secret |
| Refresh token | Hash in `sessions` | Secret |
| Resume bytes | Private R2 object | Personal data |
| Extracted text, findings, contact fields | PostgreSQL, deleted with the version | Personal data |
| Session cookie | Browser, HttpOnly | Credential |
| R2 credentials and database URL | API environment | Secret |

The browser bundle receives no API secret, no database URL, and no R2 secret. Signed URLs are the only storage capability the browser gets, and they are short-lived and scoped to one object and one method.

## 2. Trust boundaries

```text
Browser  --untrusted JSON and files-->  Fastify  --SQL-->  Neon
   |                                      |
   +-- direct PUT/GET with signed URL --> R2
```

Anything the browser computes is untrusted: extracted JSON, preview scores, claimed MIME types, claimed lengths, and entitlement claims. The official score is computed on the server from the object in R2.

A second user’s identifier in a URL is an insecure direct object reference. Every resume, version, evaluation, job, ignored term, and download URL is filtered by the authenticated user id. A cross-user id returns 404, so the response does not confirm that the row exists.

## 3. Authentication

| Control | Requirement |
|---|---|
| Password hash | Argon2id via `@node-rs/argon2` |
| Password storage | Hash only |
| Session cookie | `HttpOnly`, `Secure`, `SameSite=Lax`, narrow `Path` |
| Token placement | Cookies only; not `localStorage` or `sessionStorage` |
| Refresh | Rotate on use; store the new hash; keep `rotated_from_id` |
| Reuse detection | Presentation of a rotated refresh token revokes the token family |
| Logout | Revokes the caller’s session and its rotated refresh-token lineage (`rotated_from_id` family) without revoking unrelated device sessions; logout-all-devices is a separate account-wide revocation (`WHERE user_id = $1`) |
| Email | Stored normalized and unique |

Argon2id parameters must meet the OWASP Password Storage Cheat Sheet that is current when Phase 2 is implemented. This document does not freeze a memory or iteration number ahead of that check.

Cookie and refresh lifetimes are not specified by the product brief. They stay unset until an approved value is recorded (ADR 0001, additional item A7). Phase 2 should not ship a lifetime and describe it as a product decision.

Email verification is an open product decision. `email_verified_at` remains null until a method is approved. Whether an unverified account may upload or evaluate is part of that decision.

## 4. CSRF, CORS, and cookies

Mutating requests use cookie authentication, so cross-site request forgery is in scope.

- CORS allows credentialed requests only from an explicit origin list. The allowed origin is never `*`.
- A mutating request must present an allowed `Origin`.
- A CSRF token (double-submit) is required for cookie-authenticated mutations if the Origin check is not sufficient for a given host. Phase 2 tests both the Origin check and a cross-site form post.
- `GET` requests do not change state.

## 5. Authorization and entitlements

Protected routes require a live session. Ownership is checked in the query, not only in the handler after a fetch.

Free is the only plan Phase 2 may assign. Pro is not granted by a request field. After a provider is approved, Pro changes only inside the verified webhook handler, and the webhook is idempotent.

Quota reservation and evaluation-job insert share one transaction so concurrent requests cannot both pass a limit. The limit numbers themselves are not approved. Until they are, the code must not invent a quota. The temporary behavior is an open decision, not an implicit “unlimited” promise.

## 6. Upload and parser threats

| Threat | Control |
|---|---|
| Oversized upload | 5 MiB default, 413, checked again on the stored object |
| Disguised file | Extension, MIME type, and magic bytes must agree |
| Legacy DOC | 415, no conversion |
| ZIP bomb | Entry-count cap and uncompressed-size cap during DOCX inspection |
| PDF bomb / huge page count | Page-count cap and parse timeout |
| Password-protected file | 422, no password cracking and no password collection in Version 1 |
| Corrupt file | 422, no score |
| Image-only PDF | 422 when no text is extracted; OCR is out of scope |
| HTML in DOCX conversion | Sanitize before render |
| Polyglot or extra ZIP entries | Ignore unexpected entries; do not follow external relationships |
| Parser crash | Worker timeout and a process-wide concurrency limit |

The numeric caps for pages, ZIP entries, uncompressed bytes, timeout, and concurrency are required and not yet chosen. They are operational security settings (ADR 0001, additional item A7).

Server-side parsing does not run unbounded on the request thread. It runs under the job lease with a concurrency limit.

## 7. Object storage

- The bucket is private. There is no public resume URL.
- Keys are random. They do not contain the email, the name, or the original filename.
- Upload URLs are `PUT` for one key. Download URLs are `GET` for one key.
- Both expire. The TTL is an approved setting still to be chosen.
- The API checks that the completed object’s size and hash match the intent before scoring.
- A signed URL for user A is not derivable by user B.

## 8. Retention

Each resume version has `expires_at` 90 days after creation. A retention task deletes the R2 object, extracted content, preview data, findings, and other personal evaluation fields for that version. The task is safe to retry. Audit events record the event type and the target id, not the file contents.

User-requested delete uses the same task path and may run before day 90.

Neon point-in-time recovery and R2 noncurrent-object retention can keep bytes after the application delete. The product copy must say that application-level deletion is within 90 days, and it must describe provider backup retention only after those provider settings are known. Decision 13 and additional item A8 cover that disclosure.

## 9. Logging and privacy

Pino redacts authorization headers, cookies, password fields, tokens, signed URLs, and request bodies on upload and evaluation routes. Logs do not include resume text, email addresses, phone numbers, or LinkedIn URLs.

Error responses use the stable error envelope and a request id. Internal exception text is not returned to the client. Parser failures use a generic unsupported-or-unreadable message plus an error code.

## 10. Browser headers

Phase 7 sets a content security policy that does not allow the Lottie CDN cited in the product PDF, or any other unexpected third-party script. The confetti animation, if approved, is a local reduced-motion-aware effect.

Other headers to set on the API and the frontend host: `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a frame policy that prevents the app from being embedded for clickjacking. Exact CSP source lists are written when the real asset hosts exist.

## 11. Supply chain and runtime

- One lockfile, pnpm, production install measured by `scripts/check-size.mjs` in Phase 1.
- The size gate counts the production platform binary once. It does not omit `pdfjs-dist` or the password hasher to pass.
- Development tools (TypeScript, Vite, Tailwind, Vitest, Playwright, Drizzle Kit) are not production dependencies.
- Dependency review happens on the pull request that adds a package.
- The API runtime target is Node.js 26 Active LTS, currently 26.13.1 as of the 2026-11-11 security release. The workstation copy v24.18.0 is behind the 24.x security release 24.22.3. CI should not standardize on the workstation’s current patch.

## 12. Tests required before these controls are called done

Phase 2 and later, not this branch:

- Register, login, logout, refresh rotation, and reuse revocation.
- Cross-user reads and deletes for resumes, versions, evaluations, view URLs, and ignored terms.
- Rejected client-supplied score field.
- Upload cases: oversize, wrong magic, DOC, corrupt PDF, corrupt DOCX, password-protected PDF, image-only PDF, and a DOCX that expands past the cap.
- Quota reservation under concurrent requests, once a quota exists.
- Retention retry after a simulated R2 failure, without sensitive audit payloads.
- Webhook signature and replay tests, only after a provider is approved.

## 13. Phase 0 verification

No authentication code, bucket, or database exists yet. This document was reviewed against the implementation brief and the source PDF. It was not executed.
