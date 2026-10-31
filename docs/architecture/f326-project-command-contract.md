---
title: F326 Phase B project command boundary
status: active
owner: codex61-sol
created: 2026-10-10
updated: 2026-10-10
feature_ids: [F326, F309, F138]
doc_kind: contract
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/architecture/f326-project-command-contract.md"
mcp_admission_claims:
  - ref: "file:docs/architecture/f326-project-command-contract.md"
    toolName: cat_cafe_video_project_command
    resourceFamily: collaborative-content
    boundaryKind: resource-entry
    decision: accepted
---

# Project command boundary

This command implements the accepted Phase B plan §§4–5 (internal) in the existing collaborative-content resource family. The plan was independently approved at `8cc68fba933debcce3e2e984dd975c5a9dac9ca6` and merged by #5341. This admission does not grant an identity, project or Task permission.

`cat_cafe_video_project_command` takes an exact request ID from the existing `cat_cafe_take_over_content_modification` result and one named command. Human screening marks enter the existing F309 ledger without creating a Task. Only an explicit invocation-authenticated Cat takeover admits the modification Task against the actual delivered Human Message. The same F309 journal retains frozen project input, media version, selected opinion IDs, Task and canonical acknowledgement receipt; no second queue, message or project store is created.

Every command rechecks the running child, original Message source revision, mentions and frozen/current audience, current source rights, project access, the open same-owner Task, and the committed canonical journal/ledger binding. Mere position, role, draft, annotation or trigger is insufficient. Recalled, edited, cancelled, closed, foreign or unavailable sources cannot authorize a new command. Several causal messages are examined so an earlier read-only mark cannot hide a later accepted same-project source.

| Command | Effect |
| --- | --- |
| `read` | Read the exact retained or current F138 input; return snapshot-fenced JSON-text pages. |
| `review-read` | Read the same F309 ledger under source visibility; return independently fenced pages. |
| `save` | Inline full JSON document, exact expected owner revision and operation ID; persist through F138 CAS and return the actual Cat receipt. |
| `review-act` | Exact ledger CAS and one annotation from this request; use the existing located/replied/addressed/resolved/reopened contract and material proof. |
| `self-review` | Append the authenticated Cat's input/segment/source attestation; no Human decision or rendering-change proof. |

Read consumers concatenate every page before JSON parsing. A later page requires the previous snapshot; changing facts reject pagination. Each response is at most 12,000 serialized characters. A snapshot or request above 16 MiB is refused with an explicit size error, not truncated. Saves accept JSON objects, never arbitrary local paths. Complete project opinions retain their 8,000-character body/instructions; the existing 4,000-character Task outcome references the canonical selected opinions and exact source Message instead of duplicating or truncating them. Legacy text/media instruction limits remain unchanged.

The entry uses the existing callback principal and token validation and is exposed only in the full invocation profile. It cannot register media, create projects, decide Human options, bypass immutable source access, render a film, write workspace files, or accept unrelated opinions. Legacy text/media/Office consumers explicitly reject project source and prepared variants.

Executable boundaries are exercised by `content-modification-project-takeover.test.ts`, `callback-video-project-command.test.ts`, `workspace-review-video-project-message-cat-grants.test.ts`, and `video-project-command-tool.test.js`: real MessageStore, F138 owner/F063 index, canonical SQLite, real Task lifecycle, InvocationRegistry HTTP authentication, atomic receipt binding, restart recovery, current-source withdrawal and complete bounded reads. Browser delivery and design acceptance remain the parent Phase B responsibility.

## Audience revision and receipt contract

A Cat's `review.revision` is a durable version of that actor's visible projection, not the canonical ledger's operation counter. `review-act.expectedRevision` must come from **the same Cat's `review-read`**. The current F138 input supplies the default projected source; original opinion anchors and frozen screening/input identities stay intact. Creation/activity times and retained source metadata come only from public project origin and visible opinions. Hidden actions cannot change the actor's revision, JSON-page snapshot or source/capability selection.

The derived audience digest/CAS index and receipt version mappings live in the existing F309 SQLite alongside the authoritative ledger. They store no second review payload and have no TTL. Canonical contention caused by invisible writes is retried after re-reading authority; visible changes still reject stale CAS. Scoped request fingerprints remain fixed across retries/replays. The operation and its scoped receipt mapping commit or roll back together. After awaited owner reads, current source permissions are checked again before disclosure or mutation.

Canonical receipts remain internal authority for the journal/Task binding. The caller's operation receipt retains its scoped version at commit; another permitted actor's first disclosure records that actor's then-current projection version and keeps it stable on later receipt reads. This public field is a consumer projection version, not a reconstruction of the canonical operation sequence. The original running Cat also gets a projected takeover response; internal Human resume and the immutable journal keep their original canonical fields. A hidden operation has no public receipt witness, and current source revocation removes receipt access.
