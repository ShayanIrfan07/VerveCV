# VerveCV

Make every bullet count.

VerveCV is a multi-user resume evaluation product. Version 1 scores resumes with a deterministic, versioned rubric. It does not call a language model, an embeddings service, or an external grammar API.

The current repository state is Phase 0: architecture and rubric documentation. Application code is added later, one feature branch at a time.

## Documents

- [High-level design](docs/architecture/HLD.md)
- [Low-level design](docs/architecture/LLD.md)
- [Scoring rubric](docs/architecture/RUBRIC.md)
- [Security architecture](docs/architecture/SECURITY.md)
- [Open product decisions](docs/adr/0001-open-product-decisions.md)

Authoritative scores stay provisional until the open decisions that affect scoring are approved. A provisional result is not rescaled to 100.
