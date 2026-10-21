---
cell_id: collaborative-content-plane
title: Collaborative Content Plane
summary: Versioned cross-media anchors, owner-authorized human-edit awareness, replayable receipts, race-safe Agent patch settlement, honest remap/orphan semantics, and adapter receipts without owning canonical content or policy.
description: "跨媒介选区、owner 授权的人类编辑感知、可重放回执、竞态安全的 Agent patch settlement 与诚实 remap/orphan 的架构归属，不接管 canonical 内容或 policy。"
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-28T01:32:24Z
description_confirmed_by: codex-sol
description_updated_at: 2026-09-13T20:42:00Z
doc_kind: architecture
created: 2026-08-27
canonical_features: [F309]
code_anchors:
  - packages/api/src/domains/cats/services/cloud-bridge/dot/DotImageService.ts
  - packages/api/src/routes/chatgpt-dot-image-routes.ts
  - packages/api/src/domains/collaborative-content/runtime-composition.ts
  - packages/api/src/domains/collaborative-content/collective-artifact/markdown-owner.ts
  - packages/api/src/domains/collaborative-content/collective-artifact/markdown-reviews.ts
  - packages/api/src/domains/collaborative-content/collective-artifact/markdown-modifications.ts
  - packages/api/src/domains/collaborative-content/collective-artifact/published-media-owner.ts
  - packages/api/src/domains/collaborative-content/collective-artifact/media-reviews.ts
  - packages/api/src/domains/collaborative-content/collective-artifact/custody-transfer-owner.ts
  - packages/api/src/domains/collaborative-content/workspace-editor-service.ts
  - packages/api/src/domains/collaborative-content/editor-session-service.ts
  - packages/api/src/domains/collaborative-content/patch-service.ts
  - packages/api/src/domains/collaborative-content/semantic-operation-store.ts
  - packages/api/src/domains/collaborative-content/named-cat-content-service.ts
  - packages/api/src/domains/collaborative-content/modification/composition.ts
  - packages/api/src/domains/collaborative-content/modification/journal.ts
  - packages/api/src/domains/collaborative-content/modification/message-takeover.ts
  - packages/api/src/domains/collaborative-content/modification/chat-projection.ts
  - packages/api/src/domains/collaborative-content/modification/request-authority.ts
  - packages/api/src/domains/collaborative-content/modification/result-service.ts
  - packages/api/src/domains/collaborative-content/modification/control/runtime-control-service.ts
  - packages/api/src/domains/collaborative-content/workspace-review/service.ts
  - packages/api/src/domains/collaborative-content/artifact-review/version-response-service.ts
  - packages/api/src/domains/collaborative-content/works/service.ts
  - packages/api/src/domains/collaborative-content/works/review-response.ts
  - packages/api/src/domains/collaborative-content/works/version-store.ts
  - packages/api/src/domains/collaborative-content/works/context-store.ts
  - packages/api/src/routes/living-work-routes.ts
  - packages/api/src/routes/content-modification-routes.ts
  - packages/api/src/routes/callback-content-modification-routes.ts
  - packages/api/src/routes/callback-content-editor-routes.ts
  - packages/api/src/domains/video-studio/content-owner/service.ts
  - packages/api/src/domains/video-studio/content-owner/state/manifest.ts
  - packages/api/src/domains/video-studio/project/service.ts
  - packages/api/src/domains/collaborative-content/workspace-review/video-project-review-service.ts
  - packages/mcp-server/src/tools/content-editor-tools.ts
  - packages/mcp-server/src/tools/content-modification-tools.ts
  - packages/mcp-server/src/tools/work-tools.ts
  - packages/web/src/components/workbench/content-review/VideoWorkReview.tsx
  - packages/web/src/components/workbench/content-review/ContentReviewSurface.tsx
  - packages/web/src/components/content-review/ContentModificationPanel.tsx
  - packages/web/src/components/workbench/content-editor/ContentEditorOwnerSurface.tsx
doc_anchors:
  - docs/features/F309-collaborative-content-plane.md
  - project-research/2026-08-27-f309-collaborative-content-plane/README.md
  - docs/features/F290-ai-native-collective.md
  - docs/features/F307-composable-workbench.md
  - docs/features/F063-hub-workspace-explorer.md
  - docs/features/F138-video-studio.md
  - docs/features/F326-editing-desk.md
  - feature-specs/2026-10-07-f326-phase-a-contract.md
  - feature-specs/2026-10-20-f326-phase-c-real-films.md
  - docs/architecture/f309-living-work-entry-contract.md
static_scan_hints: [SelectionAnchor, AuthorizationDecisionRef, AnnotationThread, PatchProposal, Disposition, ContentChangeReceipt, receiptId, causal checkpoint, replay, PresenceProjection, change awareness, proposal state CAS, applyReceipt, coordinate space, timebase, table range, reanchor, orphaned, content adapter]
cited_by:
  - {feature: F247, date: 2026-10-10, delta: dot G1 source-bound Events and private original image consumer}
  - {feature: F309, date: 2026-08-27, delta: new cell — extract cross-media collaboration mechanics from F290 and keep F307/content-owner boundaries explicit}
  - {feature: F309, date: 2026-09-06, delta: DOCX owner session and independent authenticated cat operation vertical; materialization stays F202-owned and canonical bytes/receipts stay F138-owned}
  - {feature: F309, date: 2026-09-13, delta: record the missing two-Human canonical Markdown slice for F290 W4 and keep bytes/auth in the content owner, lifecycle in F309, and mount in F307}
  - {feature: F309, date: 2026-09-20, delta: "Phase U — shared landing and canonical discussion, explicit request saga, file candidate decisions, and native control receipts; no second file/media/Task/Queue owner"}
  - {feature: F309, date: 2026-10-02, delta: "Studio K1/K2 — revision-bound Cat ContextAttachments enter through Hub action transport; F309 derives one request from the current Human message and projects immutable Host receipts; F063 remains source/writeback owner and Queue only carries verified conflict/unknown continuation"}
  - {feature: F326, date: 2026-10-07, delta: "Phase A consumer — F138 owns immutable project scope and JSON/CAS/receipts; F309 extends the shared artifact ledger with project targets and append-only history; renderer stays external"}
  - {feature: F326, date: 2026-10-20, delta: "Phase C consumer — shared Work create/explicit submit/fixed references use the F138 owner; version annotations, source/story/material references and original review response projection stay in the existing F309 database; F232/F307 only discover and mount"}
  - {feature: F290, date: 2026-10-17, delta: "W4 branch adapts the same retained Markdown/media owners and review ledger to exact Collective scopes; version-bound proposals, Human dispositions and recovery preserve canonical receipts. Not yet merged or accepted."}
---

# Collaborative Content Plane

## Canonical Owner

F309 owns the cross-media collaboration metadata and mechanics shared by content surfaces: versioned
`SelectionAnchor` envelopes, anchor revisions and resolution outcomes, durable annotation threads,
`PatchProposal` review/disposition lifecycle, proposal-state settlement, authenticated/replayable change receipts,
provenance, owner-returned mutation/undo receipts, and the bounded projection that lets cats understand which
human edit transaction changed which version/targets.

F309 may persist those user-visible collaboration records with TTL=0. It does not persist a second copy of
the underlying document, media project, editor-native collaboration state, or content version. Each content
owner remains authoritative for bytes/schema/version, raw editor transactions, final action authorization,
apply/invert semantics, and its own Yjs, Office server, media, canvas, or file store. F309 stores only auditable,
content-free authorization decision refs; it does not own policy/grants or continue projecting cached content
after revocation. F309 may define a minimal ephemeral presence projection, but it does not turn native cursors
or keystrokes into durable content truth.

F307 mounts content-owner surfaces and owns only working-set/layout/focus/restore. F290 supplies Collective
Artifact lineage, domain permission context and result targets; content owner remains the final action authority
and signs the only action decision after consuming both constraints. A deny/expiry from either content policy
or verifiable F290 domain context fails closed; neither side can override the other's deny. Agent
attention/runtime decides whether an authorized bounded change notice enters model context; F309 does not own
invocation. F063/F138 and future Office, image, canvas and table owners
implement the authorization/content adapter ports.

F326 C consumes the same owner through the common Work entry. F138 manifests retain the only content
revision/head, immutable bytes, publication scope and settlement receipts. F309's version annotations and
versioned video context reference those exact revisions; neither metadata table chooses a head or stores a
second film. Optional responses reserve the existing review and project the same owner receipt into Work
annotations and original review completion in the existing SQLite transaction. Source bindings do not grant
access. F063 retains original-file authority; F232 and F307 discover and mount the Work instead of treating
an internal video-project as a second public identity. HTML body/sandbox admission remains format-owned.

This boundary also governs F290 W4 shared Markdown. F290 authenticates Collective Humans and supplies fresh
membership/visibility context, but does not store Markdown bytes. A canonical Markdown content owner holds the
same `contentRef`, bytes, opaque owner version, mutation/undo receipts and final action authorization. F309 owns
the read/annotation/proposal/disposition/version lifecycle around that owner; F307 only mounts the owner surface.
The W4 branch adapts the same retained content owner, workspace review store and modification journal to an
owner-admitted Collective scope. The Service authenticates independent Humans and revalidates exact public source,
membership, resource action, version and custody generation; the owner can still deny every read or effect. Human
proposal adoption serializes proposal state and owner version, then returns the canonical receipt. The original
private Host routes keep their own `ownerUserId` fence. This branch evidence does not claim a shipped or accepted
path; F063 Markdown remains owner-local worktree SHA CAS, and no public Office editor is added.

Retained PNG/MP4 use the original F138 media owner and this same review ledger through a distinct source kind.
Only read, history and annotation actions are admitted. Current versions accept new anchors; retained historical
versions are read-only with fresh-authorized replies. F307 mounts the existing review canvas/comments through a
versioned public reference; metadata stays on the authenticated Collective transport and bytes use the local Host
session proxy. No private owner identity, token or source locator crosses the iframe boundary.

## Phase U request and result boundaries

The common landing consumes typed file, publication, legacy Task and F311 source adapters. F063 owns the
mutable file and its SHA-CAS writeback; F138 owns immutable message publications, explicit workspace snapshots
and returned media versions. F311 original records remain read-only. F309 keeps the canonical discussion for
the exact object/version and the explicit modification request journal; a Task round references that ledger
instead of creating another writable copy. Old inline rounds retain their original identity and read adapter.
Original-file comments are version-bound historical references, not marks transplanted onto a new canvas.

An ordinary-file text request may retain an immutable execution source and isolated patch candidates. These
are review artifacts with source SHA/provenance, not a second canonical mutable document or F290 shared-Human
Markdown owner. Explicit human acceptance and rejection serialize in the same SQLite owner; actual writeback
still requires the original F063 human/path/token and file receipt. Rejection leaves the file and Task intact.

MessageStore owns the human request source; F310/TaskStore owns admission and closure; the existing return
outbox and Queue own delivery; TurnExecutionStore owns the real child state. The request journal records their
exact receipts with replayable operation keys, not a cross-owner transaction or another queue. Publication
authorization consumes immutable human-source bindings and current content/Task checks, never mutable Task
artifactRefs as a self-issued grant. Cancelling one request does not terminate a shared Task or execution.
Whole-entry/whole-execution actions retain a separately confirmed target and native owner acknowledgement;
those historical acknowledgements never replace current child truth or retarget a later execution.

The implementation and verification cut is tracked in the Phase U packet. These boundaries are not a claim
of browser acceptance, real model completion, Alpha availability or production activation.

Cat-authored workspace `ContextAttachment`s use the existing Hub action/message transport, but the attachment
format version is never a file revision or write grant. F063 supplies and revalidates the exact owner revision;
F309 may resolve its rendered quote into raw anchors only while that same revision remains current. A Cat-side
takeover supplies only the authenticated Human source message and an idempotency attempt: MessageStore remains
the source owner, F309 derives the addressed Cat/thread/intent/selections, and the existing F310 Task continues
when exactly one compatible open responsibility exists. Recall, revocation, ambiguity and unsupported file
types fail before request or Task creation.

Candidate and disposition events remain canonical in the F309 journal and F063 writeback receipt. Their chat
representation is one immutable Host-authored, content-free message that points back to the original Human
source; it is neither Human/Cat speech nor another authorization. Ordinary candidate/applied/rejected receipts
do not start acknowledgement work. Conflict/unknown may use the existing Queue delivery owner only after the
exact Task is still open and owned by the original target Cat; that carrier never retries writeback.

A real applied text writeback can separately register `text_writeback_completion` in the existing durable
review-return outbox. It carries only the original request/Task, Human acceptance and public F063 receipt refs;
the applied display receipt remains non-executable. Initial acceptance and natural recovery converge on the
same return key. Registration and delivery revalidate the canonical file/admission binding, current open Task
and owner/thread/audience. A same-file continuation B can retain admitted request A's exact closure signal;
another file cannot satisfy it. This return does not retry F063, replay a Human or close a Task. The original
owner reads canonical acceptance/writeback evidence and the current Task revision before any typed closure.

## Use This When

- Adding a durable comment or Agent patch tied to a precise content selection.
- Adding text/node, spatial, temporal, canvas-element or table-range anchors.
- Resolving an anchor after content edits, refresh or version drift.
- Projecting a completed human edit transaction as a versioned, permission-scoped change notice and
  revalidating affected anchors or pending patches.
- Validating a content projection or mutation against owner policy revision/revocation epoch without copying
  that policy into the collaboration plane.
- Recovering duplicate, delayed, missing or concurrent owner receipts across replay/restart.
- Designing accept/reject/conflict/undo around a base content version and owner mutation receipt.
- Integrating an editor whose internal cursor/comment id must not become the cross-product canonical anchor.

## Extend By

- Add engine-specific mapping and patch payloads behind a content-owner adapter; do not add project names to
  the public anchor union.
- Preserve `contentRef`, base/current versions, resolution evidence, anchor revision and provenance.
- Request an action-specific owner authorization decision at every protected read/projection and mutation;
  persist only decision refs/digests and fail closed on expiry, revocation or unverifiable issuer.
- Let the adapter define semantic transaction boundaries for IME, paste, autosave and media gestures; publish
  one authenticated, idempotent, causally comparable version receipt per owner transaction rather than raw
  keystrokes. Persist checkpoint/outbox atomically and replay gaps before definitive notices.
- Mark pending patches `valid`, `rebase_required`, `conflicted` or `invalidated` when a human edit changes their
  base version; never reuse an old preview silently.
- CAS immutable dispositions against proposal revision/state before owner apply; bind apply/undo to exact
  receipts and expected versions so double settlement or drift cannot overwrite later human edits.
- Require stable source/space/timebase/table identity, units, transform/bounds policy and half-open ranges;
  ordinal/offset/pixel/time values alone are hints and missing evidence fails closed.
- Fail closed as `ambiguous` or `orphaned`; never silently select a low-confidence fallback candidate.
- Let the content owner validate/apply/invert and return exact new-version receipts before settling a patch.
- Keep annotation/patch/disposition records durable by default; deletion/retention is explicit user policy.
- For a shared Markdown consumer, reuse the same `contentRef`, owner authorization decision, version-bound
  proposal, disposition CAS and owner receipt. F290 contributes current domain context/Artifact lineage only;
  revoke or expiry invalidates subsequent reads, projections and mutations without deleting allowed audit evidence.

## Do NOT Unify With

- Do not merge this cell into `hub-action-surface`: F307/F223 own how a surface appears and is arranged, not
  where a comment points or whether a patch safely applied.
- Do not merge it into F290: Collective Artifact lineage and permission remain domain context, not the generic
  content collaboration protocol.
- Do not move canonical content/version or editor-native real-time collaboration into F309.
- Do not put raw keystrokes, cursor firehoses, Agent wake/admission or invocation routing in this cell.
- Do not create a second ACL/RBAC truth, treat F290 domain context as an allow, or serve content from an expired
  authorization decision/cache after revocation.
- Do not assume receipts are exactly-once or versions are numerically sortable; gaps/unknown causality make the
  stream stale until owner replay/snapshot and full resolve succeed.
- Do not use content base-version CAS as a substitute for proposal-state CAS, or mark undo complete without the
  exact owner receipt/proof.
- Do not invent a universal diff IR. The public plane owns proposal lifecycle and receipts; adapter payloads
  stay typed by their content owner.
- Do not claim image bbox, video time range, Office round-trip or stable SDK support from README adjacency.
- Do not use F063's owner-local Markdown edit token, F232's read projection, or a browser localStorage fixture as
  proof that two authenticated Humans share one canonical Markdown owner. Do not place a second Markdown copy in
  F290 Collective Service.

## DOCX Implementation Boundary

The first implemented vertical is the owner-backed DOCX journey. Human bridge saves and independent,
callback-authenticated named-cat tracked changes/comments converge on F138's content owner CAS. F309 sessions
bind the owner-authorized actor/content/provider/package/grant/runtime lease, revalidate before settlement,
and never accept an actor or human bearer from a cat tool body. The two MCP entries consume canonical callback
auth and return bounded, explicitly untrusted document anchors or exact owner receipts.

The immutable semantic-intent store contains only an operation fingerprint and a stable timestamp with TTL=0.
Replay retrieves F138's original receipt; no second candidate/document/version/receipt store is introduced.
The GenOffice engine owns OOXML anchors and edits inside F202's independently contained materializer. F309
neither executes arbitrary package code nor borrows a human editor page. F307 detach remains a surface concern;
authority loss preserves the local unsaved frame, and reopening the saved version requires explicit discard.

These concrete DOCX anchors do not claim the remaining cross-media coordinate, annotation-disposition, undo,
change-awareness or two-media acceptance work is complete. Those broader contracts still require their
matching owner adapters, verification and operator disposition.

## Shared Markdown Consumer Boundary

F290 W4 is a consumer slice of this existing contract, not a new owner or collaboration concept. Its delivery
sequence is:

1. F290 resolves two authenticated Human principals and supplies fresh Collective/Channel/Artifact context.
2. The Markdown content owner authorizes and returns canonical `text/markdown` bytes plus its current opaque
   owner version for one `contentRef`.
3. F309 resolves text-range anchors and records annotation plus a version-bound patch proposal; it does not copy
   the Markdown body into its ledger.
4. An authorized Human disposition wins proposal-state/revision CAS, then the owner applies against the expected
   owner version and emits the only valid new-version receipt.
5. F307 mounts `contentRef + sessionRef`; F290 associates the returned version with the original Artifact lineage.
6. Revocation or expiry invalidates existing sessions and every later read/projection/mutation. Cached content is
   not served; only owner-permitted content-free audit evidence remains.

Acceptance requires two distinct Human identities, restart readback, and a real revoke replay. A successful
single-owner DOCX session, local worktree Markdown CAS, read-only projection, or fixture cannot satisfy it.

## Editing Desk Phase A Consumer

Architecture cell: collaborative-content-plane, plugin
Map delta: extend existing cells — F138 project scope/document facade and F309 project-source/anchor branches; no new content or ledger owner.
Why: preserve one editable project head and its shared durable review history, while renderer mappings stay outside Host.

F326 consumes the existing F138 content owner through `VideoProjectService`: one immutable project scope,
canonical JSON, owner revisions/CAS and the original operation receipts. Project listing derives from primary
owner manifests. Asset versions index registered F063 roots with byte digests; a changed or missing source
never becomes the old version. Indexing does not copy or back up media. Check pages/results and decisions
remain in the same versioned JSON, with old definitions/results/answers readable after restart.

Project review is a new source branch in the same `ArtifactReviewStore.ledgers` database, not another store.
The original anchor is retained while locating, addressing, replying, resolving and reopening append history.
Project/segment/moment/artwork targets bind exact owner versions; unproven image/time transforms become
orphaned rather than being transplanted. F138 result receipts are checked before the separate F309 transaction.

The project service accepts trusted Host principals; a Cat also needs the explicitly injected invocation/
delegation authorizer. Runtime composition defaults to denial for that Cat port. The existing Human-only
file/media routes retain their checks. Phase A defines callable domain ports and tests; it adds no project
HTTP/MCP entry, editing surface, rendering execution or production activation. Renderer-specific mappings
remain in the external `remotion-studio` adapter, with only generic frozen JSON fixtures in this repository.
