---
title: F309 Phase U media message intake contract
status: active
owner: codex61-sol
created: 2026-10-03
updated: 2026-10-16
feature: F309
description: "F309 Task412 媒体消息接手的冻结合同：真实 Human 单发送、多范围原子请求、原 Task 归属、稳定选区映射与持久 Host 回执。"
description_source: model
description_author: codex61-sol
description_updated_at: 2026-10-03T20:38:56Z
description_generated_by: gpt-6.1-sol@task412-contract-r1
description_generated_at: 2026-10-03T20:38:56Z
description_confirmed_by: codex61-sol
feature_ids: [F309]
related_features: [F063, F310]
topics: [media-message, modification-return, source-custody]
doc_kind: contract
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f309-media-message-contract.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/f309-media-message-contract.md"
    toolName: cat_cafe_take_over_content_modification
    resourceFamily: collaborative-content
    boundaryKind: resource-entry
    decision: accepted
---

# Media message intake

Task412 consumes the landed Task287/OQ4 message takeover boundary and the atomic media annotation contract from #5053. Its accepted scope is plan §9.6.1 (internal). Task414 in `[thread-id]` consumes this contract. K3/Task288 remains complete; media editing and Host layout remain with their existing owners.

## One Human send

The existing send-message `contextAttachments` array accepts a `MediaContextAttachment`:

```ts
{
  v: 1,
  id: "cover",
  kind: "media",
  title: "秋日封面",
  mediaType: "image/png", // image/jpeg, image/webp or video/mp4; checked against the owner
  source: { kind: "artifact-review", reviewId, round, expectedReviewRevision },
  taskContext: { kind: "media", taskId, expectedTaskRevision, reviewId, round, expectedReviewRevision },
  selections: [
    { id: "1", selection: { kind: "image-region", x: 10, y: 20, width: 40, height: 30 }, instruction: "移除这里的字" },
    { id: "2", selection: { kind: "image-point", x: 120, y: 70 }, instruction: "这里加星星" }
  ]
}
```

`source` is the existing exact-version F309 source union: inline artifact review, publication ledger, workspace-media or evolution-media. A linked media round uses its publication `source` plus its actual media `taskContext`; the historical inline adapter keeps `artifact-review`. Format `v` is independent of the source owner revision. Never substitute a URL, screenshot, text quote or guessed Task for these coordinates.

The original Human words live in ordinary message `content`, once. Ordinary uploaded images can coexist as display blocks. They carry no source authority. Each selection has a stable, unique id, one existing `ArtifactReviewAnchor`, and optional local instruction. Preserve the order and ids across a retry; do not renumber surviving selections after deletion. A set is limited to 12. The combined modification outcome (global words plus named instructions) keeps the existing 4,000-character limit; an oversized aggregate returns a typed input error before request reservation, without truncation. An empty set identifies the whole work; the server derives its exact full-media anchor. Without an explicit attachment selector, multiple media attachments in one takeover must identify the same source, media kind and Task context, and cannot mix whole-work and selected-work attachments. The approved Task414 gallery increment below permits a Human send to carry separate work sources; it does not flatten them into one takeover. Text/media source mixtures are rejected. The existing 12-attachment/48,000-character collection limits still apply.

Image coordinates use the original image’s EXIF-oriented display pixels, including mirrored orientations, with dimensions signed by its actual source owner. Video ranges retain the exact `streamId`, ticks and optional frame anchors already used by K3. Evolution anchors are transformed once by the existing canonical source-to-derived-media mapping.

## JPEG/WebP admission and display

Task414 extends the existing media MIME union to `image/jpeg` and `image/webp`, alongside PNG/MP4. The original F063 root/locator/revision or exact publication/owner/ledger remains the authority. A bounded decoder verifies actual format, one image page, full decode and EXIF orientation; corrupt, mismatched and animated content is refused. PNG retains its prior signature/orientation fence. The extension does not borrow an evolution identity or grant a new writeback path.

Original MIME, bytes, SHA, locator and publication identity are retained. Browsers disagree on WebP EXIF: existing authenticated media reads accept `display=oriented` for a disposable, bounded, auto-oriented PNG projection, served `private, no-store` after the original exact-owner authorization. This projection is display-only. Normal media reads and downloads remain byte exact in the original format; comparisons pair these original identities with their verified display pixels. JPEG uses the browser’s native EXIF display. Selections and candidate comparisons use the same display coordinate space.

A candidate keeps its real encoding and original owner lineage. Workspace adoption still requires an explicit Human decision, the original F063 edit-session token and base-SHA CAS. Published rounds use the original fresh review/ledger/task revisions and approve/request-changes decisions; they do not expose workspace file adoption. Revocation, drift, cancellation, late outcomes and immutable history retain their prior fences.

Actual evidence is in Task414 quality and continuity (internal): JPEG EXIF6 and WebP EXIF7, each with Workspace and exact publication sources across 1440/light and 390/dark, raw download MIME/SHA, numbered selections, same original ChatInput, real callback/Queue/candidate, fresh-browser compare/decision, history and Chat/Home/Works return. The native provider and Human issuer are explicit isolated test boundaries; no actual model edit or production Human mutation is claimed.

## Approved same-message gallery increment (Task414)

You's direct approval `[thread-id]#private-source-id`, the eight rules in *(internal reference removed)* and original Task414 r117 extend this original contract. Satisfied Task412 stays closed. The Human still sends one ordinary message and one body. Each work retains its own source/version, Task context and selections. Optional `gallery` metadata contains only the visible original message thread/id/revision, its item selector, zero-based position and group size; it grants no content or Task authority. The existing durable composer and collection serializer own these attachments; there is no gallery draft or annotation ledger.

The first group is one message, including its ordinary media attachments, gallery blocks and media files. Cross-message combinations are refused. Selections get stable numeric ids across the group's surviving places; each work's exact anchor and optional words stay in its own attachment. The producer preserves the twelve-place per-send limit, the existing per-work intent bounds and the twelve-attachment/48,000-character collection boundary. Legacy single-work callers remain supported.

A multi-source message without `attachmentId` is ambiguous and refused. A named media attachment alone enters the existing source-specific owner validation, request, Task, candidate and return path. An invalid/missing selector, text selector or mixed text/project authority does not become a guessed first work. Each selection rereads the original Human audience, recall/version, exact work version and current owner rights. Sibling works do not contribute their selections or instructions, and their original versions remain independent.

The existing request journal binds `{owner, Human message, selected attachment}`. Legacy no-selector requests retain their original key. Competing addressed cats and repeated attempts on the same selection reuse that request. Every successful takeover attempt UUID, including an alias that reuses an existing request, is durably bound inside that same journal record; changing message/attachment with that UUID is rejected before owner preparation. The transaction rechecks this binding for races. This does not create a batch Task or a second ledger. `record.progress.sourceAttachmentId` records the named selection when present.

## Authenticated takeover and progress

Use the existing `POST /api/callbacks/content-modification/take-over` with `{sourceMessageId, operationId, attachmentId?}` and real invocation/callback credentials. The optional `attachmentId` names exactly one canonical media attachment from that original message; it is never a path, URL, batch list or selection id. The authenticated cat and permitted thread determine the principal. The server re-reads the delivered Human message, mentions, whisper audience, exact source/version and every range; it checks the Human message revision again before reservation. A callback cannot supply a different body, target, Task or asset.

The frontend send idempotency key belongs to the Human send; the cat's takeover operation id belongs to its own operation. A repeated takeover of the same Human message and optional attachment selection reuses the one canonical request even with another operation id or authenticated mentioned cat. A racing request may still be saving/preparing; render its actual `stage` and issue rather than inventing execution.

The existing request view retains `record.progress.sourceMessageId`, `sourceKind: human_message`, the immutable source visibility, `requestId`, Task/review bindings, `stage`, delivery and execution evidence. The original Human message receives no synthetic request `extra` and is never replaced by a generated Human source. `POST /api/content-modifications/context` exposes authorized source requests; join to the actual Human `sourceMessageId`. `GET /api/content-modifications/:requestId`, original request cancel and the existing execution APIs retain their shapes.

Named media requests additionally return:

```ts
selectionAnnotations?: { selectionId: string; annotationId: string }[]
```

The server derives this mapping from the canonical request and original bound round. It contains only this request's annotations, in selection order, and excludes older annotations. Treat annotation ids as opaque; do not reproduce the hash or zip the whole round's annotations. The map is absent while unbound or for whole/single legacy-anchor requests. The cat must respond to all open annotations through the existing authenticated artifact-review response API, carrying the request id; missing one response is rejected.

Existing original media custody continues in its actual Task. An inline source resolves its exact review/Task. A publication resolves its exact retained review and ledger through the existing canonical directory, including message-owned publications with an original Task and no prior modification request. An ambiguous/mismatched retained review fails closed. If a Task-owned publication has no review yet, its authorized owner first prepares the review on that same Task and then retries takeover; the error never authorizes an alternate Task. A workspace/publication/evolution source without existing Task custody can admit one Task through the original Human authority. Pure discussion creates no Task. Cancellation persists before competing effects and preserves pre-existing Tasks; a late candidate for a cancelled request is rejected.

## Canonical candidates, decisions and Host receipts

The original artifact review and F138 asset/version/audit remain the truth. New media candidate commits and Human round decisions project live into the same durable `extra.systemKind: content_modification_receipt` / `extra.contentModificationReceiptV1` system record as text. A restart rebuilds missing records from canonical audit operations, bounded by the request's original binding revision and its successor; reopening does not erase a historical decision receipt. A new Human modification message on a candidate round creates request B and ends request A’s audit window: later B decisions must join to B’s request/source message, not A’s earlier candidate receipt.

Each Host record carries `requestId`, `sourceMessageId`, `targetCatId`, `taskId`, `state`, `candidateRef`, canonical `receiptRef`, `observedAt` and `followUp`. Media adds `approved` and `changes_requested` to the existing `candidate`, `rejected`, `applied`, `conflict`, `unknown` union. Candidate references are the actual owner receipt refs returned by the media candidate API. Host records retain the original owner `userId` and canonical `from: {kind: system, service: content-modification}`, with the projected `catId: null`, no connector source, no mentions or targetCats, `replyTo` the original Human message, and the original whisper audience. Source authority is checked when collecting media events and again at the actual append; recalled/revoked source cannot create a fresh receipt. Existing historical records remain idempotent.

Candidate/rejected/applied/approved/changes_requested use `followUp: {kind: none, reason: not_applicable}`; the existing media round return owns the cat's decision continuation. Workspace conflict/unknown can use the established producer return, but `cat_woken` requires a real started/already-processing delivery with its execution evidence. A queued, unavailable or conflicting follow-up is `unverified`. Rendering a Host record never grants a new modification or starts an acknowledgement invocation.

Requests/candidates leave original workspace bytes unchanged. Only explicit Human accept, a valid F063 edit-session token and the exact candidate/base revision can write. Reject, conflict, unknown and request cancellation keep their existing canonical journals. Recovery never auto-accepts a candidate or retries an unknown file effect. Task decisions apply only to the current original media round and do not close its Task automatically.

## Executable evidence

The real Human journey is in `content-modification-media-message*.test.ts`: true PNG two-place/whole input, true MP4 ranges, invocation-authenticated HTTP competition and response, stable joins with older annotations, source/version/private/recall checks, atomic failure and fresh service replay, cancellation, live/recovered/historical Host receipts, real candidate adoption/rejection and F063 CAS conflict/unknown. The existing text takeover, file-continuation, receipt and artifact-review suites verify compatibility. This backend contract is separate from Task414's complete frontend journey and the parent's Alpha acceptance.
