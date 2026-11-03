---
feature_ids: [F332]
related_features: [F335, F287, F200]
doc_kind: architecture
topics: [memory, matter, provenance, callback]
created: 2026-11-02
updated: 2026-11-02
owner: codex-astra
description: "Canonical matter pages, exact-source access and explicit-read receipts shared by opening recall and watcher consumers."
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f332-matter-memory-contract.md"
mcp_admission_claims:
  - {ref: "file:docs/architecture/f332-matter-memory-contract.md", toolName: cat_cafe_list_memory_matters, resourceFamily: memory-matter, boundaryKind: resource-entry, decision: accepted}
  - {ref: "file:docs/architecture/f332-matter-memory-contract.md", toolName: cat_cafe_read_memory_matter, resourceFamily: memory-matter, boundaryKind: resource-entry, decision: accepted}
  - {ref: "file:docs/architecture/f332-matter-memory-contract.md", toolName: cat_cafe_write_memory_matter, resourceFamily: memory-matter, boundaryKind: resource-entry, decision: accepted}
---

# F332 2c matter memory contract

The accepted implementation plan (internal)
provides three narrow entries: directory, source read and sourced mutation. You's approved
`proposal_mvzfn9dflf04d23i`, the original Task `private-source-id`, and
Sol6.1's design verdict `private-source-id` are the scope and design anchors.
This admission records those entries; it does not approve production writes, enable F335's watcher,
or substitute for implementation review.

Architecture cell: memory. MatterMemoryService is the only permission projection used by owner UI,
callback tools, opening directories and historical read receipts. MatterMemoryStore writes canonical
matter, source, exact-retry and forget-fence tables in the existing memory SQLite database/queue.
They have no TTL and no dependence on rebuildable evidence rows. Message and thread stores remain
the original source authorities. Source selections address raw body, quote comment or quoted text,
with complete block/attachment coordinates and revisions; quoting someone does not make the outer
speaker the quoted author.

All page metadata is withheld unless every source supporting that page is currently readable by
the authenticated consumer. Retired/superseded entries still participate in that check. Owner
management can retire or forget an unavailable page through a content-free placeholder. Forgetting
removes page/source associations and retains content-free retry suppression; it never deletes the
original messages. Writes use expectedRevision and exact requestId retries.

The directory contains only bounded current pointers and a continuation cursor. It is available to
cold, resumed and reconstructed provider requests, and does not record a read. Cat-selected reads
of nonempty original text append an atomic presented/drilled pair to the existing F287 ledger;
records contain no source text, title or description. The matter resolver has explicit-read admission,
not an automatic opportunity producer. No applied outcome is inferred. Pagination unions are a
projection of immutable records scoped to owner/thread/invocation/cat/page revision.

Owner history and reply expansion recheck both current permissions and the versions actually read.
A changed source/page is marked changed without substituting its newer text into an older receipt.
Public reply projections additionally reject whisper source material. F200's private-hit and adoption
protections remain in force. Owner page views, directory results, empty reads and failed reads do not
produce cat read receipts.

The read and list tools are read-only in MCP's external-resource sense; read's description declares
its content-free telemetry side effect. Mutation is owner-private and callback-bound. Owner-only
forgetting is not exposed through the model's write schema. None of these tools grants task authority
or writes profile, person or taste facts.
