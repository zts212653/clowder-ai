---
cell_id: memory
title: Memory / Evidence
summary: Evidence indexing、retrieval、scanner selection、bootstrap 与 library memory。
canonical_features: [F102, F152]
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
static_scan_hints: [IEvidenceStore, IIndexBuilder, RepoScanner, EvidenceStore, IndexBuilder, Scanner, Memory]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
---

# Memory / Evidence

## Canonical Owner

F102 owns the memory system contract: `IIndexBuilder`, `IEvidenceStore`, indexing, retrieval modes, local SQLite evidence, and resolver boundaries.

F152 extends that architecture by adding scanner strategies and bootstrap orchestration for non-Cat-Cafe repositories. New sources should extend the scanner/indexing contract instead of creating parallel stores.

## Use This When

- Adding a new evidence source, scanner, retrieval mode, index state, bootstrap path, or memory UI/API backed by evidence search.
- Changing `IEvidenceStore.search()`, index rebuild behavior, collection/library search, semantic rerank, or provenance handling.
- Adding external-project memory support, repository scanners, or cold-start memory bootstrap behavior.

## Extend By

- Implement or extend a scanner strategy such as `RepoScanner`, `CatCafeScanner`, or `GenericRepoScanner`.
- Keep storage changes behind `IEvidenceStore` and indexing changes behind `IIndexBuilder` / `IndexBuilder`.
- Add provenance and resolver behavior as structured fields rather than splitting evidence into a new store family.
- Use `KnowledgeResolver` / collection abstractions for cross-project or library search instead of bypassing evidence search.

## Do NOT Unify With

- Do not turn session transcript storage, invocation logs, or chat history into evidence store APIs just because they are searchable.
- Do not create a second `EvidenceStore`, `MemoryStore`, or bootstrap database for a new feature without explaining why F102/F152 contracts cannot express it.
- Do not mix private project data into global/library memory. Global methods can receive distilled methodology, not raw project content.
- Do not treat callback auth/session credentials as memory; those belong to `callback-auth` and `identity-session`.

## Static Scan Hints

Watch for new or renamed `Store`, `EvidenceStore`, `MemoryStore`, `IndexBuilder`, `Scanner`, `RepoScanner`, `BootstrapService`, `Resolver`, `searchEvidence`, and `search_evidence` code.
