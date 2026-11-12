# VerveCV

Make every bullet count.

VerveCV is a multi-user, rule-based resume evaluator, not an AI-assisted platform. Version 1 is fully rule-based and evaluates PDF and DOCX resumes against a deterministic, versioned 100-point rubric, with no retrieval-augmented generation (RAG), large language model (LLM), embeddings service, or external AI or grammar API.

Phase 0 records the architecture and the open scoring decisions. Phase 1 is the workspace shell: a Vite frontend, a Fastify API, and shared packages. Phase 2 adds PostgreSQL migrations and cookie-based authentication. Resume upload and scoring are not in this build.

## Development

Node.js 22 or newer runs locally. Continuous integration uses Node.js 26, the current Active LTS. pnpm is invoked through Corepack because a global `pnpm` shim may require an administrator install.

```bash
corepack pnpm install
corepack pnpm dev:api
corepack pnpm dev:web
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm size:check
```

The API listens on `0.0.0.0:$PORT` (`PORT` defaults to 3000). `GET /api/v1/health/live` reports that the process is up. `GET /api/v1/health/ready` checks the database when `DATABASE_URL` is set.

`COOKIE_SECRET` must be at least 32 characters before the API process will start. Registration creates a Free subscription and does not start a session. Login sets signed `HttpOnly`, `SameSite=Lax` session and refresh cookies (`Secure` when `NODE_ENV=production`). Mutating `/api/v1` requests must send an `Origin` listed in `ALLOWED_ORIGINS`.

### Session invalidation vs. logout-all-devices

- **`POST /api/v1/auth/logout` (single-device logout)**: Revokes the caller's current session and its entire refresh-token rotation lineage (ancestors and descendants created by token rotation on that device/client) inside a database transaction, and clears the browser cookies. Independent login sessions on other devices keep their own root session IDs and remain active.
- **Logout-all-devices (not exposed as a separate endpoint in Phase 2)**: Would revoke every active `sessions` row for `user_id` across all login roots/devices (for example upon password reset or explicit account-wide sign-out in a later phase).

### Operational defaults pending ADR 0001 approval

Session lifetime (`SESSION_TTL_SECONDS`, default 12 hours) and authentication rate limits (`AUTH_RATE_LIMIT_WINDOW_SECONDS`, `AUTH_RATE_LIMIT_REGISTER_MAX`, `AUTH_RATE_LIMIT_LOGIN_IP_MAX`, `AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX`, `AUTH_RATE_LIMIT_REFRESH_MAX`) are configurable operational protections until ADR 0001 item A7 records owner-approved product values.

## Documents

- [High-level design](docs/architecture/HLD.md)
- [Low-level design](docs/architecture/LLD.md)
- [Scoring rubric](docs/architecture/RUBRIC.md)
- [Security architecture](docs/architecture/SECURITY.md)
- [Open product decisions](docs/adr/0001-open-product-decisions.md)

Authoritative scores stay provisional until the open decisions that affect scoring are approved. A provisional result is not rescaled to 100.
