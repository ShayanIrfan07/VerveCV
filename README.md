# VerveCV

Make every bullet count.

VerveCV is a multi-user resume evaluation product. Version 1 scores resumes with a deterministic, versioned rubric. It does not call a language model, an embeddings service, or an external grammar API.

Phase 0 records the architecture and the open scoring decisions. Phase 1 is the workspace shell: a Vite frontend, a Fastify API, and shared packages. Resume upload and scoring are not in this build.

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

`COOKIE_SECRET` must be at least 32 characters before the API process will start. Registration creates a Free subscription and does not start a session. Login sets HttpOnly cookies. Mutating `/api/v1` requests must send an `Origin` listed in `ALLOWED_ORIGINS`. The session lifetime defaults to 12 hours and remains an operational setting until it is approved.

## Documents

- [High-level design](docs/architecture/HLD.md)
- [Low-level design](docs/architecture/LLD.md)
- [Scoring rubric](docs/architecture/RUBRIC.md)
- [Security architecture](docs/architecture/SECURITY.md)
- [Open product decisions](docs/adr/0001-open-product-decisions.md)

Authoritative scores stay provisional until the open decisions that affect scoring are approved. A provisional result is not rescaled to 100.
