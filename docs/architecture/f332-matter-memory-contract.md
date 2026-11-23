---
feature_ids: [F332]
related_features: [F335, F287, F200]
doc_kind: architecture
topics: [memory, matter, provenance, callback]
created: 2026-11-02
updated: 2026-11-16
owner: codex-astra
description: "Canonical matter summaries with return pointers, optional exact quotations and honest explicit-read receipts."
description_source: model
description_author: codex61-sol
description_updated_at: 2026-11-16T12:22:00Z
description_generated_by: codex61-sol@gpt-6.1-sol
description_generated_at: 2026-11-16T12:22:00Z
description_confirmed_by: codex61-sol
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f332-matter-memory-contract.md"
mcp_admission_claims:
  - {ref: "file:docs/architecture/f332-matter-memory-contract.md", toolName: cat_cafe_list_memory_matters, resourceFamily: memory-matter, boundaryKind: resource-entry, decision: accepted}
  - {ref: "file:docs/architecture/f332-matter-memory-contract.md", toolName: cat_cafe_read_memory_matter, resourceFamily: memory-matter, boundaryKind: resource-entry, decision: accepted}
  - {ref: "file:docs/architecture/f332-matter-memory-contract.md", toolName: cat_cafe_write_memory_matter, resourceFamily: memory-matter, boundaryKind: resource-entry, decision: accepted}
---

# F332 2c matter memory contract

## Current writing contract (2026-11-16)

The accepted lightweight increment (internal)
supersedes mandatory exact-selection admission below. `remember(target=matter)` accepts
`operation=create,title,summary`; append/correct take the same summary plus their existing page/revision/entry IDs.
Sources are optional `{threadId,messageId?}` return addresses. Exact selections remain an optional,
backwards-compatible branch, including original author/quoted-speaker checks.

Without sources, the authenticated callback supplies the actual invocation thread and
originTriggerMessageId/a2aTriggerMessageId. The original source projection confirms the message;
without a currently readable, published source it retains the real thread alone. It never picks the
last human message or makes a system/cat trigger human-authored. This return address records where
the summary happened, not proof of verified verbatim speech. Author fields are not model inputs.
An authoritative whisper trigger also creates a server-owned page access dependency, even when the
writer explicitly chooses a public thread/message/quotation as the return address. Every projection
rechecks that trigger through the original message reader, including public-reply exclusion, recall,
deletion and current visibility. This internal dependency is not a fabricated source pointer and is
never accepted from model input. It also applies to page-title/description writes from that trigger.

`summaryAuthor` records the author of the summary content. New/create and append entries credit the
authenticated writer. A correction with unchanged summary preserves the previous content author,
including historical unknown; rewriting that summary credits the correcting writer. The fixed write
receipt's separate `writer` records the actual operator even when no summary text changed.
`descriptionAuthor` similarly belongs to the page context text, not a title/source edit's operator.

One content normalization supplies both source admission and persistence. An initial summary fills
empty page context. The accepted description-only create alias (no summary or sources) supplies the
entry and page context together. Both cases link that context to their first actual entry ID.
An explicit description alongside a summary or quotation remains independent, even when the text
matches. Correcting/retiring the linked entry updates/removes its context; another source's entry
does not. Source-only correction advances the link without rewriting context, whitespace or author.
Changing page context explicitly detaches the relationship; title-only edits preserve it. No relation
or historical author is reconstructed from equal text or original-message speakers.

Entry identity is distinct from current-content deduplication. `entryId` identifies one occurrence;
the private `source_key` fingerprints its admitted source, summary and content author while active.
Superseding/retiring an entry releases that content slot into an entry-specific `history:` key in
the same transaction. Its source, content, author, ID and replacement chain stay intact. A validated
new correction may return A→B→A by creating a new occurrence of A; it never reactivates the old A.
A new explicit append can likewise repeat inactive content, while duplicate active inputs still
deduplicate and a correction into another active equal entry reuses that active occurrence.
Old inactive digest keys are released only on an actual write collision, without a batch rewrite
or schema rebuild. Exact request retries return their original receipts without changing any entry;
forget fences still suppress every old request. A genuinely unchanged correction is rejected with
`unchanged_entry`, without asking for quotation coordinates.
The existing immediate SQLite transaction owns replacement, key release, page revision and fixed
receipt together; a failed receipt insert rolls all of them back. No new schema/index, reader or
process is introduced. A legacy inactive-key collision adds one keyed update; ordinary history uses
the existing status update and one new occurrence, with no batch migration of old pages.
Memory details, write cards and response-source expansion distinguish summary, optional quotation,
original speaker and return address. Directory hints carry the summary's author and call provenance
an occurrence/source location, not applicability, a quotation, or execution authority.

Message pointers carry M1's existing ReadRef. Its contentRevision is the original reader's version;
the separately stored raw message snapshot detects changes without claiming sentence-level proof.
Thread-only entries have no message ID, selection or message revision. The unified envelope exposes
sourceThreads for the existing get_thread_context/keyword path; no parallel reader is added.
Summary reads record entryRevision in the existing F287 ledger, not sourceRevision evidence for
linked originals. Legacy returned quotations retain sourceRevision. Reply-source counts distinguish
summaries and actually returned excerpts; neither implies adoption.

SQLite V84 adds nullable summary/author/seed-entry/access-dependency columns and admits the content-free entryRevision receipt
variant. Old pages and source JSON are not backfilled or rewritten. Permission rechecks, TTL=0,
page revisions, request fingerprints and forget fences remain authoritative. The remember forwarder
already generates stable item request IDs; its model schema now reflects that optional field.
See verification and rollback boundaries (internal).

For optional exact quotations only, authorized invalid_source responses identify content block/segment,
attachment, range or text mismatch with a corrective hint. Permission failures remain the same opaque
not_available response. Ordinary summaries never enter the quotation-selection path.

### Write-card receipts

The original `memory_matter_requests.result_json` stores the immutable, server-built write snapshot
in the same transaction as the mutation. It records the operation, resulting page revision, actual
new/replaced/retired entries and changed title/description. No extra store, table or source reader is
introduced. Exact retries return the same content-free `writeRef`; group messages retain only this
reference, not copied private text. The owner-only write-receipt read first projects the full page
through current source/access dependencies, then returns that fixed write. Later page edits cannot
replace earlier card content. Changed source text removes its no-longer-verified excerpt and adds a
current validity warning without substituting the newer original. A receipt read is not a cat source
read or adoption event.

The card shows the action and write revision; description edits display the changed line range.
It links to the current editable page separately. Historical cards without a saved write are explicitly
labelled as a current-page preview. Failed submissions use a submission-result heading and never a
saved-content claim. Forgetting atomically removes all content snapshots from old request receipts,
while retaining the existing content-free retry fences. Missing/unauthorized/forgotten pages do not
resurrect text from message metadata or snapshots.

## Original quotation contract and retained boundaries

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

Cats reach the directory through the find entry's matters group ([find entry](memory/find-entry.md)); the separate `cat_cafe_list_memory_matters` name retired on 2026-11-16 with the route and service unchanged. The directory contains bounded current pointers, eligible contextual hints and a continuation cursor. It is available to
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
