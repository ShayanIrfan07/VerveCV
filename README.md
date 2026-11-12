# VerveCV

Make every bullet count.

VerveCV is a multi-user resume evaluation product. Version 1 scores resumes with a deterministic, versioned rubric. It does not call a language model, an embeddings service, or an external grammar API.

Phase 0 records the architecture and the open scoring decisions. The app can register an account and preview a PDF or DOCX resume in the browser. The server verifies a stored file only after the operator sets the parse limits and a signed URL lifetime. Those numbers are not product rules yet. Scoring stays unavailable while the open rubric decisions are unresolved.

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

The browser dev server proxies `/api` to `http://localhost:3000`. A local preview uses PDF.js and Mammoth in a worker. Storing the file needs private R2 credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) and `SIGNED_URL_TTL_SECONDS`. Server-side parsing also needs `PDF_PAGE_CAP`, `DOCX_ENTRY_CAP`, `DOCX_UNCOMPRESSED_BYTES`, `PARSE_TIMEOUT_MS`, and `PARSE_CONCURRENCY`. Until those are set, the API leaves the upload pending and the preview stays a browser reading. The upload limit defaults to 5 MiB.

## Documents

- [High-level design](docs/architecture/HLD.md)
- [Low-level design](docs/architecture/LLD.md)
- [Scoring rubric](docs/architecture/RUBRIC.md)
- [Security architecture](docs/architecture/SECURITY.md)
- [Open product decisions](docs/adr/0001-open-product-decisions.md)

Authoritative scores stay provisional until the open decisions that affect scoring are approved. A provisional result is not rescaled to 100.
