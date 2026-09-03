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
description_updated_at: 2026-08-28T05:29:14Z
doc_kind: architecture
created: 2026-08-27
canonical_features: [F309]
code_anchors: []
doc_anchors:
  - docs/features/F309-collaborative-content-plane.md
  - project-research/2026-08-27-f309-collaborative-content-plane/README.md
  - docs/features/F290-ai-native-collective.md
  - docs/features/F307-composable-workbench.md
  - docs/features/F063-hub-workspace-explorer.md
  - docs/features/F138-video-studio.md
static_scan_hints: [SelectionAnchor, AuthorizationDecisionRef, AnnotationThread, PatchProposal, Disposition, ContentChangeReceipt, receiptId, causal checkpoint, replay, PresenceProjection, change awareness, proposal state CAS, applyReceipt, coordinate space, timebase, table range, reanchor, orphaned, content adapter]
cited_by:
  - {feature: F309, date: 2026-08-27, delta: new cell — extract cross-media collaboration mechanics from F290 and keep F307/content-owner boundaries explicit}
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

## Phase A Boundary

This cell intentionally has no code anchors while F309 is in Research + Design Gate. Phase B remains closed
until typed coordinate invariants, owner-auth/revocation/redaction, receipt authentication/replay/order, patch
settlement/undo CAS, storage boundary, open-source integration posture and the two-media vertical slice pass
non-author review and operator disposition.
