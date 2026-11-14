---
feature_ids: [F332]
related_features: [F335, F287, F200]
doc_kind: architecture
topics: [memory, matter, provenance, callback]
created: 2026-11-02
updated: 2026-11-07
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
provides three narrow entries: directory, source read and sourced mutation.
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

The directory contains bounded current pointers, eligible contextual hints and a continuation cursor. It is available to
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

## Contextual interpretation increment (2026-11-04)

The contextual interpretation increment adds presentation and discovery to the same authority.
It introduces no summary store, classification model, automatic read or new execution permission.

The opening and callback directory bind the authenticated invocation's thread. After projecting every
candidate through current source permissions, pages with an active unchanged source in that thread
come first; the remaining pages sort by updatedAt descending, then matterId ascending. The composite
cursor binds reader, owner, public-reply mode, thread, query and management mode. An older ordering's
cursor is rejected with the existing restart-from-directory response. Owner management uses the same
permission projection and the time/ID order without a thread preference.

An opening hint is the complete existing description, never an automatically shortened excerpt.
Only a page with a current-thread source can receive one. The o200k_base ordinary-text estimator
enforces **1024 tokens per description and 3072 tokens for the whole rendered directory**, including
instructions, metadata and continuation. Metadata is reserved first; a description that cannot fit
whole is omitted. If metadata itself fills the budget, the cursor continues after the last actually
displayed item. These are material budgets, not claims about provider billing or cached input cost.
“含本线程来源” describes source location only. Applicability still requires the full page, original
speech and current task; current user instructions retain precedence within their scope.

If an active original's revision changes, page/list responses carry summaryStatus=sources_changed.
The opening omits that unverified interpretation, and historical receipt expansion returns changed
even when the changed active source was outside the originally selected entry page. Unavailable
sources still withhold the entire page, including its title, description and entry count.

Reply expansion displays the exact validated receipt's description as “猫的归纳（非原话）”, with its
page revision, followed by original speech, speaker attribution and source links. Empty descriptions
have an explicit empty state. A changed or unavailable receipt never substitutes today's description
into an old reply; the existing complete-page link is the route to the current editable page.

## Indexed discovery increment (F332 W1, implementation pending)

The directory now takes bounded coordinate batches from the existing SQLite page table and an external-content
trigram index, then calls the same `project()` for every supporting source. Query matching keeps the existing
case-insensitive literal meaning, including short queries; page order and visible-item cursors retain their contract.
A second current-source check precedes publication. No index hit records an explicit read.

After 1,000 inspected candidates without a full page, continuation represents unfinished discovery, including when
no item is visible yet. Scan progress is encrypted and bound to the original reader/query/cursor; it exposes neither
hidden page coordinates nor their count. This transient progress token requires restarting directory discovery after
an API restart; ordinary cursors after visible items remain restart-stable. It is a rebuildable read view, not a TTL
on user pages, sources or receipts. Opening/watcher consumers continue using the returned cursor and their original
material budgets; they do not gain action authority or a second directory cache.

SQLite V79 installs the indexes and insert/update/delete triggers in one transaction. Editing or forgetting a page
updates the search tokens in that same canonical write; the index has no second text payload or vector store.
Rebuilding evidence does not delete canonical pages, source associations or forget fences. Reverting W1 code leaves
these additive indexes harmless; production loading/migration still requires its original operational authorization.
