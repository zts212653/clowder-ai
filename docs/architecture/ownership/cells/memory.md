---
cell_id: memory
title: Memory / Evidence
summary: Evidence indexing、retrieval、scanner selection、bootstrap 与 library memory。
canonical_features: [F102, F152, F209]
code_anchors:
  - packages/api/src/domains/memory/interfaces.ts
  - packages/api/src/domains/memory/IndexBuilder.ts
  - packages/api/src/domains/memory/SqliteEvidenceStore.ts
  - packages/api/src/domains/memory/CatCafeScanner.ts
  - packages/api/src/domains/memory/GenericRepoScanner.ts
  - packages/api/src/domains/memory/ExpeditionBootstrapService.ts
  - packages/api/src/domains/memory/KnowledgeResolver.ts
doc_anchors:
  - docs/decisions/020-f102-memory-system-architecture.md
  - docs/features/F102-memory-adapter-refactor.md
  - docs/features/F152-expedition-memory.md
  - docs/features/F209-evidence-recall-optimization.md
static_scan_hints: [IEvidenceStore, IIndexBuilder, RepoScanner, EvidenceStore, IndexBuilder, Scanner, Memory, passage_vectors, entity_id, Perspective, searchEvidence, search_evidence]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F209, date: 2026-05-22, delta: "passage-level semantic recall, entity registry as retrieval anchors, typed evidence drill-down readers, and Perspective query-plan surface"}
  - {feature: F211, date: 2026-05-24, delta: "boundary note — F211 produces runtime session transcript/digest evidence; memory consumes and retrieves that evidence without owning runtime binding"}
---

# Memory / Evidence

## Canonical Owner

F102 owns the memory system contract: `IIndexBuilder`, `IEvidenceStore`, indexing, retrieval modes, local SQLite evidence, and resolver boundaries.

F152 extends that architecture by adding scanner strategies and bootstrap orchestration for non-Cat-Cafe repositories. New sources should extend the scanner/indexing contract instead of creating parallel stores.

F209 extends the evidence retrieval surface: passage-level semantic recall, entity registry / aliases as retrievable anchors, typed evidence drill-down readers, and Perspective live query plans. F209 `entity_id` is a memory/evidence doorway with provenance; it does not replace roster truth owned by `identity-agent` / F032.

F211 is an upstream evidence source for Antigravity/runtime sessions. The runtime session binding itself belongs to `identity-session`; once F211 materializes transcript/digest files, Memory / Evidence can index and retrieve them through the normal evidence path.

## Use This When

- Adding a new evidence source, scanner, retrieval mode, index state, bootstrap path, or memory UI/API backed by evidence search.
- Changing `IEvidenceStore.search()`, index rebuild behavior, collection/library search, semantic rerank, or provenance handling.
- Adding external-project memory support, repository scanners, or cold-start memory bootstrap behavior.
- Adding or changing passage-level vectors, entity aliases / mentions used for retrieval, typed drill-down hints, or Perspective query-plan execution.
- Indexing or retrieving materialized session transcripts/digests emitted by external runtime session registration.

## Extend By

- Implement or extend a scanner strategy such as `RepoScanner`, `CatCafeScanner`, or `GenericRepoScanner`.
- Keep storage changes behind `IEvidenceStore` and indexing changes behind `IIndexBuilder` / `IndexBuilder`.
- Add provenance and resolver behavior as structured fields rather than splitting evidence into a new store family.
- Use `KnowledgeResolver` / collection abstractions for cross-project or library search instead of bypassing evidence search.
- Treat entity registry records as evidence anchors with provenance and scope controls, not as an authority for who a cat is.
- Treat F211 runtime session output as evidence after transcript/digest materialization; do not reach back into live runtime binding state from memory indexing code.

## Do NOT Unify With

- Do not turn session transcript storage, invocation logs, or chat history into evidence store APIs just because they are searchable.
- Do not create a second `EvidenceStore`, `MemoryStore`, or bootstrap database for a new feature without explaining why F102/F152 contracts cannot express it.
- Do not mix private project data into global/library memory. Global methods can receive distilled methodology, not raw project content.
- Do not treat callback auth/session credentials as memory; those belong to `callback-auth` and `identity-session`.
- Do not let F209 `entity_id` / aliases override `cat-config.json`, roster, model, role, or reviewer eligibility truth.
- Do not let evidence indexing decide which Antigravity cascade/conversation is active. Active runtime binding and identity history belong to `identity-session`.

## Static Scan Hints

Watch for new or renamed `Store`, `EvidenceStore`, `MemoryStore`, `IndexBuilder`, `Scanner`, `RepoScanner`, `BootstrapService`, `Resolver`, `searchEvidence`, `search_evidence`, `passage_vectors`, `entity_id`, `entity registry`, `message window`, and `Perspective` code.
