# VerveCV

Make every bullet count.

VerveCV is a multi-user, rule-based resume evaluator, not an AI-assisted platform. Version 1 is fully rule-based and evaluates PDF and DOCX resumes against a deterministic, versioned 100-point rubric, with no retrieval-augmented generation (RAG), large language model (LLM), embeddings service, or external AI or grammar API.

The current repository state is Phase 0: architecture and rubric documentation. Application code is added later, one feature branch at a time.

## Documents

- [High-level design](docs/architecture/HLD.md)
- [Low-level design](docs/architecture/LLD.md)
- [Scoring rubric](docs/architecture/RUBRIC.md)
- [Security architecture](docs/architecture/SECURITY.md)
- [Open product decisions](docs/adr/0001-open-product-decisions.md)

Authoritative scores stay provisional until the open decisions that affect scoring are approved. A provisional result is not rescaled to 100.
