# VerveCV

Make every bullet count.

VerveCV is a multi-user, rule-based resume evaluator, not an AI-assisted platform. Version 1 is fully rule-based and evaluates PDF and DOCX resumes against a deterministic, versioned 100-point rubric, with no retrieval-augmented generation (RAG), large language model (LLM), embeddings service, or external AI or grammar API.

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

The API listens on `0.0.0.0:$PORT` (`PORT` defaults to 3000). `GET /api/v1/health/live` reports that the process is up. `GET /api/v1/health/ready` stays unavailable until the database check exists.

## Documents

- [High-level design](docs/architecture/HLD.md)
- [Low-level design](docs/architecture/LLD.md)
- [Scoring rubric](docs/architecture/RUBRIC.md)
- [Security architecture](docs/architecture/SECURITY.md)
- [Open product decisions](docs/adr/0001-open-product-decisions.md)

Authoritative scores stay provisional until the open decisions that affect scoring are approved. A provisional result is not rescaled to 100.
